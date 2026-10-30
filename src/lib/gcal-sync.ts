import type { WorkspaceRole } from "@/db/schema/app";
import { dateValueString, parseDateValue } from "./date-value";
import { ENGLISH_ICAL_NAMES, ICAL_DAYS_AFTER, ICAL_DAYS_BEFORE, ICAL_STATUSES, type IcalMapping, type IcalRow, type IcalStatus } from "./ical-sync";
import type { JiraSyncError } from "./jira-sync";
import { dayNumber, dayString, zoneOffset } from "./time-zone";
import { contentRole } from "./workspace-roles";

/**
 * Keeping a database in step with a Google calendar, read through a workspace's Google Calendar
 * connection (an outbound MCP connection, see server/connections) with its `list_events` tool
 * (server/gcal-sync for setting it up, reading and writing, server/jira-sync/run for the runs every
 * synced database shares). Pure, shared by the server, the import dialog and the sync's dialog.
 *
 * The rows are a calendar sync's (lib/ical-sync): Event ID, When, Location, Description, Status,
 * Organizer and Link, each occurrence of a repeating event a row of its own, from ICAL_DAYS_BEFORE
 * days back to ICAL_DAYS_AFTER ahead. A sync reads only, or writes back too (`direction` "both"):
 * then changes made in Leafdesk wait in `sheets_write` (server/sync-writes) and the next run writes
 * them with the connection's `update_event` before it reads (eventUpdate): the title, When, Location
 * and Description, each only where the calendar still holds what the row had before (where both
 * changed, the calendar's value stays). Rows added in Leafdesk become events once they have a When
 * (eventCreate). Nothing is deleted in the calendar, attendees are never written, and no write sends
 * guests an email. Events the connection's account may not change (another organizer's) are read
 * only: changes to their rows are left for the next read to replace.
 */

/** The connection's tool a sync reads with. */
export const GCAL_TOOL = "list_events";
/** The connection's tools a sync writes back with. */
export const GCAL_WRITE_TOOLS = ["create_event", "update_event"] as const;
export type GcalWriteTool = (typeof GCAL_WRITE_TOOLS)[number];
/** The connection's tool the import dialog lists calendars with, when it has it (else the main calendar only). */
export const GCAL_CALENDARS_TOOL = "list_calendars";
/** The calendar a connection's account opens first. */
export const PRIMARY_CALENDAR = "primary";

export const GCAL_DIRECTIONS = ["read", "both"] as const;
export type GcalDirection = (typeof GCAL_DIRECTIONS)[number];

/** Events a run reads at most (occurrences of repeating ones counted one by one). */
export const MAX_GCAL_EVENTS = 5000;
/** Events a page of `list_events` holds at most. */
export const GCAL_PAGE_SIZE = 250;
/** Rows a run writes to the calendar at most; the rest wait for the next one. */
export const MAX_GCAL_WRITES = 100;
/** How long a new event made from a row with a start time only lasts, in minutes. */
export const NEW_EVENT_MINUTES = 60;
/** The field of `sheets_write.before` that holds the title (the others are property ids). */
export const TITLE_FIELD = "title";

/** What a sync reads: one calendar, through one connection. */
export type GcalQuery = {
  connectionId: string;
  /** "primary" for the connection's account's own calendar. */
  calendarId: string;
  /** The calendar's name when it was last read, for the dialog. */
  calendarName: string;
  /** The calendar's time zone when it was last read: times written back are its wall-clock times. */
  timeZone: string;
  /** "read" when left out. */
  direction?: GcalDirection;
  /** Why the last run couldn't write to the calendar (its reading went on), with Google's words. */
  writeError?: GcalSyncError | null;
  writeErrorDetail?: string | null;
};

/** The properties a sync writes: a calendar sync's (lib/ical-sync). */
export type GcalMapping = IcalMapping;

/**
 * Why a run didn't happen, in the codes every synced database uses: "unauthorized" (the connection
 * needs signing in to Google again), "forbidden" (the connection may no longer be used for it, or
 * its account may not write to the calendar), "notFound" (the connection or the calendar is gone),
 * "badQuery" (Google refused; lastErrorDetail says why), "tooManyIssues" (more than MAX_GCAL_EVENTS
 * events), "keyGone" (the Event ID property is gone), "unreachable" and "failed" (passing), and
 * "runAsGone", "accessLost" as for Jira.
 */
export type GcalSyncError = JiraSyncError;
export type GcalErrorCode = GcalSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A connection the person may sync calendars through, as the import dialog shows it (never its secrets). */
export type GcalSource = { id: string; name: string; canWrite: boolean };

/** A calendar the import dialog offers. */
export type GcalCalendar = { id: string; name: string };

/** A sync as its dialog on the database shows it. */
export type GcalSyncView = {
  calendarId: string;
  calendarName: string;
  connectionId: string;
  /** The connection's name; null once it is gone. */
  connection: string | null;
  /** With full access: the connections the viewer may read through, to switch to. */
  choices: GcalSource[];
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: GcalSyncError | null;
  lastErrorDetail: string | null;
  canManage: boolean;
  direction: GcalDirection;
  /** Whether the viewer may have the sync write back (gcalWriteAccess). */
  canWrite: boolean;
  writeError: GcalSyncError | null;
  writeErrorDetail: string | null;
  /** Rows whose changes wait to be written. */
  pendingWrites: number;
};

type ConnectionLike = { status: string; tools: { name: string }[]; chatTools: string[] };

/** Whether a person may read calendars through a connection, given their role. */
export function gcalAccess(row: ConnectionLike, role: WorkspaceRole): boolean {
  if (row.status !== "ready" || !row.tools.some((t) => t.name === GCAL_TOOL)) return false;
  // Owners manage the connection; members read through it only what an owner lets their AI chat read.
  return role === "owner" || (contentRole(role) === "member" && row.chatTools.includes(GCAL_TOOL));
}

/** Whether a person may also write events through a connection: its write tools, as gcalAccess has its read tool. */
export function gcalWriteAccess(row: ConnectionLike, role: WorkspaceRole): boolean {
  if (!gcalAccess(row, role) || !GCAL_WRITE_TOOLS.every((tool) => row.tools.some((t) => t.name === tool))) return false;
  return role === "owner" || GCAL_WRITE_TOOLS.every((tool) => row.chatTools.includes(tool));
}

/** A calendar id as a sync takes it: "primary" or what list_calendars gives (an address-like id). */
export function calendarIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 500 && !/[\s/?#]/.test(id) ? id : null;
}

const DAY_MS = 86_400_000;

/** A UTC instant as `list_events` and `create_event` take times: no offset, no Z (with `timeZone: "UTC"`). */
const utcText = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** The window a run reads, as list_events takes it (with `timeZone: "UTC"`). */
export function gcalWindow(now: number) {
  return { startTime: utcText(now - ICAL_DAYS_BEFORE * DAY_MS), endTime: utcText(now + ICAL_DAYS_AFTER * DAY_MS) };
}

// --- Events as rows ------------------------------------------------------------------------------

const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** One event as a row, with what writing it back needs to know. */
export type GcalRow = IcalRow & {
  /** The event's own title ("" when it has none; `title` then says it is untitled). */
  summary: string;
  /** Whether the connection's account may change the event. */
  writable: boolean;
};

/** One end of an event's time: a day (Google's `date`) or an instant (`dateTime`). */
function endOf(value: unknown): { day: number } | { ms: number } | null {
  const v = record(value);
  if (typeof v.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.date)) return { day: dayNumber(v.date) };
  if (typeof v.dateTime === "string") {
    const ms = Date.parse(v.dateTime);
    if (!Number.isNaN(ms)) return { ms };
  }
  return null;
}

/** The date property's value of an event's start and end (Google's end of whole days comes the day after the last). */
function whenOf(start: NonNullable<ReturnType<typeof endOf>>, end: ReturnType<typeof endOf>): string {
  if ("day" in start) {
    const last = end && "day" in end ? end.day - 1 : start.day;
    return last > start.day ? `${dayString(start.day)}/${dayString(last)}` : dayString(start.day);
  }
  const iso = new Date(start.ms).toISOString();
  return end && "ms" in end && end.ms > start.ms ? `${iso}/${new Date(end.ms).toISOString()}` : iso;
}

/** Whether the organizer lets guests change the event: Google's field, or the connection's `guestPermissions`. */
function guestsMayChange(event: Record<string, unknown>): boolean {
  return event.guestsCanModify === true || record(event.guestPermissions).guestsCanModify === true;
}

function organizerOf(value: unknown): string {
  const o = record(value);
  const email = text(o.email).trim();
  const name = text(o.displayName).trim();
  return name && email && name !== email ? `${name} <${email}>` : name || email;
}

/** Event types a person writes; working locations, birthdays and Gmail's events are read only. */
const WRITTEN_TYPES = new Set(["", "default"]);

/**
 * `list_events`'s events as rows: each with an id and a start, the calendar's own events
 * (`calendarId`) writable where `mayWrite` (the calendar's access for the connection's account lets
 * it) and the account organizes them, or their organizer lets guests change them.
 */
export function eventRows(events: unknown, calendarId: string, mayWrite: boolean, untitled = ENGLISH_ICAL_NAMES.untitled): GcalRow[] {
  if (!Array.isArray(events)) return [];
  const rows: GcalRow[] = [];
  for (const item of events) {
    const event = record(item);
    const key = text(event.id).trim();
    const start = endOf(event.start);
    if (!key || !start) continue;
    const summary = text(event.summary).trim();
    const status = text(event.status).toLowerCase();
    const link = text(event.htmlLink);
    const organizer = record(event.organizer);
    const ownEvent = organizer.self === true || (calendarId !== PRIMARY_CALENDAR && text(organizer.email) === calendarId);
    rows.push({
      key,
      title: summary || untitled,
      summary,
      when: whenOf(start, endOf(event.end)),
      location: text(event.location).trim(),
      description: text(event.description).trim(),
      status: (ICAL_STATUSES as readonly string[]).includes(status) ? (status as IcalStatus) : null,
      organizer: organizerOf(event.organizer),
      link: /^https:\/\//i.test(link) ? link : null,
      start: "day" in start ? start.day * DAY_MS : start.ms,
      writable: mayWrite && WRITTEN_TYPES.has(text(event.eventType).toLowerCase()) && (ownEvent || guestsMayChange(event)),
    });
  }
  return rows.sort((a, b) => a.start - b.start);
}

/** Whether a calendar's access for the connection's account (list_events' `accessRole`) lets it write events. */
export const writesCalendar = (accessRole: unknown) => accessRole === "owner" || accessRole === "writer";

// --- Writing back --------------------------------------------------------------------------------

/** The properties a run writes back, by what each holds (the mapping's that still exist). */
export type GcalWritten = { when?: string; location?: string; description?: string };

/** A value as compared: text trimmed (empty is none), dates in their stored shape. */
function comparable(field: "title" | "when" | "text", value: unknown): string | null {
  if (field === "when") {
    const parts = parseDateValue(value);
    return parts ? dateValueString(parts) : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Wall-clock time of an instant in `timeZone`, as the event tools take it (no offset). */
export function wallTime(ms: number, timeZone: string): string {
  return new Date(ms + zoneOffset(ms, timeZone)).toISOString().slice(0, 19);
}

/**
 * A date value as the event tools take it, in the calendar's zone: whole days as an all-day event
 * (Google's end the day after the last), times as wall-clock times. `end` is left out for a time
 * without an end when `keepLength` (update_event keeps the event's length), else it is
 * NEW_EVENT_MINUTES later. Null for what isn't a date.
 */
export function eventTimes(value: unknown, timeZone: string, keepLength: boolean): Record<string, unknown> | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  if (!parts.time) {
    const last = dayNumber(parts.end ?? parts.start);
    return { allDay: true, startTime: `${parts.start}T00:00:00`, endTime: `${dayString(last + 1)}T00:00:00`, timeZone };
  }
  const start = Date.parse(parts.start);
  const end = parts.end ? Date.parse(parts.end) : keepLength ? null : start + NEW_EVENT_MINUTES * 60_000;
  return { allDay: false, startTime: wallTime(start, timeZone), ...(end !== null ? { endTime: wallTime(end, timeZone) } : {}), timeZone };
}

/** A row as writing reads it. */
export type WrittenRow = { title: string; properties: Record<string, unknown> };

/** Arguments every write takes: no email to guests. */
const quiet = (calendarId: string) => ({ calendarId, notificationLevel: "NONE" });

/**
 * What update_event changes of an event for a row whose fields in `before` changed in Leafdesk:
 * each such field whose value the calendar still holds (else the calendar's stays), and that the
 * row now has otherwise. Null when nothing is to be written. A When cleared in Leafdesk isn't
 * written (an event keeps a time).
 */
export function eventUpdate(
  row: WrittenRow,
  before: Record<string, unknown>,
  event: GcalRow,
  fields: GcalWritten,
  query: Pick<GcalQuery, "calendarId" | "timeZone">,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const changed = (kind: "title" | "when" | "text", field: string, now: unknown, inCalendar: unknown) =>
    field in before &&
    comparable(kind, inCalendar) === comparable(kind, before[field]) &&
    comparable(kind, now) !== comparable(kind, inCalendar);
  if (changed("title", TITLE_FIELD, row.title, event.summary) && row.title.trim()) args.summary = row.title.trim();
  if (fields.when && changed("when", fields.when, row.properties[fields.when], event.when)) {
    const times = eventTimes(row.properties[fields.when], query.timeZone, true);
    if (times) Object.assign(args, times);
  }
  if (fields.location && changed("text", fields.location, row.properties[fields.location], event.location)) {
    args.location = comparable("text", row.properties[fields.location]) ?? "";
  }
  if (fields.description && changed("text", fields.description, row.properties[fields.description], event.description)) {
    args.description = comparable("text", row.properties[fields.description]) ?? "";
  }
  if (!Object.keys(args).length) return null;
  return { ...quiet(query.calendarId), eventId: event.key, ...args };
}

/** What create_event makes of a row added in Leafdesk; null while it has no When. */
export function eventCreate(
  row: WrittenRow,
  fields: GcalWritten,
  query: Pick<GcalQuery, "calendarId" | "timeZone">,
  untitled = ENGLISH_ICAL_NAMES.untitled,
): Record<string, unknown> | null {
  const times = fields.when ? eventTimes(row.properties[fields.when], query.timeZone, false) : null;
  if (!times) return null;
  const location = fields.location ? comparable("text", row.properties[fields.location]) : null;
  const description = fields.description ? comparable("text", row.properties[fields.description]) : null;
  return {
    ...quiet(query.calendarId),
    summary: row.title.trim() || untitled,
    ...times,
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
  };
}

/** The id of the event create_event made, from its answer; null when it has none. */
export function createdEventId(answer: unknown): string | null {
  const a = record(answer);
  const id = text(a.id || record(a.event).id).trim();
  return id || null;
}
