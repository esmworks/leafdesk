import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import {
  ENGLISH_SALESFORCE_NAMES,
  isSalesforceObject,
  parseSalesforceQuery,
  salesforceOptionsNeeded,
  salesforceSiteUrl,
  SALESFORCE_OBJECT_SPECS,
  type SalesforceMapping,
  type SalesforceNames,
  type SalesforceObject,
} from "@/lib/salesforce-sync";
import type { CrmSyncView } from "@/lib/crm-sync";
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
import { checkSalesforceSite, fetchRecords, SalesforceError, salesforceToken, type SalesforceAuth } from "./client";
import { applyRecords } from "./run";

/**
 * Setting up, changing and stopping Salesforce syncs (lib/salesforce-sync; runs in ./run, held and
 * recorded by server/jira-sync/run). Setting one up makes a database from one object of the org
 * (Account, Contact, Opportunity, Lead or Case), like an import: Id, the object's standard fields,
 * Modified and a link, and, for objects with a stage or status, a board by it. A first run brings
 * over up to SALESFORCE_PER_RUN records; later runs go on from there and then take only what
 * changed. Changing, syncing and stopping need full access to the database; whoever changes a sync
 * or syncs it by hand is who it runs as from then on.
 */

const MAX_KEY = 300;

export type SalesforceCredentials = { site?: unknown; clientId?: unknown; clientSecret?: unknown };

/** Checked credentials, or SalesforceError "invalidSite" / "invalidInput". */
function credentials(input: SalesforceCredentials): { siteUrl: string; auth: SalesforceAuth } {
  const siteUrl = salesforceSiteUrl(input.site);
  if (!siteUrl) throw new SalesforceError("invalidSite", "Not a valid address");
  checkSalesforceSite(siteUrl);
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!clientId || clientId.length > MAX_KEY || !clientSecret || clientSecret.length > MAX_KEY) {
    throw new SalesforceError("invalidInput", "Give the consumer key and secret");
  }
  return { siteUrl, auth: { clientId, clientSecret } };
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new SalesforceError("invalidInput", "Not an interval a sync offers");
  return value;
}

export type SalesforceSyncInput = SalesforceCredentials & {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  object: unknown;
  intervalMinutes?: unknown;
  names?: SalesforceNames;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from one object of an org and keeps it in step from then on. Everything is
 * checked and fetched before anything is made; a failure after that takes the database back.
 */
async function untrackedCreateSalesforceSync(actor: WriteActor, input: SalesforceSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const { siteUrl, auth } = credentials(input);
  if (!isSalesforceObject(input.object)) throw new SalesforceError("invalidInput", "Choose an object to sync");
  const object: SalesforceObject = input.object;
  const every = interval(input.intervalMinutes);
  const names = input.names ?? ENGLISH_SALESFORCE_NAMES;
  await requireDatabasePlace(userId, input);
  takeSyncSetup(userId);
  const fetched = await fetchRecords(siteUrl, auth, { object, since: null, total: 0 });

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || object).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const needed = salesforceOptionsNeeded(object, fetched.rows);
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const mapping: SalesforceMapping = { id: await add(names.id, "text"), fields: {} };
    let board: string | null = null;
    for (const spec of SALESFORCE_OBJECT_SPECS[object].fields) {
      const name = names.fields[spec.key] ?? spec.key;
      const options = needed[spec.key]?.map((o) => ({ name: o.name, ...(o.group ? { group: o.group } : {}) }));
      mapping.fields[spec.key] = await add(name, spec.kind, options);
      if (spec.kind === "person") mapping.fields[`${spec.key}Others`] = await add(names.others(name), "text");
      if (spec.kind === "status") board = mapping.fields[spec.key];
    }
    mapping.modified = await add(names.modified, "date");
    mapping.link = await add(names.link, "url");
    const written = await applyRecords(database, userId, siteUrl, object, mapping, fetched.rows);
    // The table every new database has opens first; objects with a stage or status get a board by it beside it.
    if (board) await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: board } });
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "salesforce",
      siteUrl,
      query: { ...fetched.next, total: written.created },
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
    await recordImport(userId, database.workspaceId, result, "salesforce");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A sync from Salesforce: its mapping is Salesforce's. */
type SalesforceSyncRow = SyncRow & { source: "salesforce"; mapping: SalesforceMapping };

/** The database's Salesforce sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<SalesforceSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "salesforce" ? (row as unknown as SalesforceSyncRow) : null;
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

function view(row: SalesforceSyncRow, manage: boolean, now = new Date()): CrmSyncView {
  const state = parseSalesforceQuery(row.query);
  return {
    source: "salesforce",
    siteUrl: row.siteUrl,
    object: state?.object ?? null,
    account: manage ? openJson<SalesforceAuth>(row.secrets).clientId : "",
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount ?? state?.total ?? null,
    lastError: row.lastError === "tooManyIssues" ? "failed" : row.lastError,
    lastErrorDetail: row.lastErrorDetail,
    canManage: manage,
  };
}

/** A database's Salesforce sync, for anyone who can see the database; null when it has none. */
export async function getSalesforceSync(userId: string, databaseId: string): Promise<CrmSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from Salesforce");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncSalesforceNow(userId: string, databaseId: string): Promise<CrmSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new SalesforceError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...view((await syncOf(databaseId))!, true), outcome };
}

/** `clientId` and `clientSecret`: a new sign-in (both, checked with Salesforce first; the org and object stay). */
export type SalesforceSyncPatch = { intervalMinutes?: unknown; clientId?: unknown; clientSecret?: unknown };

/**
 * Changes a sync: how often it runs, or its sign-in. It runs as the person changing it from then
 * on, and is on again if it was paused. A new sign-in syncs at once.
 */
export async function updateSalesforceSync(userId: string, databaseId: string, patch: SalesforceSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.clientId !== undefined || patch.clientSecret !== undefined) {
    const { auth } = await withSyncReach(userId, row.workspaceId, async () => {
      const checked = credentials({ site: row.siteUrl, clientId: patch.clientId, clientSecret: patch.clientSecret });
      takeSyncSetup(userId);
      await salesforceToken(row.siteUrl, checked.auth);
      return checked;
    });
    changes.secrets = sealJson(auth);
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  if (changes.secrets) return syncSalesforceNow(userId, databaseId);
  return { ...view((await syncOf(databaseId))!, true), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are, and its sign-in is forgotten. */
export async function stopSalesforceSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}

/** createSalesforceSync, which starts the history of what it makes (server/database-changes.ts asSetup). */
export async function createSalesforceSync(...args: Parameters<typeof untrackedCreateSalesforceSync>) {
  const [actor, input] = args;
  return withSyncReach(actor.userId, input.workspaceId, () => asSetup(() => untrackedCreateSalesforceSync(...args)));
}
