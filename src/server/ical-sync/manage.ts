import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import { ENGLISH_ICAL_NAMES, icalUrl, ICAL_STATUSES, type IcalMapping, type IcalNames, type IcalSyncView } from "@/lib/ical-sync";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, requireDatabase, type OptionInput } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { JiraError } from "@/server/jira-sync/client";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { sealJson } from "@/server/secret-box";
import { takeSyncSetup } from "@/server/sync-setup";
import { applyEvents, fetchCalendar, type IcalAuth } from "./run";

/**
 * Setting up, changing and stopping calendar syncs (lib/ical-sync; runs in ./run, held and
 * recorded by server/jira-sync/run). Setting one up makes a database from the calendar's events,
 * like an import: Event ID, When, Location, Description, Status, Organizer and Link, and a calendar
 * view. Changing, syncing and stopping need full access to the database; whoever changes a sync or
 * syncs it by hand is who it runs as from then on. The address is kept sealed and never shown
 * again: a private calendar's address is its key.
 */

function urlOf(value: unknown) {
  const url = icalUrl(value);
  if (!url) throw new JiraError("invalidInput", "Not a calendar address");
  return url;
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new JiraError("invalidInput", "Not an interval a sync offers");
  return value;
}

export type IcalSyncInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  url: unknown;
  intervalMinutes?: unknown;
  names?: IcalNames;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from a calendar's events and keeps it in step from then on. The calendar is
 * read before anything is made; a failure after that takes the database back.
 */
export async function createIcalSync(actor: WriteActor, input: IcalSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const url = urlOf(input.url);
  const every = interval(input.intervalMinutes);
  const names = input.names ?? ENGLISH_ICAL_NAMES;
  await requireDatabasePlace(userId, input);
  takeSyncSetup(userId);
  const calendar = await fetchCalendar(url, names.untitled);

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || calendar.name || new URL(url).hostname).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const when = await add(names.when, "date");
    const mapping: IcalMapping = {
      key: await add(names.key, "text"),
      when,
      location: await add(names.location, "text"),
      description: await add(names.description, "text"),
      status: await add(
        names.status,
        "select",
        ICAL_STATUSES.map((status) => ({ name: names.statuses[status] })),
      ),
      organizer: await add(names.organizer, "text"),
      link: await add(names.link, "url"),
      statuses: names.statuses,
      untitled: names.untitled,
    };
    const written = await applyEvents(database, userId, mapping, calendar.rows);
    // The table every new database has opens first; the calendar by When is beside it.
    await addView(userId, database.id, { name: names.calendar, type: "calendar", config: { dateBy: when } });
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "ical",
      siteUrl: new URL(url).origin,
      query: {},
      mapping,
      secrets: sealJson({ url } satisfies IcalAuth),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: calendar.rows.length,
      runAs: userId,
      createdBy: userId,
    });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "ical");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A calendar sync: its mapping is a calendar's. */
type IcalSyncRow = SyncRow & { source: "ical"; mapping: IcalMapping };

/** The database's calendar sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<IcalSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "ical" ? (row as IcalSyncRow) : null;
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

function view(row: IcalSyncRow, manage: boolean, now = new Date()): IcalSyncView {
  return {
    host: new URL(row.siteUrl).host,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError === "badQuery" ? "failed" : row.lastError,
    canManage: manage,
  };
}

/** A database's calendar sync, for anyone who can see the database; null when it has none. */
export async function getIcalSync(userId: string, databaseId: string): Promise<IcalSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from a calendar");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncIcalNow(userId: string, databaseId: string): Promise<IcalSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new JiraError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...view((await syncOf(databaseId))!, true), outcome };
}

/** `url`: the calendar's new address (checked by reading it first). */
export type IcalSyncPatch = { intervalMinutes?: unknown; url?: unknown };

/**
 * Changes a sync: how often it runs, or the calendar's address (a calendar whose secret address
 * was reset). It runs as the person changing it from then on, and is on again if it was paused. A
 * new address syncs at once.
 */
export async function updateIcalSync(userId: string, databaseId: string, patch: IcalSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.url !== undefined) {
    const url = urlOf(patch.url);
    await fetchCalendar(url, row.mapping.untitled);
    changes.secrets = sealJson({ url } satisfies IcalAuth);
    changes.siteUrl = new URL(url).origin;
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  if (changes.secrets) return syncIcalNow(userId, databaseId);
  return { ...view((await syncOf(databaseId))!, true), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are, and the calendar's address is forgotten. */
export async function stopIcalSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}
