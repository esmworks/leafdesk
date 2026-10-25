import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import type { ImportResult } from "@/lib/import/result";
import {
  DEFAULT_JIRA_INTERVAL,
  ENGLISH_JIRA_NAMES,
  isJiraInterval,
  issueRow,
  jiraSiteUrl,
  jqlOf,
  optionsNeeded,
  parseJiraQuery,
  type JiraMapping,
  type JiraNames,
  type JiraProject,
  type JiraQuery,
  type JiraRow,
  type JiraSyncView,
} from "@/lib/jira-sync";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, getProperties, requireDatabase, type OptionInput } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { createPage, type DatabaseSeedNames } from "@/server/pages";
import { openJson, sealJson } from "@/server/secret-box";
import { checkJiraSite, JiraError, jiraAccount, jiraProjects, searchIssues, type JiraAuth } from "./client";
import { applyIssues, claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "./run";

/**
 * Setting up, changing and stopping Jira syncs (lib/jira-sync; runs in ./run). Setting one up makes
 * a database from what the query finds, like an import: Key, Status, Assignee (with a text beside
 * it for people the workspace doesn't have), Reporter, Priority, Type, Labels, Due date and a link
 * to the issue, and a board by status. The reporter can go to another person property later, or
 * nowhere. Changing, syncing and stopping need full access to the database;
 * whoever changes a sync or syncs it by hand is who it runs as from then on.
 */

const MAX_EMAIL = 320;
const MAX_TOKEN = 1000;

export type JiraCredentials = { siteUrl?: unknown; email?: unknown; token?: unknown };

/** Checked credentials, or JiraError "invalidSite" / "invalidInput". */
function credentials(input: JiraCredentials): { siteUrl: string; auth: JiraAuth } {
  const siteUrl = jiraSiteUrl(input.siteUrl);
  if (!siteUrl) throw new JiraError("invalidSite", "Not a valid address");
  checkJiraSite(siteUrl);
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!email || email.length > MAX_EMAIL || !token || token.length > MAX_TOKEN) {
    throw new JiraError("invalidInput", "Give the email address and API token");
  }
  return { siteUrl, auth: { email, token } };
}

function query(value: unknown): JiraQuery {
  const parsed = parseJiraQuery(value);
  if (!parsed) throw new JiraError("invalidInput", "Choose a project or write a JQL query");
  return parsed;
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new JiraError("invalidInput", "Not an interval a sync offers");
  return value;
}

/** Signs in to a Jira site to check the credentials: whose they are, and the projects they see. */
export async function checkJira(input: JiraCredentials): Promise<{ account: string; projects: JiraProject[] }> {
  const { siteUrl, auth } = credentials(input);
  const { name } = await jiraAccount(siteUrl, auth);
  return { account: name, projects: await jiraProjects(siteUrl, auth) };
}

export type JiraSyncInput = JiraCredentials & {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  query: unknown;
  intervalMinutes?: unknown;
  names?: JiraNames;
  seedNames?: DatabaseSeedNames;
};

const fetchRows = async (siteUrl: string, auth: JiraAuth, q: JiraQuery) =>
  (await searchIssues(siteUrl, auth, jqlOf(q))).map((issue) => issueRow(issue, siteUrl)).filter((row): row is JiraRow => row !== null);

/**
 * Makes a database from what a Jira query finds and keeps it in step from then on. Everything is
 * checked and fetched before anything is made; a failure after that takes the database back.
 */
export async function createJiraSync(actor: WriteActor, input: JiraSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const { siteUrl, auth } = credentials(input);
  const q = query(input.query);
  const every = interval(input.intervalMinutes);
  const names = input.names ?? ENGLISH_JIRA_NAMES;
  const rows = await fetchRows(siteUrl, auth, q);

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || ("project" in q ? q.project : "Jira")).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const needed = optionsNeeded(rows);
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const status = await add(names.status, "status", needed.status.map((s) => ({ name: s.name, group: s.group })));
    const mapping: JiraMapping = {
      key: await add(names.key, "text"),
      status,
      assignee: await add(names.assignee, "person"),
      assigneeOthers: await add(names.others(names.assignee), "text"),
      reporter: await add(names.reporter, "person"),
      priority: await add(names.priority, "select", needed.priority),
      type: await add(names.type, "select", needed.type),
      labels: await add(names.labels, "multi_select", needed.labels),
      due: await add(names.due, "date"),
      link: await add(names.link, "url"),
    };
    const written = await applyIssues(database, userId, mapping, rows);
    // The table every new database has opens first; the board by status is beside it.
    await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: status } });
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "jira",
      siteUrl,
      query: q,
      mapping,
      secrets: sealJson(auth),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: rows.length,
      runAs: userId,
      createdBy: userId,
    });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "jira");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A sync from Jira: its query and mapping are Jira's. */
type JiraSyncRow = SyncRow & { source: "jira"; query: JiraQuery; mapping: JiraMapping };

/** The database's Jira sync; null when it has none, or one from elsewhere (server/github-pulls). */
async function syncOf(databaseId: string): Promise<JiraSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "jira" ? (row as JiraSyncRow) : null;
}

async function canManage(userId: string, databaseId: string) {
  try {
    await requireDatabase(userId, databaseId, "full");
    return true;
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
}

/** The database's person properties, which a sync's reporter can go to. */
async function personProperties(databaseId: string) {
  return (await getProperties(databaseId)).filter((p) => p.type === "person").map(({ id, name }) => ({ id, name }));
}

async function view(row: JiraSyncRow, manage: boolean, now = new Date()): Promise<JiraSyncView> {
  const people = manage ? await personProperties(row.databaseId) : [];
  return {
    siteUrl: row.siteUrl,
    query: row.query,
    email: openJson<JiraAuth>(row.secrets).email,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError,
    lastErrorDetail: row.lastErrorDetail,
    canManage: manage,
    reporter: row.mapping.reporter ?? null,
    personProperties: people,
  };
}

/** A database's sync, for anyone who can see the database; null when it has none. */
export async function getJiraSync(userId: string, databaseId: string): Promise<JiraSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? await view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncJiraNow(userId: string, databaseId: string): Promise<JiraSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new JiraError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...(await view((await syncOf(databaseId))!, true)), outcome };
}

/** `reporter`: the person property issues' reporters go to (null: nowhere). */
export type JiraSyncPatch = JiraCredentials & { query?: unknown; intervalMinutes?: unknown; reporter?: unknown };

/**
 * Changes a sync: its query, how often it runs, where reporters go, or its sign-in (email and
 * token, checked with Jira first; the site stays). It runs as the person changing it from then on, and is on again if it was
 * paused. A new query or sign-in syncs at once.
 */
export async function updateJiraSync(userId: string, databaseId: string, patch: JiraSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.query !== undefined) changes.query = query(patch.query);
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.reporter !== undefined) {
    const { reporter: _old, ...mapping } = row.mapping;
    if (patch.reporter === null) changes.mapping = mapping;
    else if (typeof patch.reporter === "string" && (await personProperties(databaseId)).some((p) => p.id === patch.reporter)) {
      changes.mapping = { ...mapping, reporter: patch.reporter };
    } else throw new JiraError("invalidInput", "The reporter goes to a person property of the database");
  }
  if (patch.email !== undefined || patch.token !== undefined) {
    const { auth } = credentials({ siteUrl: row.siteUrl, email: patch.email, token: patch.token });
    await jiraAccount(row.siteUrl, auth);
    changes.secrets = sealJson(auth);
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  // A new query, sign-in or reporter property syncs at once (the reporters are filled in).
  if (changes.query || changes.secrets || (changes.mapping as JiraMapping | undefined)?.reporter) return syncJiraNow(userId, databaseId);
  return { ...(await view((await syncOf(databaseId))!, true)), outcome: null };
}

/** The projects the sync's sign-in can browse, to pick another. Needs full access to the database. */
export async function jiraProjectsOf(userId: string, databaseId: string): Promise<JiraProject[]> {
  const row = await requireSync(userId, databaseId);
  return jiraProjects(row.siteUrl, openJson<JiraAuth>(row.secrets));
}

/** Stops syncing: the database and its rows stay as they are, and its sign-in is forgotten. */
export async function stopJiraSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}

