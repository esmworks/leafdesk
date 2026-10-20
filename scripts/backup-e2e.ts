/**
 * End-to-end check of workspace backups (server/backup): a workspace with members, a teamspace, a
 * group, pages with mentions and comments in their documents, a history version, a database with
 * person, files and relation values, a view, an uploaded file, a published page, a favorite, a
 * page permission, an agent with a note in its memory and "SSO only" (through the server's own
 * provider) is backed up, without Alice's AI chat and the note the chat kept about her, and
 *
 * - restored on another Leafdesk (a second database and upload folder, in a child process of this
 *   script) through the restore route, by someone with the owner's address but another id there,
 *   next to a member whose account there has another id too and a member with no account there.
 *   Every backed-up table is compared row by row with the original, people's ids mapped, the
 *   documents decoded, and the files byte for byte. That Leafdesk has no single sign-on provider of
 *   its own, so "SSO only" falls back to any method;
 * - refused when it was edited to reach outside itself, and next to itself;
 * - restored on the same server after the workspace was deleted, with every row as it was ("SSO
 *   only" too, the server's provider being there), no new users, and the files the deletion queued
 *   for removal kept, from a backup made as older versions did (with Alice's chat and note, which
 *   stay out); a single sign-on connection it sets up then forgets the sign-ins left on
 *   record under its provider id.
 *
 *   pnpm tsx scripts/backup-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present; migrations applied),
 * PEER_DATABASE_URL (default: DATABASE_URL's database with a `_peer` suffix; it must exist, the
 * script migrates it). Creates its own users and workspaces and deletes them afterwards.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { spawn } = await import("node:child_process");
const { createHash } = await import("node:crypto");
const { createReadStream, createWriteStream } = await import("node:fs");
const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");
const { pipeline } = await import("node:stream/promises");

const PEER = process.argv[2] === "--peer";
const work = PEER ? process.argv[3] : await mkdtemp(join(tmpdir(), "leafdesk-backup-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = join(work, PEER ? "peer-uploads" : "uploads");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, like, sql } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { account, aiConversation, aiMemory, apiToken, auditEvent, file, page, pageSnapshot, session, storageDeletion, user, workspace } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { encodeValue, idRewriter, rewriteDeep } = await import("@/lib/backup");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { env } = await import("@/lib/env");
const { EMPTY_MENTION } = await import("@/lib/mentions");
const { restoredEmail } = await import("@/lib/reserved-emails");
const { registerCollab } = await import("@/server/collab/bridge");
const { instanceStorage } = await import("@/server/storage");
const { backupTables } = await import("@/server/backup/tables");
type Row = Record<string, unknown>;
type Dump = Record<string, Row[]>;

const { createCollab } = await import("@/server/collab/service");
registerCollab(createCollab().service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function storedBytes(key: string) {
  const body = await instanceStorage().get(key);
  if (!body) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.fromWeb(body as import("node:stream/web").ReadableStream)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A page document as plain data: every part, with text as deltas (so embeds and marks show). */
function documentJson(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const node = (n: unknown): unknown => {
    if (n instanceof Y.XmlText) return { text: n.toDelta() };
    if (n instanceof Y.XmlElement) return { name: n.nodeName, attributes: n.getAttributes(), children: n.toArray().map(node) };
    if (n instanceof Y.XmlFragment) return n.toArray().map(node);
    return n;
  };
  const parts: Record<string, unknown> = {};
  for (const name of [...doc.share.keys()].sort()) {
    if (name === COLLAB_FRAGMENT || name.startsWith("synced:")) parts[name] = node(doc.getXmlFragment(name));
    else if (name === "title") parts[name] = doc.getText(name).toDelta();
    else parts[name] = doc.getMap(name).toJSON();
  }
  return parts;
}

/** Every backed-up row of the workspace, by table, keyed by column name, in key order. */
async function dumpWorkspace(workspaceId: string): Promise<Dump> {
  const out: Dump = {};
  for (const t of backupTables()) {
    const rows = (await db.select().from(t.table).where(t.scope(workspaceId))) as Row[];
    out[t.name] = rows
      .map((row) =>
        Object.fromEntries(
          t.columns.map((c) => [c.name, c.kind === "bytes" && row[c.key] ? documentJson(row[c.key] as Uint8Array) : encodeValue(c.kind, row[c.key])]),
        ),
      )
      .sort((a, b) => (JSON.stringify(t.primaryKey.map((k) => a[k])) < JSON.stringify(t.primaryKey.map((k) => b[k])) ? -1 : 1));
  }
  return out;
}

/** Runs `f` on a server with its own single sign-on provider (env.instanceOidc reads these anew). */
async function withInstanceProvider<T>(f: () => Promise<T>): Promise<T> {
  const provider = { OIDC_ISSUER: "https://idp.example.test/instance", OIDC_CLIENT_ID: "backup-e2e", OIDC_CLIENT_SECRET: "backup-e2e-secret" };
  const before = Object.keys(provider).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, provider);
  try {
    return await f();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function signedIn(userId: string) {
  const token = `${userId}-token`;
  await db.insert(session).values({ id: `${userId}-session`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
}

if (PEER) await peer();
else await main();

// ---------------------------------------------------------------------------------------------
// The other Leafdesk

/** Restores the backup through the route as someone with the owner's address, and reports. */
async function peer() {
  const input = JSON.parse(await readFile(join(work, "peer-input.json"), "utf8")) as {
    run: string;
    ownerEmail: string;
    aliceEmail: string;
    files: Record<string, string>;
  };
  const route = await import("@/app/api/backups/route");
  const { serverEditor } = await import("@/server/blocknote");
  const { deleteWorkspaces } = await import("@/server/workspaces");
  const ownerId = `${input.run}-peer-owner`.padEnd(32, "x");
  const aliceId = `${input.run}-peer-alice`.padEnd(32, "x");
  await db.insert(user).values([
    { id: ownerId, name: "Owner elsewhere", email: input.ownerEmail, emailVerified: true },
    { id: aliceId, name: "Alice elsewhere", email: input.aliceEmail, emailVerified: true },
  ]);
  const cookie = await signedIn(ownerId);
  const post = (headers: Record<string, string>) =>
    route.POST(
      new Request("http://backup-e2e.localhost/api/backups", {
        method: "POST",
        headers: { cookie, "content-type": "application/zip", ...headers },
        body: Readable.toWeb(createReadStream(join(work, "backup.zip"))) as ReadableStream,
        duplex: "half",
      } as RequestInit),
    );

  const refused = await post({});
  const restored = await post({ "x-leafdesk-restore": "1" });
  const result = await restored.json();
  const again = await post({ "x-leafdesk-restore": "1" });
  const workspaceId = result.workspaceId as string;
  const dump = await dumpWorkspace(workspaceId);

  const files: Record<string, string | null> = {};
  for (const row of await db.select().from(file).where(eq(file.workspaceId, workspaceId))) {
    const bytes = await storedBytes(row.storageKey);
    files[row.id] = bytes ? sha(bytes) : null;
  }
  // The body as the editor reads it, with the mention of Alice now naming her account here.
  const pages = await db.select({ id: page.id, ydoc: page.ydoc }).from(page).where(eq(page.workspaceId, workspaceId));
  const mentioned: string[] = [];
  for (const p of pages) {
    if (!p.ydoc) continue;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, p.ydoc);
    const walk = (blocks: { content?: unknown; children?: unknown[] }[]) => {
      for (const block of blocks) {
        if (Array.isArray(block.content)) {
          for (const inline of block.content as { type?: string; props?: { userId?: string } }[]) {
            if (inline.type === "mention" && inline.props?.userId) mentioned.push(inline.props.userId);
          }
        }
        walk((block.children ?? []) as typeof blocks);
      }
    };
    walk(serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)) as never);
  }
  const [audit] = await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId));
  const placeholders = await db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(like(user.email, "%@people.leafdesk.invalid"));

  await writeFile(
    join(work, "peer-output.json"),
    JSON.stringify({
      refusedStatus: refused.status,
      status: restored.status,
      result,
      againStatus: again.status,
      againError: (await again.json()).error,
      ownerId,
      aliceId,
      dump,
      files,
      mentioned,
      audit: audit?.action ?? null,
      placeholders,
    }),
  );

  // Clean up the other Leafdesk.
  if (workspaceId) await db.transaction((tx) => deleteWorkspaces(tx, [workspaceId]));
  // The people this run brought without an account (their ids start with the run's).
  const brought = placeholders.filter((p) => p.id.startsWith(input.run)).map((p) => p.id);
  await db.delete(user).where(inArray(user.id, [ownerId, aliceId, ...brought]));
  await rm(process.env.UPLOAD_DIR!, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// This Leafdesk

async function main() {
  const { BackupError, backupArchive, planBackup, recordBackup, snapshotWorkspace } = await import("@/server/backup/export");
  const { restoreBackup } = await import("@/server/backup/restore");
  const { serverEditor } = await import("@/server/blocknote");
  const { createAgent } = await import("@/server/agents/manage");
  const databases = await import("@/server/databases");
  const files = await import("@/server/files");
  const { createGroup } = await import("@/server/groups");
  const { setFavorite } = await import("@/server/page-meta");
  const { createPage } = await import("@/server/pages");
  const { setPagePermission } = await import("@/server/permissions");
  const { publishPage } = await import("@/server/publication");
  const { createRow } = await import("@/server/templates");
  const { addTeamspaceMembers, createTeamspace } = await import("@/server/teamspaces");
  const { addMemberAs, createWorkspace, deleteWorkspaces, updateWorkspaceSettings } = await import("@/server/workspaces");
  const { zipEntries, readEntry } = await import("@/server/backup/zip-reader");
  const { zipSync } = await import("fflate");

  const RUN = `bk${Date.now().toString(36)}`;
  const id = (name: string) => `${RUN}-${name}`.padEnd(32, "0");
  const ids = { owner: id("owner"), alice: id("alice"), bob: id("bob") };
  const email = (name: string) => `${RUN}-${name}@example.test`;
  await db.insert(user).values([
    { id: ids.owner, name: "Olivia Owner", email: email("owner"), emailVerified: true },
    { id: ids.alice, name: "Alice", email: email("alice"), emailVerified: true },
    { id: ids.bob, name: "Bob", email: email("bob"), emailVerified: true },
  ]);
  let workspaceId: string | null = null;
  let agentUserId: string | null = null;
  try {
    // ----- A workspace with a bit of everything
    workspaceId = (await createWorkspace(ids.owner, `${RUN} Team`)).id;
    const ws = workspaceId;
    await addMemberAs(ids.owner, ws, email("alice"), "member");
    await addMemberAs(ids.owner, ws, email("bob"), "member");
    const space = await createTeamspace(ids.owner, ws, { name: "Design" });
    await addTeamspaceMembers(ids.owner, space.id, [ids.alice, ids.bob]);
    const group = await createGroup(ids.owner, ws, "Reviewers", [ids.alice, ids.bob]);
    const agent = await createAgent(ids.owner, ws, { name: "Helper", instructions: "Help." });
    agentUserId = (agent as unknown as { userId: string }).userId;

    const owner = { userId: ids.owner };
    const doc = await createPage(owner, { workspaceId: ws, title: "Plans", markdown: "Hello" });
    const child = await createPage(owner, { workspaceId: ws, parentId: doc.id, title: "Details", markdown: "More" });
    const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) % 256))]);
    const stored = await files.uploadFile(ids.owner, doc.id, { name: "plan.png", contentType: "image/png", body: Readable.from([png]), declaredSize: png.length });
    const text = Buffer.from("plain notes ".repeat(500));
    const notes = await files.uploadFile(ids.owner, doc.id, { name: "notes.txt", contentType: "text/plain", body: Readable.from([text]), declaredSize: text.length });

    // The body: mentions of Alice and Bob, a comment thread by Bob, the image.
    const body = new Y.Doc();
    const mention = (userId: string, name: string) => ({ type: "mention", props: { ...EMPTY_MENTION, kind: "user", userId, name } });
    serverEditor.blocksToYXmlFragment(
      [
        { type: "paragraph", content: [{ type: "text", text: "Ask ", styles: {} }, mention(ids.alice, "Alice"), { type: "text", text: " and ", styles: {} }, mention(ids.bob, "Bob")] },
        { type: "image", props: { url: stored.url, name: "plan.png" } },
      ] as never,
      body.getXmlFragment(COLLAB_FRAGMENT),
    );
    const threads = body.getMap("threads");
    const thread = new Y.Map();
    thread.set("id", "thread-1");
    const comments = new Y.Array();
    comments.push([{ id: "c1", userId: ids.bob, body: "Looks good", reactions: [{ emoji: "👍", userIds: [ids.alice] }] }]);
    thread.set("comments", comments);
    threads.set("thread-1", thread);
    const state = Y.encodeStateAsUpdate(body);
    await db
      .update(page)
      .set({ ydoc: state, contentMarkdown: `Ask @Alice and @Bob\n\n![plan.png](${stored.url})\n\n[notes](${notes.url})` })
      .where(eq(page.id, doc.id));
    await db.insert(pageSnapshot).values({ pageId: doc.id, title: "Plans", ydoc: state, contentMarkdown: "Ask", reason: "manual", createdBy: ids.bob } as never);
    // A workspace snippet travels with the backup; Alice's personal one belongs to her account and stays out.
    await db.execute(sql`insert into snippet (id, workspace_id, trigger, title, body, created_by) values (gen_random_uuid(), ${ws}, 'standup', 'Standup', '## {{date}}', ${ids.bob})`);
    await db.execute(sql`insert into snippet (id, user_id, trigger, title, body, created_by) values (gen_random_uuid(), ${ids.alice}, 'sign', 'Sign-off', 'Thanks, {{me}}', ${ids.alice})`);

    // A top-level page outside any teamspace with no entry for everyone (as one whose teamspace was
    // deleted): restored where it was, not in the default teamspace.
    const loose = await createPage(owner, { workspaceId: ws, title: "Loose", teamspaceId: null });
    await createPage(owner, { workspaceId: ws, parentId: loose.id, title: "Loose child" });
    await db.execute(sql`delete from page_permission where page_id = ${loose.id} and user_id is null`);
    const tasks = await createPage(owner, { workspaceId: ws, kind: "database", title: "Tasks" });
    const person = await databases.addProperty(ids.owner, tasks.id, { name: "Owner", type: "person" });
    const attachments = await databases.addProperty(ids.owner, tasks.id, { name: "Attachments", type: "files" });
    const related = await databases.addProperty(ids.owner, tasks.id, { name: "Blocked by", type: "relation", relation: { databaseId: tasks.id } });
    const first = await createRow(owner, tasks.id, { title: "First" });
    await createRow(owner, tasks.id, {
      title: "Second",
      properties: {
        [person.id]: [ids.alice, ids.bob],
        [attachments.id]: [{ url: stored.url, name: "plan.png", type: "image/png" }],
        [related.id]: [first.id],
      },
    });
    await databases.addView(ids.owner, tasks.id, { name: "Board", type: "board" });
    await setFavorite(ids.alice, doc.id, true);
    await setPagePermission(ids.owner, child.id, ids.bob, "edit");
    await setPagePermission(ids.owner, child.id, `group:${group.id}`, "comment").catch(() => {});
    await publishPage(ids.owner, doc.id);
    // Alice's chat and what it noted about her are hers alone; the agent's note is the workspace's.
    const [chat] = await db.insert(aiConversation).values({ userId: ids.alice, workspaceId: ws, title: "My plans", messages: [] }).returning();
    const [aliceNote] = await db.insert(aiMemory).values({ userId: ids.alice, workspaceId: ws, text: "Alice is moving to Lisbon.", conversationId: chat.id }).returning();
    await db.insert(aiMemory).values({ userId: agentUserId!, workspaceId: ws, text: "Tasks go in the Tasks database." });
    // Members sign in with single sign-on only, which needs a provider: the server's own.
    await withInstanceProvider(() => updateWorkspaceSettings(ids.owner, ws, { loginMethod: "sso" }));

    // ----- Backing it up
    const plan = await planBackup(ids.owner, ws);
    const snapshot = await snapshotWorkspace(plan);
    await recordBackup(ids.owner, snapshot);
    const archive = join(work, "backup.zip");
    await pipeline(Readable.fromWeb(backupArchive(snapshot) as import("node:stream/web").ReadableStream), createWriteStream(archive));
    const original = await dumpWorkspace(ws);
    const loginMethodOf = (dump: Dump) => (dump.workspace[0]?.settings as { loginMethod?: string } | undefined)?.loginMethod;
    check(loginMethodOf(original) === "sso", "members of the workspace sign in with single sign-on only");
    const looseRow = original.page.find((p) => p.id === loose.id)!;
    check(looseRow.teamspace_id === null && looseRow.parent_id === null, "a top-level page is outside any teamspace");
    const filled = Object.entries(original).filter(([, rows]) => rows.length).map(([name]) => name);
    check(filled.length >= 15, `the workspace fills ${filled.length} tables`, filled);
    check(snapshot.manifest.people.length === 4, "the manifest names the three people and the agent", snapshot.manifest.people);
    const fileHashes: Record<string, string> = {};
    for (const row of await db.select().from(file).where(eq(file.workspaceId, ws))) fileHashes[row.id] = sha((await storedBytes(row.storageKey))!);
    check(Object.keys(fileHashes).length === 2, "two files are backed up");
    const backedUp = new Map<string, string>();
    for (const entry of await zipEntries(archive)) backedUp.set(entry.name, Buffer.from(await readEntry(archive, entry, 1e9)).toString("utf8"));
    check(![...backedUp.keys()].some((name) => name.startsWith("tables/ai_conversation/")), "people's AI chats stay out of the backup");
    const notesBackedUp = [...backedUp].filter(([name]) => name.startsWith("tables/ai_memory/")).flatMap(([, text]) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row));
    check(notesBackedUp.length === 1 && notesBackedUp[0].user_id === agentUserId, "of the AI's notes, only the agent's are backed up", notesBackedUp);
    const [created] = await db.select().from(auditEvent).where(sql`${auditEvent.workspaceId} = ${ws} and ${auditEvent.action} = 'backup.created'`);
    check(created, "the backup is in the audit log");

    // ----- On another Leafdesk
    const peerUrl =
      process.env.PEER_DATABASE_URL ??
      (() => {
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `${url.pathname}_peer`;
        return url.toString();
      })();
    // Without a single sign-on provider of its own (an empty value outlasts one in .env).
    const peerEnv = { ...process.env, DATABASE_URL: peerUrl, OIDC_ISSUER: "" };
    await run(["scripts/migrate.ts"], peerEnv);
    await writeFile(join(work, "peer-input.json"), JSON.stringify({ run: RUN, ownerEmail: email("owner"), aliceEmail: email("alice"), files: fileHashes }));
    await run(["scripts/backup-e2e.ts", "--peer", work], peerEnv);
    const out = JSON.parse(await readFile(join(work, "peer-output.json"), "utf8"));
    check(out.refusedStatus === 403, "a restore without the request header is refused (cross-site)");
    check(out.status === 201, "the backup restores on another Leafdesk", out.result);
    check(out.againStatus === 409 && out.againError === "alreadyHere", "it doesn't restore a second time next to itself");
    check(out.result.workspaceId === ws && out.result.pages === original.page.length && out.result.files === 2, "the result names the workspace, its pages and files", out.result);
    check(
      out.result.withoutAccount.length === 1 && out.result.withoutAccount[0].email === email("bob"),
      "the person without an account there is listed, to invite",
      out.result.withoutAccount,
    );
    check(
      out.result.ssoOnlyTurnedOff === true && loginMethodOf(out.dump) === "any",
      "with no single sign-on there, “SSO only” falls back to any method, as the result says",
      { result: out.result, settings: out.dump.workspace[0]?.settings },
    );
    check(!out.result.siteLeftOut && out.result.connectionsToReconnect === 0, "nothing else needs setting up again", out.result);
    check(out.audit === "backup.restored", "the restore is in the audit log there");
    const placeholder = (out.placeholders as { id: string; email: string; name: string }[]).find((p) => p.id === ids.bob);
    check(placeholder && placeholder.email === restoredEmail(ids.bob) && placeholder.name === "Bob", "Bob is a user without an account there, under his name", out.placeholders);
    check(out.mentioned.includes(out.aliceId) && out.mentioned.includes(ids.bob) && !out.mentioned.includes(ids.alice), "the body's mentions name Alice's account there", out.mentioned);
    const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    check(sorted(out.files) === sorted(fileHashes), "the files arrive byte for byte", { there: out.files, here: fileHashes });

    const people = new Map([
      [ids.owner, out.ownerId as string],
      [ids.alice, out.aliceId as string],
    ]);
    const expected = expectedAfterRestore(original, people, new Set([ids.bob]), "any");
    compareDumps(expected, out.dump, "on another Leafdesk");

    // ----- Edited backups, and one next to itself
    const entries = await zipEntries(archive);
    const contents = new Map<string, Uint8Array>();
    for (const entry of entries) contents.set(entry.name, await readEntry(archive, entry, 1e9));
    async function edited(label: string, change: (files: Map<string, Uint8Array>) => void, expected = "invalid") {
      const copy = new Map(contents);
      change(copy);
      const path = join(work, `edited-${passed}.zip`);
      await writeFile(path, zipSync(Object.fromEntries([...copy].map(([name, bytes]) => [name, [bytes, { level: 0 }]]))));
      const code = await restoreBackup(ids.owner, path).then(
        () => "restored",
        (error) => (error instanceof BackupError ? error.code : String(error)),
      );
      check(code === expected, `an edited backup is refused: ${label}`, code);
    }
    // Restoring elsewhere would need the workspace gone; these are refused before that matters,
    // so the workspace id is changed everywhere first.
    const elsewhere = `${RUN}-moved`;
    const moveAll = (files: Map<string, Uint8Array>) => {
      for (const [name, bytes] of files) {
        if (name.startsWith("files/")) continue;
        files.set(name, Buffer.from(Buffer.from(bytes).toString("utf8").split(ws).join(elsewhere)));
      }
    };
    const tableEntry = (table: string) => [...contents.keys()].find((name) => name.startsWith(`tables/${table}/`))!;
    const editRows = (files: Map<string, Uint8Array>, table: string, change: (row: Row) => void) => {
      const name = tableEntry(table);
      const lines = Buffer.from(files.get(name)!).toString("utf8").split("\n").filter(Boolean);
      const rows = lines.map((line) => JSON.parse(line) as Row);
      change(rows[0]);
      files.set(name, Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    };
    // Moved alone, it passes every check and only meets its own rows, still here.
    await edited("its rows are on this server already", moveAll, "conflict");
    await edited("a page of another workspace", (f) => {
      moveAll(f);
      editRows(f, "page", (row) => (row.workspace_id = ws));
    });
    await edited("a page under a page outside it", (f) => {
      moveAll(f);
      editRows(f, "page", (row) => (row.parent_id = "not-in-the-backup"));
    });
    await edited("a file stored under another workspace", (f) => {
      moveAll(f);
      editRows(f, "file", (row) => (row.storage_key = `${ws}/${row.id}`));
    });
    await edited("someone the manifest doesn't name", (f) => {
      moveAll(f);
      editRows(f, "workspace_member", (row) => (row.user_id = "someone-who-isnt-in-the-manifest"));
    });
    await edited("an agent's user with another agent's address", (f) => {
      moveAll(f);
      const manifest = JSON.parse(Buffer.from(f.get("manifest.json")!).toString("utf8"));
      const agentPerson = manifest.people.find((p: { agent: boolean }) => p.agent);
      agentPerson.email = "agent-someone-else@agents.leafdesk.invalid";
      f.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    });
    await edited("a file without its bytes", (f) => {
      moveAll(f);
      f.delete([...f.keys()].find((name) => name.startsWith("files/"))!);
    });
    const next = await restoreBackup(ids.owner, archive).then(
      () => "restored",
      (error) => (error instanceof BackupError ? error.code : String(error)),
    );
    check(next === "alreadyHere", "it doesn't restore next to itself");

    // ----- On the same server, after deleting the workspace
    const keys = Object.keys(fileHashes).map((fileId) => `${ws}/${fileId}`);
    const [{ users: usersBefore }] = await db.select({ users: sql<number>`count(*)::int` }).from(user);
    await db.transaction(async (tx) => {
      const gone = await tx.delete(file).where(eq(file.workspaceId, ws)).returning({ key: file.storageKey });
      await files.queueStorageDeletion(tx, gone.map((f) => f.key));
      await deleteWorkspaces(tx, [ws]);
    });
    check((await db.select().from(storageDeletion).where(inArray(storageDeletion.storageKey, keys))).length === 2, "deleting it queues its files for removal");
    // As older versions backed up: with Alice's chat, and her note pointing at it.
    const older = new Map(contents);
    const olderManifest = JSON.parse(Buffer.from(older.get("manifest.json")!).toString("utf8"));
    const noteEntry = tableEntry("ai_memory");
    const noteRow = Object.fromEntries(backupTables().find((t) => t.name === "ai_memory")!.columns.map((c) => [c.name, encodeValue(c.kind, aliceNote[c.key as keyof typeof aliceNote])]));
    older.set(noteEntry, Buffer.from(Buffer.from(older.get(noteEntry)!).toString("utf8") + JSON.stringify(noteRow) + "\n"));
    const chatRow = { id: chat.id, user_id: ids.alice, workspace_id: ws, title: chat.title, messages: [], created_at: chat.createdAt.toISOString(), updated_at: chat.updatedAt.toISOString() };
    older.set("tables/ai_conversation/0001.jsonl", Buffer.from(JSON.stringify(chatRow) + "\n"));
    for (const t of olderManifest.tables) if (t.name === "ai_memory") t.rows += 1;
    olderManifest.tables.push({ name: "ai_conversation", rows: 1 });
    older.set("manifest.json", Buffer.from(JSON.stringify(olderManifest)));
    const olderArchive = join(work, "older.zip");
    await writeFile(olderArchive, zipSync(Object.fromEntries([...older].map(([name, bytes]) => [name, [bytes, { level: 0 }]]))));
    const back = await withInstanceProvider(() => restoreBackup(ids.owner, olderArchive));
    check(back.workspaceId === ws && back.withoutAccount.length === 0, "it restores where it was deleted, everyone with their account", back);
    const [restored] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, ws));
    check(
      !back.ssoOnlyTurnedOff && restored?.settings.loginMethod === "sso",
      "where the server has its own single sign-on provider, “SSO only” stays on",
      { back, settings: restored?.settings },
    );
    const [{ users: usersAfter }] = await db.select({ users: sql<number>`count(*)::int` }).from(user);
    check(usersAfter === usersBefore, "no new users (the agent's comes back as it was)", { usersBefore, usersAfter });
    check((await db.select().from(storageDeletion).where(inArray(storageDeletion.storageKey, keys))).length === 0, "the queued removals are called off");
    await db.update(storageDeletion).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(like(storageDeletion.storageKey, `${ws}/%`));
    await files.drainStorageDeletions();
    for (const key of keys) check(await storedBytes(key), `the file cleanup leaves ${key.split("/")[1]} alone`);
    compareDumps(expectedAfterRestore(original, new Map(), new Set(), "sso"), await dumpWorkspace(ws), "on the same server");
    const [{ chats }] = await db.select({ chats: sql<number>`count(*)::int` }).from(aiConversation).where(eq(aiConversation.workspaceId, ws));
    const [{ aliceNotes }] = await db.select({ aliceNotes: sql<number>`count(*)::int` }).from(aiMemory).where(eq(aiMemory.userId, ids.alice));
    check(chats === 0 && aliceNotes === 0, "an older backup's chats and people's notes don't come back", { chats, aliceNotes });

    // The restored workspace's id brings back its single sign-on provider id (`ws-<id>`), under
    // which a sign-in may still be on record from before (older versions left them when a deleted
    // workspace's connection went with it): Alice's, with an API token of hers. The connection the
    // restored workspace sets up forgets it, so its identity provider can't sign in as Alice.
    const { saveSsoConnection } = await import("@/server/sso");
    const { createApiToken } = await import("@/server/api/tokens");
    const providerId = `ws-${ws}`;
    const at = new Date();
    await db.insert(account).values({ id: `${RUN}-stale`, accountId: `${RUN}-alice-at-the-old-idp`, providerId, userId: ids.alice, createdAt: at, updatedAt: at });
    await createApiToken(ids.alice, { name: `${RUN} Alice`, scopes: ["pages:read"] });
    const issuer = "https://idp.example.test/restored";
    await saveSsoConnection(
      ids.owner,
      ws,
      { protocol: "oidc", issuer, clientId: "restored", clientSecret: "restored-secret", domains: `${RUN}.test` },
      {
        discover: async () => ({
          issuer,
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          jwksEndpoint: `${issuer}/jwks`,
          tokenEndpointAuthentication: "client_secret_basic",
        }),
      },
    );
    const stale = await db.select({ id: account.id }).from(account).where(eq(account.providerId, providerId));
    check(stale.length === 0, "a single sign-on connection set up for the restored workspace forgets the sign-ins its id had before", stale);
    const tokens = await db.select({ id: apiToken.id }).from(apiToken).where(eq(apiToken.userId, ids.alice));
    const [configured] = await db
      .select({ details: auditEvent.details })
      .from(auditEvent)
      .where(sql`${auditEvent.workspaceId} = ${ws} and ${auditEvent.action} = 'sso.configured'`);
    check(
      tokens.length === 0 && configured?.details?.created === true && configured.details.revokedApiTokens === 1,
      "…revoking the API tokens of the people they were for, as the audit log says",
      { tokens, configured },
    );

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    if (workspaceId) {
      const ws = workspaceId;
      await db.transaction(async (tx) => {
        await tx.delete(file).where(eq(file.workspaceId, ws));
        await deleteWorkspaces(tx, [ws]);
      });
    }
    await db.delete(user).where(inArray(user.id, [ids.owner, ids.alice, ids.bob, ...(agentUserId ? [agentUserId] : [])]));
    await rm(work, { recursive: true, force: true });
  }
  process.exit(0);
}

/** Runs a script with tsx in a child process, its output shown here, and waits for it. */
function run(args: string[], childEnv: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["tsx", ...args], { env: childEnv, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`))));
  });
}

/**
 * What a restore makes of the backed-up rows: people's ids mapped (in documents too), people
 * without an account here out of memberships, the login method the server leaves, and what
 * belongs to a server set anew.
 */
function expectedAfterRestore(original: Dump, people: Map<string, string>, withoutAccount: Set<string>, loginMethod: "any" | "sso"): Dump {
  const rewrite = idRewriter(people);
  const out: Dump = {};
  for (const t of backupTables()) {
    let rows = original[t.name];
    if (["workspace_member", "teamspace_member", "member_group_member"].includes(t.name)) rows = rows.filter((r) => !withoutAccount.has(r.user_id as string));
    out[t.name] = rows.map((row) => {
      const copy: Row = {};
      for (const c of t.columns) {
        const value = row[c.name];
        copy[c.name] = rewrite && c.kind !== "timestamp" && value !== null ? rewriteDeep(value, rewrite) : value;
      }
      if (t.name === "workspace") copy.settings = { ...(copy.settings as object), loginMethod };
      return masked(t.name, copy);
    });
  }
  return out;
}

/** Values a restore always sets anew. */
function masked(table: string, row: Row): Row {
  if (table === "workspace") {
    return { ...row, invite_link_token: null, settings: { ...(row.settings as object), allowedDomainsVerified: [] } };
  }
  if (table === "database_automation") return { ...row, secret_salt: "*" };
  if (table === "connection") return { ...row, secrets: null, status: "needsAuth", event_secret: "*" };
  return row;
}

function compareDumps(expected: Dump, actual: Dump, where: string) {
  for (const t of backupTables()) {
    const want = expected[t.name];
    const got = (actual[t.name] ?? []).map((row) => masked(t.name, row));
    if (JSON.stringify(want) === JSON.stringify(got)) continue;
    const index = want.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(got[i]));
    check(false, `${t.name} holds the same rows ${where}`, { expectedRows: want.length, actualRows: got.length, expected: want[index], actual: got[index] });
  }
  check(true, `every table holds the same rows ${where}`);
}
