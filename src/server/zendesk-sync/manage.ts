import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import type { CrmSyncView } from "@/lib/crm-sync";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import {
  ENGLISH_ZENDESK_NAMES,
  parseZendeskQuery,
  ZENDESK_STATUS_GROUPS,
  ZENDESK_STATUSES,
  zendeskOptionsNeeded,
  zendeskSiteUrl,
  type ZendeskMapping,
  type ZendeskNames,
} from "@/lib/zendesk-sync";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, requireDatabase, type OptionInput } from "@/server/databases";
import { asSetup } from "@/server/database-changes";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { openJson, sealJson } from "@/server/secret-box";
import { withSyncReach } from "@/server/sync-reach";
import { takeSyncSetup } from "@/server/sync-setup";
import { checkZendeskSite, fetchTickets, zendeskAccount, ZendeskError, type ZendeskAuth } from "./client";
import { applyTickets } from "./run";

/**
 * Setting up, changing and stopping Zendesk ticket syncs (lib/zendesk-sync; runs in ./run, held
 * and recorded by server/jira-sync/run). Setting one up makes a database from the account's
 * tickets, like an import: Ticket (the number), Status, Priority, Type, Requester and Assignee (with
 * a text beside each for people the workspace doesn't have), Tags, Created, Updated and a link, and
 * a board by status. A first run brings over up to ZENDESK_PER_RUN tickets; later runs go on from
 * there and then take only what changed. Changing, syncing and stopping need full access to the
 * database; whoever changes a sync or syncs it by hand is who it runs as from then on.
 */

const MAX_EMAIL = 320;
const MAX_TOKEN = 1000;

export type ZendeskCredentials = { site?: unknown; email?: unknown; token?: unknown };

/** Checked credentials, or ZendeskError "invalidSite" / "invalidInput". */
function credentials(input: ZendeskCredentials): { siteUrl: string; auth: ZendeskAuth } {
  const siteUrl = zendeskSiteUrl(input.site);
  if (!siteUrl) throw new ZendeskError("invalidSite", "Not a valid address");
  checkZendeskSite(siteUrl);
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!email || email.length > MAX_EMAIL || !token || token.length > MAX_TOKEN) {
    throw new ZendeskError("invalidInput", "Give the email address and API token");
  }
  return { siteUrl, auth: { email, token } };
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new ZendeskError("invalidInput", "Not an interval a sync offers");
  return value;
}

export type ZendeskSyncInput = ZendeskCredentials & {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  intervalMinutes?: unknown;
  names?: ZendeskNames;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from an account's tickets and keeps it in step from then on. Everything is
 * checked and fetched before anything is made; a failure after that takes the database back.
 */
async function untrackedCreateZendeskSync(actor: WriteActor, input: ZendeskSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const { siteUrl, auth } = credentials(input);
  const every = interval(input.intervalMinutes);
  const names = input.names ?? ENGLISH_ZENDESK_NAMES;
  await requireDatabasePlace(userId, input);
  takeSyncSetup(userId);
  await zendeskAccount(siteUrl, auth);
  const fetched = await fetchTickets(siteUrl, auth, { since: null, total: 0 });

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || new URL(siteUrl).hostname).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const needed = zendeskOptionsNeeded(fetched.rows);
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const status = await add(
      names.status,
      "status",
      ZENDESK_STATUSES.map((s) => ({ name: names.statuses[s], group: ZENDESK_STATUS_GROUPS[s] })),
    );
    const mapping: ZendeskMapping = {
      id: await add(names.id, "number"),
      status,
      priority: await add(names.priority, "select", needed.priority),
      type: await add(names.type, "select", needed.type),
      requester: await add(names.requester, "person"),
      requesterOthers: await add(names.others(names.requester), "text"),
      assignee: await add(names.assignee, "person"),
      assigneeOthers: await add(names.others(names.assignee), "text"),
      tags: await add(names.tags, "multi_select", needed.tags),
      created: await add(names.created, "date"),
      updated: await add(names.updated, "date"),
      link: await add(names.link, "url"),
      statuses: names.statuses,
    };
    const written = await applyTickets(database, userId, mapping, fetched);
    // The table every new database has opens first; the board by status is beside it.
    await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: status } });
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "zendesk",
      siteUrl,
      query: { since: fetched.next.since, total: written.created },
      mapping,
      secrets: sealJson(auth),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: written.created,
      runAs: userId,
      createdBy: userId,
    });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "zendesk");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A sync from Zendesk: its query (state) and mapping are Zendesk's. */
type ZendeskSyncRow = SyncRow & { source: "zendesk"; mapping: ZendeskMapping };

/** The database's Zendesk sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<ZendeskSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "zendesk" ? (row as ZendeskSyncRow) : null;
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

function view(row: ZendeskSyncRow, manage: boolean, now = new Date()): CrmSyncView {
  return {
    source: "zendesk",
    siteUrl: row.siteUrl,
    object: null,
    account: manage ? openJson<ZendeskAuth>(row.secrets).email : "",
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount ?? parseZendeskQuery(row.query).total,
    lastError: row.lastError === "badQuery" ? "failed" : row.lastError,
    lastErrorDetail: null,
    canManage: manage,
  };
}

/** A database's Zendesk sync, for anyone who can see the database; null when it has none. */
export async function getZendeskSync(userId: string, databaseId: string): Promise<CrmSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from Zendesk");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncZendeskNow(userId: string, databaseId: string): Promise<CrmSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new ZendeskError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...view((await syncOf(databaseId))!, true), outcome };
}

/** `email` and `token`: a new sign-in (both, checked with Zendesk first; the account stays). */
export type ZendeskSyncPatch = { intervalMinutes?: unknown; email?: unknown; token?: unknown };

/**
 * Changes a sync: how often it runs, or its sign-in. It runs as the person changing it from then
 * on, and is on again if it was paused. A new sign-in syncs at once.
 */
export async function updateZendeskSync(userId: string, databaseId: string, patch: ZendeskSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.email !== undefined || patch.token !== undefined) {
    const { auth } = await withSyncReach(userId, row.workspaceId, async () => {
      const checked = credentials({ site: row.siteUrl, email: patch.email, token: patch.token });
      takeSyncSetup(userId);
      await zendeskAccount(row.siteUrl, checked.auth);
      return checked;
    });
    changes.secrets = sealJson(auth);
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  if (changes.secrets) return syncZendeskNow(userId, databaseId);
  return { ...view((await syncOf(databaseId))!, true), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are, and its sign-in is forgotten. */
export async function stopZendeskSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}

/** createZendeskSync, which starts the history of what it makes (server/database-changes.ts asSetup). */
export async function createZendeskSync(...args: Parameters<typeof untrackedCreateZendeskSync>) {
  const [actor, input] = args;
  return withSyncReach(actor.userId, input.workspaceId, () => asSetup(() => untrackedCreateZendeskSync(...args)));
}
