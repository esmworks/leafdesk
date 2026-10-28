import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import {
  ENGLISH_GITHUB_NAMES,
  githubApiUrl,
  labelsNeeded,
  PULL_STAGE_GROUPS,
  PULL_STAGES,
  parseGithubQuery,
  type GithubPullsMapping,
  type GithubPullsNames,
  type GithubPullsQuery,
  type GithubPullsSyncView,
} from "@/lib/github-pulls-sync";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, requireDatabase, type OptionInput } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { openJson, sealJson } from "@/server/secret-box";
import { takeSyncSetup } from "@/server/sync-setup";
import { checkGithubApi, fetchPulls, GithubPullsError, githubRepository } from "./client";
import { applyPulls, type GithubAuth } from "./run";
import { asSetup } from "@/server/database-changes";

/**
 * Setting up, changing and stopping GitHub pull request syncs (lib/github-pulls-sync; runs in
 * ./run, held and recorded by server/jira-sync/run). Setting one up makes a database from the
 * repository's pull requests, like an import: Number, State (Draft, Open, Merged, Closed), Author
 * and Assignees (with a text beside each for people the workspace doesn't have), Labels, Branch,
 * Base, Created, Merged and a link, and a board by state. Changing, syncing and stopping need full
 * access to the database; whoever changes a sync or syncs it by hand is who it runs as from then on.
 */

const MAX_TOKEN = 1000;

function apiUrlOf(value: unknown) {
  const apiUrl = githubApiUrl(value);
  if (!apiUrl) throw new GithubPullsError("invalidSite", "Not a valid address");
  checkGithubApi(apiUrl);
  return apiUrl;
}

/** The token typed, null for none. */
function tokenOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > MAX_TOKEN) throw new GithubPullsError("invalidInput", "Not a token");
  return value.trim() || null;
}

function query(value: unknown): GithubPullsQuery {
  const parsed = parseGithubQuery(value);
  if (!parsed) throw new GithubPullsError("invalidInput", "Name a repository as owner/name");
  return parsed;
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new GithubPullsError("invalidInput", "Not an interval a sync offers");
  return value;
}

export type GithubPullsSyncInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  /** A GitHub Enterprise Server's address; nothing for github.com. */
  apiUrl?: unknown;
  query: unknown;
  token?: unknown;
  intervalMinutes?: unknown;
  names?: GithubPullsNames;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from a repository's pull requests and keeps it in step from then on. Everything
 * is checked and fetched before anything is made; a failure after that takes the database back.
 */
async function untrackedCreateGithubPullsSync(actor: WriteActor, input: GithubPullsSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const apiUrl = apiUrlOf(input.apiUrl);
  const token = tokenOf(input.token);
  const q = query(input.query);
  const every = interval(input.intervalMinutes);
  const names = input.names ?? ENGLISH_GITHUB_NAMES;
  await requireDatabasePlace(userId, input);
  takeSyncSetup(userId);
  const { fullName } = await githubRepository(apiUrl, q.repo, token);
  const fetched = await fetchPulls(apiUrl, q, token);

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || fullName).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const number = await add(names.number, "number");
    const state = await add(
      names.state,
      "status",
      PULL_STAGES.map((stage) => ({ name: names.stages[stage], group: PULL_STAGE_GROUPS[stage] })),
    );
    const mapping: GithubPullsMapping = {
      number,
      state,
      author: await add(names.author, "person"),
      authorOthers: await add(names.others(names.author), "text"),
      assignees: await add(names.assignees, "person"),
      assigneesOthers: await add(names.others(names.assignees), "text"),
      labels: await add(names.labels, "multi_select", labelsNeeded([...fetched.rows, ...fetched.closed])),
      branch: await add(names.branch, "text"),
      base: await add(names.base, "text"),
      created: await add(names.created, "date"),
      merged: await add(names.merged, "date"),
      link: await add(names.link, "url"),
      stages: names.stages,
    };
    const written = await applyPulls(database, userId, mapping, fetched);
    // The table every new database has opens first; the board by state is beside it.
    await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: state } });
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "github",
      siteUrl: apiUrl,
      query: q,
      mapping,
      secrets: sealJson({ token } satisfies GithubAuth),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: fetched.rows.length,
      runAs: userId,
      createdBy: userId,
    });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "github");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A sync from GitHub: its query and mapping are GitHub's. */
type GithubSyncRow = SyncRow & { source: "github"; query: GithubPullsQuery; mapping: GithubPullsMapping };

/** The database's GitHub sync; null when it has none, or one from elsewhere (server/jira-sync). */
async function syncOf(databaseId: string): Promise<GithubSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "github" ? (row as GithubSyncRow) : null;
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

function view(row: GithubSyncRow, manage: boolean, now = new Date()): GithubPullsSyncView {
  return {
    apiUrl: row.siteUrl,
    repo: row.query.repo,
    state: row.query.state,
    hasToken: Boolean(openJson<GithubAuth>(row.secrets).token),
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError === "badQuery" || row.lastError === "tooManyIssues" ? "failed" : row.lastError,
    canManage: manage,
  };
}

/** A database's GitHub sync, for anyone who can see the database; null when it has none. */
export async function getGithubPullsSync(userId: string, databaseId: string): Promise<GithubPullsSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from GitHub");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncGithubPullsNow(userId: string, databaseId: string): Promise<GithubPullsSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new GithubPullsError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...view((await syncOf(databaseId))!, true), outcome };
}

/** `token`: a new token, "" to sync without one. */
export type GithubPullsSyncPatch = { state?: unknown; intervalMinutes?: unknown; token?: unknown };

/**
 * Changes a sync: which pull requests it takes, how often it runs, or its token (checked with
 * GitHub first; the repository stays). It runs as the person changing it from then on, and is on
 * again if it was paused. Taking other pull requests or a new token syncs at once.
 */
export async function updateGithubPullsSync(userId: string, databaseId: string, patch: GithubPullsSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.state !== undefined) changes.query = query({ repo: row.query.repo, state: patch.state });
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.token !== undefined) {
    const token = tokenOf(patch.token);
    await githubRepository(row.siteUrl, row.query.repo, token);
    changes.secrets = sealJson({ token } satisfies GithubAuth);
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  if (changes.query || changes.secrets) return syncGithubPullsNow(userId, databaseId);
  return { ...view((await syncOf(databaseId))!, true), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are, and its token is forgotten. */
export async function stopGithubPullsSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}

/** createGithubPullsSync, which starts the history of what it makes (server/database-changes.ts asSetup). */
export async function createGithubPullsSync(...args: Parameters<typeof untrackedCreateGithubPullsSync>) {
  return asSetup(() => untrackedCreateGithubPullsSync(...args));
}
