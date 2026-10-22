/**
 * Restoring a workspace backup (lib/backup has the format, export.ts makes them) as a new workspace
 * on this server, with the ids it had: a workspace that is still here can't be restored next to
 * itself. Anyone who may create workspaces may restore one, and becomes one of its owners.
 *
 * A backup file can be edited, so nothing in it is trusted: every row must belong to the backed-up
 * workspace and point only at rows of the backup (or at the people its manifest names), its files
 * must be stored under that workspace, and the values of relation, person and files properties that
 * point elsewhere are dropped.
 *
 * People are matched by email: someone with a verified account here (as adding a member asks, see
 * workspaces.ts addMemberAs) keeps what they had under their own account, and whoever restores it
 * stands for the person of their address. Everyone else gets a user without an account here
 * (lib/reserved-emails), under their name, so what they wrote and were assigned stays theirs; the
 * result lists them, to invite. Agents come back with their own users.
 *
 * All rows go in one transaction, which stores the files first and removes them again when it fails.
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { pagePublication, formPublication, storageDeletion, user, workspace, workspaceSite } from "@/db/schema";
import { agentEmail } from "@/lib/agents";
import { decodeValue, entryKind, fileEntryPath, idRewriter, MANIFEST_PATH, parseManifest, rewriteDeep, BACKUP_VERSION, type BackupManifest, type RestoreResult } from "@/lib/backup";
import { rewriteDocument } from "@/lib/backup-ydoc";
import { normalizeEmail } from "@/lib/emails";
import { env } from "@/lib/env";
import { fileIdOf, isFileId } from "@/lib/files";
import { isReservedEmail, isRestoredEmail, restoredEmail } from "@/lib/reserved-emails";
import { readAiConfig } from "@/server/ai/config";
import { recordAudit } from "@/server/audit";
import { newHookSalt } from "@/server/automations/incoming";
import { newSecretSalt } from "@/server/automations/webhook";
import { newEventSecret } from "@/server/connections/manage";
import { seal } from "@/server/secret-box";
import { instanceStorage, uploadLimits } from "@/server/storage";
import { attachDefaultStorage } from "@/server/storage/accounts";
import { mayCreateWorkspace } from "@/server/workspaces";
import { BackupError, SCHEMA_TAGS } from "./export";

export type { RestoreResult };
import { BACKED_UP, backupTables, MEMBERSHIP_TABLES, NO_LONGER_BACKED_UP, WORKSPACE_MEMBERS, type BackupTable } from "./tables";
import { entryStream, readEntry, zipEntries, ZipFormatError, type ZipEntry } from "./zip-reader";

const MB = 1024 * 1024;
/** Largest manifest, and largest table entry (a page with a long history can be big). */
const MAX_MANIFEST_BYTES = 64 * MB;
const MAX_TABLE_ENTRY_BYTES = 512 * MB;

function positive(name: string, fallback: number) {
  const value = Number(process.env[name]?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Most bytes of rows one restore reads into memory: BACKUP_MAX_ROWS_MB, 2,048 by default. */
const maxRowBytes = () => positive("BACKUP_MAX_ROWS_MB", 2048) * MB;

type Row = Record<string, unknown>;
type Rows = Map<string, Row[]>;


/** Restores the backup in the ZIP at `archive` (a file on disk) for `actorId`. */
export async function restoreBackup(actorId: string, archive: string): Promise<RestoreResult> {
  if (!(await mayCreateWorkspace(actorId))) throw new BackupError("notAllowed");
  try {
    const entries = await zipEntries(archive);
    const byName = new Map<string, ZipEntry>();
    for (const entry of entries) {
      if (!entryKind(entry.name)) throw new BackupError("invalid", `unexpected entry ${entry.name}`);
      if (byName.has(entry.name)) throw new BackupError("invalid", `${entry.name} appears twice`);
      byName.set(entry.name, entry);
    }
    const manifestEntry = byName.get(MANIFEST_PATH);
    if (!manifestEntry) throw new BackupError("invalid", "no manifest");
    const manifest = parseManifest((await readEntry(archive, manifestEntry, MAX_MANIFEST_BYTES)).toString("utf8"));
    if (!manifest) throw new BackupError("invalid", "not a Leafdesk backup");
    if (manifest.version > BACKUP_VERSION || !SCHEMA_TAGS.includes(manifest.schema)) throw new BackupError("newer");

    const workspaceId = manifest.workspace.id;
    const [existing] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId));
    if (existing) throw new BackupError("alreadyHere");
    if (manifest.files.bytes > uploadLimits().workspaceQuotaBytes) throw new BackupError("quota");

    const rows = await readTables(archive, entries, manifest);
    validate(manifest, rows, byName);
    // The manifest's sum is only a hint; each file's size was checked against its entry.
    const bytes = rows.get("file")!.reduce((sum, row) => sum + Number(row.size), 0);
    if (bytes > uploadLimits().workspaceQuotaBytes) throw new BackupError("quota");
    const people = await matchPeople(actorId, manifest);
    applyPeople(actorId, workspaceId, rows, people);
    const notes = await fitThisServer(manifest, rows);
    await storeAndInsert(actorId, archive, manifest, rows, people, byName);
    // New uploads go to the restorer's default storage account, if they have one; the restored
    // files stay in the server's storage, where an owner can move them from.
    await attachDefaultStorage(actorId, workspaceId);

    return {
      workspaceId,
      name: manifest.workspace.name,
      pages: rows.get("page")?.length ?? 0,
      files: rows.get("file")?.length ?? 0,
      withoutAccount: people.withoutAccount,
      ...notes,
    };
  } catch (error) {
    if (error instanceof ZipFormatError) throw new BackupError("invalid", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the rows

async function readTables(archive: string, entries: ZipEntry[], manifest: BackupManifest): Promise<Rows> {
  const tables = new Map(backupTables().map((t) => [t.name, t]));
  const rows: Rows = new Map([...tables.keys()].map((name) => [name, []]));
  let total = 0;
  const parts = entries
    .map((entry) => ({ entry, kind: entryKind(entry.name) }))
    .filter((p): p is { entry: ZipEntry; kind: { kind: "table"; table: string } } => p.kind?.kind === "table")
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  for (const { entry, kind } of parts) {
    if (NO_LONGER_BACKED_UP.has(kind.table)) continue;
    const t = tables.get(kind.table);
    if (!t) throw new BackupError("invalid", `unknown table ${kind.table}`);
    total += entry.size;
    if (total > maxRowBytes()) throw new BackupError("tooLarge");
    const text = (await readEntry(archive, entry, MAX_TABLE_ENTRY_BYTES)).toString("utf8");
    const columns = new Map(t.columns.map((c) => [c.name, c]));
    const list = rows.get(t.name)!;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new BackupError("invalid", `${entry.name} has a line that isn't JSON`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BackupError("invalid", `${entry.name} has a line that isn't a row`);
      const row: Row = {};
      for (const [name, value] of Object.entries(parsed)) {
        const column = columns.get(name);
        if (!column) throw new BackupError("invalid", `${t.name} has no column ${name}`);
        try {
          row[name] = decodeValue(column.kind, value);
        } catch {
          throw new BackupError("invalid", `${t.name}.${name} holds a value of the wrong kind`);
        }
      }
      for (const column of t.columns) {
        if (!(column.name in row) && column.notNull && !column.hasDefault) throw new BackupError("invalid", `${t.name} rows lack ${column.name}`);
      }
      list.push(row);
    }
  }
  for (const { name, rows: count } of manifest.tables) {
    if (NO_LONGER_BACKED_UP.has(name)) continue;
    if (!(name in BACKED_UP)) throw new BackupError("invalid", `unknown table ${name}`);
    if ((rows.get(name)?.length ?? 0) !== count) throw new BackupError("invalid", `${name} doesn't hold the rows the manifest says`);
  }
  // Older backups held people's notes too; only agents' come back (see tables.ts).
  const agents = new Set(rows.get("workspace_agent")!.map((a) => a.user_id));
  rows.set("ai_memory", rows.get("ai_memory")!.filter((note) => agents.has(note.user_id)));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Checking them

const tupleOf = (row: Row, columns: string[]) => columns.map((c) => row[c]);
const keyOf = (values: unknown[]) => JSON.stringify(values);

function validate(manifest: BackupManifest, rows: Rows, files: Map<string, ZipEntry>) {
  const workspaceId = manifest.workspace.id;
  const tables = backupTables();
  const workspaces = rows.get("workspace")!;
  if (workspaces.length !== 1 || workspaces[0].id !== workspaceId) throw new BackupError("invalid", "the backup doesn't hold its workspace");

  const people = new Set<string>();
  for (const person of manifest.people) {
    if (people.has(person.id)) throw new BackupError("invalid", "a person appears twice");
    people.add(person.id);
  }

  for (const t of tables) {
    const list = rows.get(t.name)!;
    if (t.columns.some((c) => c.name === "workspace_id")) {
      for (const row of list) if (row.workspace_id !== workspaceId) throw new BackupError("invalid", `${t.name} holds rows of another workspace`);
    }
    const seen = new Set<string>();
    for (const row of list) {
      const key = keyOf(tupleOf(row, t.primaryKey));
      if (seen.has(key)) throw new BackupError("invalid", `${t.name} holds a row twice`);
      seen.add(key);
    }
  }

  // Every foreign key points inside the backup, or at its people.
  const indexes = new Map<string, Set<string>>();
  const index = (table: string, columns: string[]) => {
    const name = `${table}(${columns.join(",")})`;
    let set = indexes.get(name);
    if (!set) {
      set = new Set((rows.get(table) ?? []).map((row) => keyOf(tupleOf(row, columns))));
      indexes.set(name, set);
    }
    return set;
  };
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const backedUp = rows.has(fk.table);
      for (const row of rows.get(t.name)!) {
        const values = tupleOf(row, fk.columns);
        if (values.some((v) => v === null || v === undefined)) continue;
        if (fk.table === "user") {
          if (!people.has(values[0] as string)) throw new BackupError("invalid", `${t.name}.${fk.columns[0]} names someone the manifest doesn't`);
        } else if (backedUp) {
          if (!index(fk.table, fk.foreignColumns).has(keyOf(values))) {
            throw new BackupError("invalid", `${t.name}.${fk.columns.join("+")} points outside the backup`);
          }
        } else {
          // A table backups leave out (an agent run): the link is dropped, where it may be.
          const columns = fk.columns.map((name) => t.columns.find((c) => c.name === name)!);
          if (columns.some((c) => c.notNull)) throw new BackupError("invalid", `${t.name} points at ${fk.table}, which backups leave out`);
          for (const name of fk.columns) row[name] = null;
        }
      }
    }
  }

  // Files are stored under the workspace, and each has its bytes in the archive. They go to the
  // instance's storage: a workspace's own storage isn't in backups (it is connected again).
  const fileIds = new Set<string>();
  for (const row of rows.get("file")!) {
    const id = row.id as string;
    row.storage_id = null;
    row.storage_object_id = null;
    if (!isFileId(id) || row.storage_key !== `${workspaceId}/${id}`) throw new BackupError("invalid", "a file is stored outside its workspace");
    const entry = files.get(fileEntryPath(id));
    if (!entry || entry.size !== Number(row.size)) throw new BackupError("invalid", `file ${id} is missing or damaged`);
    fileIds.add(id);
  }
  for (const name of files.keys()) {
    const kind = entryKind(name);
    if (kind?.kind === "file" && !fileIds.has(kind.id)) throw new BackupError("invalid", `${name} belongs to no file`);
  }

  // Agents' users are the agents' own, with their agent's address.
  const agentOf = new Map(rows.get("workspace_agent")!.map((a) => [a.user_id as string, a.id as string]));
  for (const person of manifest.people) {
    const agentId = agentOf.get(person.id);
    if (person.agent !== Boolean(agentId) || (agentId && normalizeEmail(person.email) !== agentEmail(agentId))) {
      throw new BackupError("invalid", "the backup's agents and their users don't match");
    }
  }

  // Pages: parents before children, no circles; property values point inside the backup.
  const pages = rows.get("page")!;
  const pageIds = new Set(pages.map((p) => p.id as string));
  rows.set("page", parentsFirst(pages));
  const types = new Map(rows.get("database_property")!.map((p) => [p.id as string, p.type as string]));
  for (const p of pages) {
    const properties = p.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    const clean: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(properties as Record<string, unknown>)) {
      const type = types.get(id);
      if (type === "relation" && Array.isArray(value)) clean[id] = value.filter((v) => typeof v === "string" && pageIds.has(v));
      else if (type === "person" && Array.isArray(value)) clean[id] = value.filter((v) => typeof v === "string" && people.has(v));
      else if (type === "files" && Array.isArray(value)) {
        clean[id] = value.filter((v) => {
          const url = v && typeof v === "object" ? (v as { url?: unknown }).url : undefined;
          const fileId = typeof url === "string" ? fileIdOf(url) : null;
          return fileId === null || fileIds.has(fileId);
        });
      } else clean[id] = value;
    }
    p.properties = clean;
  }
}

/** Pages ordered so each comes after its parent; throws on a circle. */
function parentsFirst(pages: Row[]): Row[] {
  const children = new Map<string | null, Row[]>();
  for (const p of pages) {
    const parent = (p.parent_id as string | null) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  const ordered: Row[] = [];
  const queue = [...(children.get(null) ?? [])];
  while (queue.length) {
    const p = queue.shift()!;
    ordered.push(p);
    queue.push(...(children.get(p.id as string) ?? []));
  }
  if (ordered.length !== pages.length) throw new BackupError("invalid", "pages are their own ancestors");
  return ordered;
}

// ---------------------------------------------------------------------------------------------
// People

type People = {
  /** Backup id → id here, for everyone the backup names. */
  map: Map<string, string>;
  /** Users to create: agents' and people without an account here. */
  create: { id: string; name: string; email: string }[];
  /** Ids here of people without an account, who don't become members. */
  withoutAccountIds: Set<string>;
  withoutAccount: RestoreResult["withoutAccount"];
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** A user id like Better Auth's: 32 random letters and digits. */
function newUserId() {
  return [...randomBytes(32)].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

async function matchPeople(actorId: string, manifest: BackupManifest): Promise<People> {
  const [actor] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, actorId));
  const emails = [...new Set(manifest.people.filter((p) => !p.agent).map((p) => normalizeEmail(p.email)))];
  const byEmail = new Map(
    (emails.length
      ? await db
          .select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
          .from(user)
          .where(inArray(sql`lower(${user.email})`, emails))
      : []
    ).map((u) => [normalizeEmail(u.email), u]),
  );
  const ids = manifest.people.map((p) => p.id);
  const byId = new Map(
    (ids.length ? await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, ids)) : []).map((u) => [u.id, u]),
  );

  const people: People = { map: new Map(), create: [], withoutAccountIds: new Set(), withoutAccount: [] };
  const taken = new Set<string>();
  for (const p of manifest.people) {
    if (p.agent) {
      const here = byId.get(p.id);
      if (here && normalizeEmail(here.email) !== normalizeEmail(p.email)) throw new BackupError("conflict", "an agent's user is someone else here");
      if (!here) people.create.push({ id: p.id, name: p.name, email: normalizeEmail(p.email) });
      people.map.set(p.id, p.id);
      taken.add(p.id);
      continue;
    }
    const email = normalizeEmail(p.email);
    let target: string | null = null;
    if (actor && email === normalizeEmail(actor.email)) target = actor.id;
    else {
      const account = byEmail.get(email);
      if (account?.emailVerified && !isReservedEmail(account.email)) target = account.id;
    }
    // The same person on the server the backup came from (a workspace restored after deleting it).
    if (!target && byId.get(p.id) && normalizeEmail(byId.get(p.id)!.email) === email) target = p.id;
    // Someone without an account whom an earlier restore of this workspace brought here.
    const placeholder = byId.get(p.id);
    if (!target && placeholder && normalizeEmail(placeholder.email) === restoredEmail(p.id) && !taken.has(p.id)) {
      people.map.set(p.id, p.id);
      people.withoutAccountIds.add(p.id);
      taken.add(p.id);
      if (!isRestoredEmail(p.email)) people.withoutAccount.push({ name: p.name, email: p.email });
      continue;
    }
    if (target && !taken.has(target)) {
      people.map.set(p.id, target);
      taken.add(target);
      continue;
    }
    const id = byId.has(p.id) || taken.has(p.id) ? newUserId() : p.id;
    people.create.push({ id, name: p.name || email, email: restoredEmail(id) });
    people.map.set(p.id, id);
    people.withoutAccountIds.add(id);
    taken.add(id);
    if (!isRestoredEmail(p.email)) people.withoutAccount.push({ name: p.name, email: p.email });
  }
  return people;
}


function applyPeople(actorId: string, workspaceId: string, rows: Rows, people: People) {
  // People without an account here are left out of what they were members of.
  for (const name of MEMBERSHIP_TABLES) {
    rows.set(
      name,
      rows.get(name)!.filter((row) => !people.withoutAccountIds.has(people.map.get(row.user_id as string) ?? "")),
    );
  }
  const rewrite = idRewriter(people.map);
  if (rewrite) {
    for (const t of backupTables()) {
      for (const row of rows.get(t.name)!) {
        for (const column of t.columns) {
          const value = row[column.name];
          if (value === null || value === undefined) continue;
          if (column.kind === "bytes") row[column.name] = rewriteDocument(value as Uint8Array, rewrite) ?? value;
          else if (column.kind === "other") row[column.name] = rewriteDeep(value, rewrite);
        }
      }
    }
  }
  // Whoever restores it owns it.
  const members = rows.get(WORKSPACE_MEMBERS)!;
  const mine = members.find((m) => m.user_id === actorId);
  if (mine) mine.role = "owner";
  else members.push({ workspace_id: workspaceId, user_id: actorId, role: "owner" });
}

// ---------------------------------------------------------------------------------------------
// What belonged to the old server

const newToken = () => randomBytes(32).toString("base64url");

async function fitThisServer(manifest: BackupManifest, rows: Rows) {
  const [ws] = rows.get("workspace")!;
  ws.invite_link_token = null;
  // An own AI account is someone's on the old server (and its key never leaves it).
  ws.ai_account_id = null;
  let ssoOnlyTurnedOff = false;
  if (ws.settings && typeof ws.settings === "object") {
    // Domains are proven by DNS for a server's own workspaces; the proof doesn't travel.
    const settings: Record<string, unknown> = { ...(ws.settings as object), allowedDomainsVerified: [] };
    // Nor does single sign-on (tables.ts), which "SSO only" would wait for and then apply at once:
    // it falls back to any method, as when a connection is removed (sso.ts), unless the instance
    // provider signs members in here.
    if (settings.loginMethod === "sso" && !env.instanceOidc) {
      settings.loginMethod = "any";
      ssoOnlyTurnedOff = true;
    }
    ws.settings = settings;
  }

  let siteLeftOut = false;
  const sites = rows.get("workspace_site")!;
  if (sites.length) {
    const taken = await db.select({ slug: workspaceSite.slug }).from(workspaceSite).where(inArray(workspaceSite.slug, sites.map((s) => s.slug as string)));
    if (taken.length) {
      rows.set("workspace_site", []);
      siteLeftOut = true;
    }
  }

  // Publication links keep their tokens, unless one is taken here.
  for (const [name, table] of [
    ["page_publication", pagePublication],
    ["form_publication", formPublication],
  ] as const) {
    const list = rows.get(name)!;
    if (!list.length) continue;
    const taken = new Set(
      (await db.select({ token: table.token }).from(table).where(inArray(table.token, list.map((r) => r.token as string)))).map((r) => r.token),
    );
    for (const row of list) if (taken.has(row.token as string)) row.token = newToken();
  }

  // A restored automation signs with a new secret and takes requests at a new address.
  for (const automation of rows.get("database_automation")!) {
    automation.secret_salt = newSecretSalt();
    automation.hook_salt = newHookSalt();
  }
  const connections = rows.get("connection")!;
  for (const connection of connections) {
    connection.secrets = null;
    connection.status = "needsAuth";
    connection.event_secret = seal(newEventSecret());
  }

  // A restored workspace has no AI account of its own yet (see below): the server's model, if workspaces may use it.
  const here = env.aiOnlyOwnKeys ? null : readAiConfig().embeddings;
  const there = manifest.embeddings;
  const sameModel = Boolean(here && there && here.model === there.model && (here.dimensions ?? null) === there.dimensions);
  const searchIndexDropped = !sameModel && rows.get("page_chunk")!.length > 0;
  if (!sameModel) {
    rows.set("page_chunk", []);
    rows.set("page_index_state", []);
  }
  return { siteLeftOut, connectionsToReconnect: connections.length, searchIndexDropped, ssoOnlyTurnedOff };
}

// ---------------------------------------------------------------------------------------------
// Writing it

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505";

async function storeAndInsert(actorId: string, archive: string, manifest: BackupManifest, rows: Rows, people: People, files: Map<string, ZipEntry>) {
  const storage = instanceStorage();
  const stored: string[] = [];
  try {
    await db.transaction(async (tx) => {
      // One restore of a workspace at a time, across servers: a second one waits here, then finds
      // the workspace in. Without this, the one that fails would remove the files the other stored.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`backup-restore:${manifest.workspace.id}`}, 0))`);
      const [existing] = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, manifest.workspace.id));
      if (existing) throw new BackupError("alreadyHere");
      for (const row of rows.get("file")!) {
        const key = row.storage_key as string;
        const entry = files.get(fileEntryPath(row.id as string))!;
        await storage.put(key, await entryStream(archive, entry), { size: entry.size, contentType: row.content_type as string });
        stored.push(key);
      }
      if (people.create.length) await tx.insert(user).values(people.create.map((p) => ({ ...p, emailVerified: false })));
      for (const t of backupTables()) {
        const list = rows.get(t.name)!;
        if (!list.length) continue;
        if (t.name === "page") {
          // Templates are pages too: the default one is set once every page is in.
          await insertRows(tx, t, list.map((p) => ({ ...p, default_template_id: null })));
          for (const p of list.filter((p) => p.default_template_id)) {
            await tx.execute(sql`update page set default_template_id = ${p.default_template_id as string} where id = ${p.id as string}`);
          }
        } else {
          await insertRows(tx, t, list);
        }
        // The workspace's own "General" teamspace comes with the backup; drop the one made for it.
        if (t.name === "workspace") await tx.execute(sql`delete from teamspace where workspace_id = ${manifest.workspace.id}`);
      }
      // A top-level page outside any teamspace is put in the default one when it's made (a deferred
      // trigger, page_home_teamspace); one restored that way stays where it was.
      await tx.execute(sql`set constraints page_home_teamspace immediate`);
      const outside = rows.get("page")!.filter((p) => p.parent_id == null && p.teamspace_id == null).map((p) => p.id as string);
      for (let i = 0; i < outside.length; i += 1000) {
        // In SQL: the schema's update would also stamp updated_at.
        await tx.execute(
          sql`update page set teamspace_id = null where teamspace_id is not null and id in (${sql.join(outside.slice(i, i + 1000).map((id) => sql`${id}`), sql`, `)})`,
        );
      }
      // Objects the old server meant to delete (a workspace restored after deleting it) stay; those
      // in a workspace's own storage are other objects, and still go.
      for (let i = 0; i < stored.length; i += 1000) {
        await tx
          .delete(storageDeletion)
          .where(and(inArray(storageDeletion.storageKey, stored.slice(i, i + 1000)), isNull(storageDeletion.storageId)));
      }
      await recordAudit(
        {
          workspaceId: manifest.workspace.id,
          actorId,
          action: "backup.restored",
          target: { type: "workspace", id: manifest.workspace.id },
          details: { pages: rows.get("page")!.length, files: stored.length, schema: manifest.schema, app: manifest.app },
        },
        tx,
      );
    });
  } catch (error) {
    await Promise.all(stored.map((key) => storage.delete(key).catch(() => {})));
    if (isUniqueViolation(error)) throw new BackupError("conflict", "some of the backup's rows are on this server already");
    throw error;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertRows(tx: Tx, t: BackupTable, list: Row[]) {
  // Postgres takes at most 65,535 parameters per statement.
  const size = Math.max(1, Math.floor(30_000 / t.columns.length));
  for (let i = 0; i < list.length; i += size) {
    const values = list.slice(i, i + size).map((row) => Object.fromEntries(t.columns.filter((c) => c.name in row).map((c) => [c.key, row[c.name]])));
    await tx.insert(t.table).values(values);
  }
}
