import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync, page } from "@/db/schema";
import { dateMillis } from "@/lib/date-value";
import type { GcalQuery } from "@/lib/gcal-sync";
import type { IcalMapping } from "@/lib/ical-sync";
import { requireMembership } from "@/server/access";
import { createRows, insertRows, normalizeRowProperties, requireDatabase } from "@/server/databases";

/**
 * Writing events into the calendars of a workspace (the AI chat's `create_calendar_event`, and
 * bookings, server/booking.ts). Only a Google Calendar synced both ways takes them: the event is a
 * row of its database, which the sync's next run writes back to Google (lib/gcal-sync `eventCreate`,
 * server/sync-writes.ts). A calendar read only would drop the row again, so it is never offered.
 */

/** A calendar events can be written to, as a person sees it. */
export type WritableCalendar = {
  databaseId: string;
  /** The database's title. */
  title: string;
  /** The Google calendar's own name. */
  calendarName: string;
};

export class CalendarEventError extends Error {
  constructor(
    readonly code: "noCalendar" | "notFound" | "which" | "invalidTime" | "noAccess",
    message: string,
    readonly calendars: WritableCalendar[] = [],
  ) {
    super(message);
    this.name = "CalendarEventError";
  }
}

type Target = WritableCalendar & { workspaceId: string; mapping: IcalMapping };

async function targets(userId: string, workspaceId: string, only?: string): Promise<Target[]> {
  const syncs = await db
    .select({ databaseId: databaseSync.databaseId, query: databaseSync.query, mapping: databaseSync.mapping, title: page.title, archivedAt: page.archivedAt })
    .from(databaseSync)
    .innerJoin(page, eq(page.id, databaseSync.databaseId))
    .where(and(eq(databaseSync.workspaceId, workspaceId), eq(databaseSync.source, "gcal")));
  const found = await Promise.all(
    syncs.map(async (sync): Promise<Target | null> => {
      const query = sync.query as GcalQuery;
      const mapping = sync.mapping as IcalMapping;
      if (query.direction !== "both" || !mapping.when || sync.archivedAt || (only && sync.databaseId !== only)) return null;
      const database = await requireDatabase(userId, sync.databaseId, "content").catch(() => null);
      if (!database || database.archivedAt) return null;
      return { databaseId: sync.databaseId, title: sync.title, calendarName: query.calendarName, workspaceId, mapping };
    }),
  );
  return found.flatMap((t) => (t ? [t] : []));
}

/** The calendars of the workspace the person may add events to. */
export async function writableCalendars(userId: string, workspaceId: string): Promise<WritableCalendar[]> {
  await requireMembership(userId, workspaceId);
  return (await targets(userId, workspaceId)).map(({ databaseId, title, calendarName }) => ({ databaseId, title, calendarName }));
}

/** Longest an event written here lasts. */
const MAX_EVENT_MS = 24 * 60 * 60_000;
/** What an event's title and notes may hold. */
const TITLE_MAX = 300;
const TEXT_MAX = 5000;

export type NewCalendarEvent = {
  title: string;
  /** Instants with an offset or Z (ISO 8601). */
  start: string;
  end: string;
  description?: string;
  location?: string;
};

function eventValues(target: Target, event: NewCalendarEvent) {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const timed = /T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/;
  if (!timed.test(event.start) || !timed.test(event.end) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_EVENT_MS) {
    throw new CalendarEventError("invalidTime", "An event needs a start and an end with a time zone, the end after the start, at most a day long");
  }
  const when = `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;
  if (!dateMillis(when)) throw new CalendarEventError("invalidTime", "Not a time range");
  const { description, location } = target.mapping;
  const text = (value: string | undefined, max: number) => (value ?? "").trim().slice(0, max);
  return {
    title: text(event.title, TITLE_MAX),
    properties: {
      [target.mapping.when!]: when,
      ...(description && text(event.description, TEXT_MAX) ? { [description]: text(event.description, TEXT_MAX) } : {}),
      ...(location && text(event.location, TEXT_MAX) ? { [location]: text(event.location, TEXT_MAX) } : {}),
    },
  };
}

async function pickTarget(userId: string, workspaceId: string, databaseId: string | undefined): Promise<Target> {
  await requireMembership(userId, workspaceId);
  const all = await targets(userId, workspaceId, databaseId);
  const list = all.map(({ databaseId: id, title, calendarName }) => ({ databaseId: id, title, calendarName }));
  if (!all.length) {
    throw new CalendarEventError(
      databaseId ? "notFound" : "noCalendar",
      databaseId ? "That database is not a Google Calendar synced both ways that you may add to" : "This workspace has no Google Calendar synced both ways that you may add events to",
    );
  }
  if (all.length > 1) throw new CalendarEventError("which", "More than one calendar takes events: say which by its database_id", list);
  return all[0];
}

/**
 * Adds an event to a calendar of the workspace, as the person (their access to the database is
 * checked by the write): a row of a Google Calendar synced both ways, which the sync writes back.
 * Without `databaseId` the workspace's only such calendar is used. Returns the row.
 */
export async function createCalendarEvent(
  userId: string,
  workspaceId: string,
  event: NewCalendarEvent,
  databaseId?: string,
): Promise<{ rowId: string; databaseId: string; calendar: string }> {
  const target = await pickTarget(userId, workspaceId, databaseId);
  const { title, properties } = eventValues(target, event);
  const [row] = await createRows(userId, target.databaseId, [{ title, properties }]);
  return { rowId: row.id, databaseId: target.databaseId, calendar: target.calendarName };
}

/**
 * A booking made by someone with no account (server/booking.ts), written into the owner's calendar
 * `databaseId`. Checked as the owner, whose access it uses, but the row has no creator and any
 * agent it sets off is held to what the owner may open (`boundTo`), as a public form's answers are.
 * Returns the row.
 */
export async function createVisitorEvent(
  ownerId: string,
  workspaceId: string,
  databaseId: string,
  event: NewCalendarEvent,
): Promise<{ rowId: string }> {
  const target = await pickTarget(ownerId, workspaceId, databaseId);
  const { title, properties } = eventValues(target, event);
  const values = await normalizeRowProperties(ownerId, target.databaseId, properties);
  const [row] = await insertRows({ id: target.databaseId, workspaceId }, null, [{ title, properties: values }], { boundTo: ownerId });
  return { rowId: row.id };
}
