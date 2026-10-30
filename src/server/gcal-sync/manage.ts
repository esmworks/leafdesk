import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, sheetsWrite } from "@/db/schema";
import {
  calendarIdOf,
  GCAL_CALENDARS_TOOL,
  GCAL_DIRECTIONS,
  gcalAccess,
  gcalWriteAccess,
  type GcalCalendar,
  type GcalDirection,
  type GcalMapping,
  type GcalQuery,
  type GcalSource,
  type GcalSyncView,
} from "@/lib/gcal-sync";
import { ENGLISH_ICAL_NAMES, ICAL_STATUSES, type IcalNames } from "@/lib/ical-sync";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { asSetup } from "@/server/database-changes";
import { addProperty, addView, requireDatabase, type OptionInput } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { applyEvents } from "@/server/ical-sync/run";
import { JiraError } from "@/server/jira-sync/client";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { sealJson } from "@/server/secret-box";
import { takeSyncSetup } from "@/server/sync-setup";
import { dropSyncWrites, forgetTwoWaySyncs, fromSync } from "@/server/sync-writes";
import { callCalendar, gcalConnection, readEvents, type GcalConnection } from "./run";

/**
 * Setting up, changing and stopping Google Calendar syncs (lib/gcal-sync; runs in ./run, held and
 * recorded by server/jira-sync/run). Setting one up reads the calendar's events through a Google
 * Calendar connection of the database's workspace and makes a database like a calendar import
 * (server/ical-sync): Event ID, When, Location, Description, Status, Organizer and Link, and a
 * calendar view. Changing, syncing and stopping need full access to the database; whoever changes a
 * sync or syncs it by hand is who it runs as from then on, and they must be allowed to read through
 * the connection. Nothing secret is kept: the connection holds the Google sign-in.
 *
 * Writing back (`direction` "both") needs the connection's write tools for whoever turns it on and
 * whoever it runs as (lib/gcal-sync gcalWriteAccess), and a schedule: changes are written by the
 * sync's runs, which the changes bring forward (server/sync-writes).
 */

/** Where a sync's database says it comes from: the calendar's events open in Google Calendar. */
const SITE_URL = "https://calendar.google.com";

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new JiraError("invalidInput", "Not an interval a sync offers");
  return value;
}

function direction(value: unknown): GcalDirection {
  if (value === undefined) return "read";
  if (!GCAL_DIRECTIONS.includes(value as GcalDirection)) throw new JiraError("invalidInput", "Not a direction");
  return value as GcalDirection;
}

/** Writing back runs with the sync's runs: it needs a schedule. */
function requireSchedule(direction: GcalDirection, intervalMinutes: number) {
  if (direction === "both" && intervalMinutes <= 0) throw new JiraError("invalidInput", "Writing back needs the sync to run on a schedule");
}

const mayWrite = (row: GcalConnection) => gcalWriteAccess(row, row.role);

/** The connections the person may sync calendars through, in the order they were added. */
export async function gcalSources(userId: string, workspaceId: string): Promise<GcalSource[]> {
  const { role } = await requireMembership(userId, workspaceId);
  const rows = await db.select().from(connection).where(eq(connection.workspaceId, workspaceId)).orderBy(connection.createdAt);
  return rows.flatMap((row) => (gcalAccess(row, role) ? [{ id: row.id, name: row.name, canWrite: gcalWriteAccess(row, role) }] : []));
}

/** The connection, if the person may sync through it into `workspaceId`. */
async function usableConnection(userId: string, connectionId: unknown, workspaceId: string) {
  if (typeof connectionId !== "string" || !connectionId) throw new JiraError("invalidInput", "Choose a connection");
  const row = await gcalConnection(userId, connectionId);
  // A connection's calendars stay in its workspace.
  if (row.workspaceId !== workspaceId) throw new JiraError("forbidden", "That connection is in another workspace");
  return row;
}

/**
 * The calendars a connection's account has in its list, for the import dialog (the main calendar
 * is offered there anyway); none when the connection lacks list_calendars.
 */
export async function gcalCalendars(userId: string, workspaceId: string, connectionId: unknown): Promise<GcalCalendar[]> {
  const row = await usableConnection(userId, connectionId, workspaceId);
  if (!row.tools.some((t) => t.name === GCAL_CALENDARS_TOOL)) return [];
  const json = await callCalendar(userId, row, GCAL_CALENDARS_TOOL, { pageSize: 250 });
  const items = Array.isArray(json?.calendars) ? json.calendars : Array.isArray(json?.items) ? json.items : [];
  return items.flatMap((item: unknown) => {
    const c = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = calendarIdOf(c.id);
    const name = typeof c.summaryOverride === "string" && c.summaryOverride.trim() ? c.summaryOverride : typeof c.summary === "string" ? c.summary : "";
    return id ? [{ id, name: name.trim() || id }] : [];
  });
}

export type GcalSyncInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  connectionId: unknown;
  /** "primary" or an id from gcalCalendars. */
  calendarId: unknown;
  intervalMinutes?: unknown;
  /** "both" to write changes made in Leafdesk back to the calendar; "read" when left out. */
  direction?: unknown;
  names?: IcalNames;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from a calendar's events and keeps it in step from then on. The calendar is
 * read before anything is made; a failure after that takes the database back.
 */
async function untrackedCreateGcalSync(actor: WriteActor, input: GcalSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const calendarId = calendarIdOf(input.calendarId);
  if (!calendarId) throw new JiraError("invalidInput", "Choose a calendar");
  const every = interval(input.intervalMinutes);
  const way = direction(input.direction);
  requireSchedule(way, every);
  const names = input.names ?? ENGLISH_ICAL_NAMES;

  await requireDatabasePlace(userId, input);
  const workspaceId = input.parentId ? (await requirePageAccess(userId, input.parentId, "edit")).workspaceId : input.workspaceId;
  takeSyncSetup(userId);
  const row = await usableConnection(userId, input.connectionId, workspaceId);
  if (way === "both" && !mayWrite(row)) throw new JiraError("forbidden", "The connection may not be used to write");
  const read = await readEvents(userId, row, calendarId, names.untitled);
  if (way === "both" && !read.mayWrite) throw new JiraError("forbidden", "The connection's account may not change this calendar's events");

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || read.name || "Google Calendar").slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const add = async (name: string, type: Parameters<typeof addProperty>[2]["type"], options?: OptionInput[]) =>
      (await addProperty(userId, database.id, { name, type, options })).id;
    const when = await add(names.when, "date");
    const mapping: GcalMapping = {
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
    const written = await fromSync(() => applyEvents(database, userId, mapping, read.rows));
    // The table every new database has opens first; the calendar by When is beside it.
    await addView(userId, database.id, { name: names.calendar, type: "calendar", config: { dateBy: when } });
    const query: GcalQuery = { connectionId: row.id, calendarId, calendarName: read.name, timeZone: read.timeZone, direction: way };
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "gcal",
      siteUrl: SITE_URL,
      query,
      mapping,
      secrets: sealJson({}),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: read.rows.length,
      runAs: userId,
      createdBy: userId,
    });
    forgetTwoWaySyncs();
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "google-calendar");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A calendar sync through a connection: its query and mapping are a Google calendar's. */
type GcalSyncRow = SyncRow & { source: "gcal"; query: GcalQuery; mapping: GcalMapping };

/** The database's Google Calendar sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<GcalSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "gcal" ? (row as GcalSyncRow) : null;
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

/** `viewer`: who may manage it, to list the connections they may switch to; null for others. */
async function view(row: GcalSyncRow, viewer: string | null, now = new Date()): Promise<GcalSyncView> {
  const manage = viewer !== null;
  const [through] = await db.select().from(connection).where(eq(connection.id, row.query.connectionId)).limit(1);
  const [waiting] = await db.select({ n: count() }).from(sheetsWrite).where(eq(sheetsWrite.syncId, row.id));
  const choices = viewer ? await gcalSources(viewer, row.workspaceId) : [];
  return {
    calendarId: row.query.calendarId,
    calendarName: row.query.calendarName,
    connectionId: row.query.connectionId,
    connection: through?.name ?? null,
    choices,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError,
    // Google's own words about a refused read, for those who may change the sync.
    lastErrorDetail: manage ? row.lastErrorDetail : null,
    canManage: manage,
    direction: row.query.direction ?? "read",
    canWrite: choices.some((c) => c.id === through?.id && c.canWrite),
    writeError: row.query.writeError ?? null,
    writeErrorDetail: manage ? (row.query.writeErrorDetail ?? null) : null,
    pendingWrites: waiting?.n ?? 0,
  };
}

/** A database's Google Calendar sync, for anyone who can see the database; null when it has none. */
export async function getGcalSync(userId: string, databaseId: string): Promise<GcalSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, (await canManage(userId, databaseId)) ? userId : null) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from Google Calendar");
  return row;
}

/**
 * Runs a sync now, as the person asking from now on. Needs full access to the database, and, while
 * it writes back, leave to write through the connection.
 */
export async function syncGcalNow(userId: string, databaseId: string): Promise<GcalSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  if (row.query.direction === "both" && !mayWrite(await gcalConnection(userId, row.query.connectionId))) {
    throw new JiraError("forbidden", "The connection may not be used to write");
  }
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new JiraError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...(await view((await syncOf(databaseId))!, userId)), outcome };
}

/** `connectionId`: another connection to read through (one added again after the first was removed), checked by reading the calendar. */
export type GcalSyncPatch = { intervalMinutes?: unknown; connectionId?: unknown; direction?: unknown };

/**
 * Changes a sync: how often it runs, the connection it reads through (the calendar stays), or
 * whether it writes back. It runs as the person changing it from then on (who must be allowed to
 * write through the connection while it writes back), and is on again if it was paused. A new
 * connection syncs at once. Stopping writing back drops the changes waiting: the next run reads
 * them over.
 */
export async function updateGcalSync(userId: string, databaseId: string, patch: GcalSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  const way = patch.direction === undefined ? (row.query.direction ?? "read") : direction(patch.direction);
  requireSchedule(way, changes.intervalMinutes ?? row.intervalMinutes);
  let through = null;
  if (patch.connectionId !== undefined && patch.connectionId !== row.query.connectionId) {
    takeSyncSetup(userId);
    through = await usableConnection(userId, patch.connectionId, row.workspaceId);
    await readEvents(userId, through, row.query.calendarId, row.mapping.untitled);
    changes.query = { ...row.query, connectionId: through.id };
  }
  if (way === "both") {
    // Whoever it runs as from now on writes through it.
    through ??= await gcalConnection(userId, row.query.connectionId);
    if (!mayWrite(through)) throw new JiraError("forbidden", "The connection may not be used to write");
  }
  if (way !== (row.query.direction ?? "read")) {
    const query: GcalQuery = { ...((changes.query as GcalQuery | undefined) ?? row.query), direction: way, writeError: null, writeErrorDetail: null };
    changes.query = query;
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  forgetTwoWaySyncs();
  if (way === "read") await dropSyncWrites(row.id);
  if (through && through.id !== row.query.connectionId) return syncGcalNow(userId, databaseId);
  return { ...(await view((await syncOf(databaseId))!, userId)), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are. */
export async function stopGcalSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
  forgetTwoWaySyncs();
}

/** createGcalSync, which starts the history of what it makes (server/database-changes.ts asSetup). */
export async function createGcalSync(...args: Parameters<typeof untrackedCreateGcalSync>) {
  return asSetup(() => untrackedCreateGcalSync(...args));
}
