import { browserTimeZone, dayNumber, dayString, localDay, zonedInstant } from "./time-zone";

/**
 * Values of date properties. A value is one ISO 8601 string in one of four shapes:
 *
 * - a day, `2026-10-12`: a calendar day without a time zone (what every date was before);
 * - a range of days, `2026-10-12/2026-10-14` (both days included);
 * - an instant, `2026-10-12T11:30:00.000Z`: a time, stored in UTC and shown in the viewer's zone;
 * - a range of instants, `2026-10-12T11:30:00.000Z/2026-10-12T13:00:00.000Z`.
 *
 * Start and end are the same kind, and the end is never before the start. Strings keep a value
 * readable by anything that only looks at its first ten characters (the start's day, in UTC for
 * instants). Pure and client-safe.
 */

export type DateParts = {
  /** `YYYY-MM-DD` for days, a UTC ISO timestamp for instants. */
  start: string;
  /** The last day or the end instant; null for a single day or instant. */
  end: string | null;
  /** Whether start and end are instants. */
  time: boolean;
};

/** A span of whole calendar days, as day numbers (see lib/time-zone dayNumber), both included. */
export type DaySpan = { start: number; end: number };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** An instant with its zone: `Z` or an offset such as `+03:00`. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** An instant written without a zone, which can't be placed in time. */
const NAIVE_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const DAY_MS = 86_400_000;

/** Whether `value` is a real calendar day written as YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** An instant with a zone as its UTC ISO string, or null. */
function instant(value: string): string | null {
  if (!INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // The calendar date written must exist (Date.parse rolls 2026-02-30 over into March).
  return isDay(value.slice(0, 10)) ? iso : null;
}

/** One end of a value: a day or an instant, else null. */
function part(value: string): { value: string; time: boolean } | null {
  if (isDay(value)) return { value, time: false };
  const at = instant(value);
  return at ? { value: at, time: true } : null;
}

/** Milliseconds of an instant string (already checked). */
const ms = (iso: string) => Date.parse(iso);

/**
 * A stored date value as its parts, or null for anything that isn't one. Read tolerantly: an end
 * before the start counts as no end.
 */
export function parseDateValue(value: unknown): DateParts | null {
  if (typeof value !== "string" || !value) return null;
  const slash = value.indexOf("/");
  const start = part(slash === -1 ? value : value.slice(0, slash));
  if (!start) return null;
  if (slash === -1) return { start: start.value, end: null, time: start.time };
  const end = part(value.slice(slash + 1));
  if (!end || end.time !== start.time) return null;
  const ordered = start.time ? ms(end.value) >= ms(start.value) : end.value >= start.value;
  return { start: start.value, end: ordered ? end.value : null, time: start.time };
}

/** The stored string of a value's parts. */
export function dateValueString(parts: DateParts): string {
  return parts.end === null ? parts.start : `${parts.start}/${parts.end}`;
}

/**
 * A value as plain text for files people read and import again (CSV, Markdown, converted text):
 * "2026-10-12", "2026-10-12 → 2026-10-14", times as UTC timestamps. Null for what isn't a date.
 */
export function dateValueText(value: unknown): string | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  return parts.end === null ? parts.start : `${parts.start} → ${parts.end}`;
}

/** Whether a stored value has an end. */
export function hasDateEnd(value: unknown): boolean {
  return parseDateValue(value)?.end != null;
}

/** Whether a stored value holds times. */
export function hasDateTime(value: unknown): boolean {
  return parseDateValue(value)?.time === true;
}

export type DateInputResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * Checks a date value given by the app, REST or MCP and returns it as stored. Takes the stored
 * string shapes, or `{start, end}` with each a day or an instant. Instants need a zone (`Z` or an
 * offset like `+03:00`) and are stored in UTC. Start and end must be the same kind, and an end
 * before the start is refused, never turned around. `name` names the property in messages.
 */
export function checkDateInput(input: unknown, name: string): DateInputResult {
  const shapes = `a day (YYYY-MM-DD), a time with its zone (2026-10-12T14:30:00Z or +03:00), or a range of either as "start/end" or {start, end}`;
  let start: unknown;
  let end: unknown = null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    const slash = trimmed.indexOf("/");
    start = slash === -1 ? trimmed : trimmed.slice(0, slash).trim();
    if (slash !== -1) end = trimmed.slice(slash + 1).trim();
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    ({ start, end = null } = input as { start?: unknown; end?: unknown });
  } else {
    return { ok: false, message: `"${name}" must be ${shapes}` };
  }
  const read = (raw: unknown) => {
    if (typeof raw !== "string") return null;
    if (NAIVE_INSTANT.test(raw.trim())) return "naive" as const;
    return part(raw.trim());
  };
  const from = read(start);
  const to = end === null || end === undefined || end === "" ? null : read(end);
  if (from === "naive" || to === "naive") {
    return { ok: false, message: `"${name}" has a time without a zone; add Z (UTC) or an offset such as +03:00` };
  }
  if (!from || (end !== null && end !== undefined && end !== "" && !to)) return { ok: false, message: `"${name}" must be ${shapes}` };
  if (!to) return { ok: true, value: from.value };
  if (to.time !== from.time) {
    return { ok: false, message: `"${name}" must start and end with days, or both with times` };
  }
  if (from.time ? ms(to.value) < ms(from.value) : to.value < from.value) {
    return { ok: false, message: `"${name}" ends before it starts` };
  }
  return { ok: true, value: `${from.value}/${to.value}` };
}

/** The day numbers of an instant in `timeZone`. */
const instantDay = (iso: string, timeZone: string) => localDay(ms(iso), timeZone);

/**
 * The calendar days a value covers, as day numbers: a day range from its first to its last day;
 * an instant on its day in `timeZone` (the runtime's when left out: the viewer's in the browser,
 * the server's elsewhere, as for created and edited times). A range of instants ending at
 * midnight doesn't reach into the day after. Null for anything that isn't a date.
 */
export function dateDays(value: unknown, timeZone: string = browserTimeZone()): DaySpan | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  if (!parts.time) {
    const start = dayNumber(parts.start);
    return { start, end: parts.end ? dayNumber(parts.end) : start };
  }
  const start = instantDay(parts.start, timeZone);
  if (!parts.end) return { start, end: start };
  const endMs = Math.max(ms(parts.start), ms(parts.end) - 1);
  return { start, end: localDay(endMs, timeZone) };
}

/** The first day of a value (YYYY-MM-DD) as `dateDays` places it, or null. */
export function dateStartDay(value: unknown, timeZone?: string): string | null {
  const days = dateDays(value, timeZone);
  return days ? dayString(days.start) : null;
}

/** Whether a value covers any day from `from` to `to` (YYYY-MM-DD, both included). */
export function dateOverlaps(value: unknown, from: string, to: string, timeZone?: string): boolean {
  const days = dateDays(value, timeZone);
  return Boolean(days && days.start <= dayNumber(to) && days.end >= dayNumber(from));
}

/**
 * Where a value starts, in milliseconds, for sorting: an instant itself, a day at its midnight in
 * `timeZone`, so days and times on the same day sort together (the whole day first).
 */
export function dateSortKey(value: unknown, timeZone: string = browserTimeZone()): number | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  return parts.time ? ms(parts.start) : zonedInstant(dayNumber(parts.start), 0, timeZone);
}

/**
 * Start and end as milliseconds in UTC, for date arithmetic that ignores zones (formulas, rollups):
 * a day at its midnight in UTC, an instant itself. `end` is the start when there is none.
 */
export function dateMillis(value: unknown): { start: number; end: number; time: boolean } | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  const at = (s: string) => (parts.time ? ms(s) : dayNumber(s) * DAY_MS);
  return { start: at(parts.start), end: at(parts.end ?? parts.start), time: parts.time };
}

/** Minutes past midnight of an instant in `timeZone`. */
function minutesOfDay(iso: string, timeZone: string): number {
  const at = ms(iso);
  return Math.round((at - zonedInstant(localDay(at, timeZone), 0, timeZone)) / 60_000);
}

/** An instant moved by `days` calendar days, keeping its wall-clock time in `timeZone`. */
function shiftInstant(iso: string, days: number, timeZone: string): string {
  const day = instantDay(iso, timeZone);
  return new Date(zonedInstant(day + days, minutesOfDay(iso, timeZone), timeZone)).toISOString();
}

/**
 * A value moved by `days` days, both ends, kind kept: times stay the same on the clock in
 * `timeZone` (an event at 14:30 moved over a change of clocks is still at 14:30). Null stays null.
 */
export function shiftDateValue(value: unknown, days: number, timeZone: string = browserTimeZone()): string | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  if (!days) return dateValueString(parts);
  const move = (s: string) => (parts.time ? shiftInstant(s, days, timeZone) : dayString(dayNumber(s) + days));
  return dateValueString({ start: move(parts.start), end: parts.end === null ? null : move(parts.end), time: parts.time });
}

/**
 * A value laid over the days `span` (start and end day numbers in `timeZone`), keeping its kind and
 * times: the start moves to the span's first day and the end to its last. A one-day span of a day
 * value is a plain day; a value without an end only gets one when the span is longer than a day.
 */
export function setDateDays(value: unknown, span: DaySpan, timeZone: string = browserTimeZone()): string | null {
  const parts = parseDateValue(value);
  const days = dateDays(value, timeZone);
  if (!parts || !days) return dayString(span.start) + (span.end > span.start ? `/${dayString(span.end)}` : "");
  const start = shiftDateValue(parts.start, span.start - days.start, timeZone)!;
  if (!parts.time) return span.end > span.start ? `${start}/${dayString(span.end)}` : start;
  // Instants: the end keeps its time of day (or the start's, for a value that had no end).
  const endFrom = parts.end ?? parts.start;
  const endDay = dateDays(endFrom, timeZone)!.start;
  if (!parts.end && span.end === span.start) return start;
  let end = shiftDateValue(endFrom, span.end - endDay, timeZone)!;
  if (ms(end) < ms(start)) end = start;
  return `${start}/${end}`;
}

/** The value with `end` as its end (null drops it). Ends before the start, or of the other kind, give null. */
export function withDateEnd(value: unknown, end: string | null): string | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  if (end === null) return parts.start;
  const result = parseDateValue(`${parts.start}/${end}`);
  return result?.end ? dateValueString(result) : null;
}

/**
 * Formats a value for people, with `format` (Intl options in, text out: next-intl's dateTime or
 * an Intl.DateTimeFormat). Days print as days whatever the zone; instants in `timeZone`.
 * "Oct 12, 2026", "Oct 12 → Oct 14, 2026", "Oct 12, 2026, 14:30", "Oct 12, 2026, 14:30 → 16:00".
 * The locale decides the order of the parts and the 12- or 24-hour clock.
 */
export function formatDateValue(
  value: unknown,
  format: (date: Date, options: Intl.DateTimeFormatOptions) => string,
  timeZone: string,
): string | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  const date = (s: string) => (parts.time ? new Date(ms(s)) : new Date(dayNumber(s) * DAY_MS));
  const zone = parts.time ? timeZone : "UTC";
  const full: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", timeZone: zone };
  const clock: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: zone };
  const start = date(parts.start);
  if (!parts.time) {
    if (!parts.end) return format(start, full);
    const end = date(parts.end);
    const sameYear = parts.start.slice(0, 4) === parts.end.slice(0, 4);
    const first = sameYear ? format(start, { month: "short", day: "numeric", timeZone: zone }) : format(start, full);
    return `${first} → ${format(end, full)}`;
  }
  const first = format(start, { ...full, ...clock });
  if (!parts.end) return first;
  const end = date(parts.end);
  const sameDay = instantDay(parts.start, timeZone) === instantDay(parts.end, timeZone);
  return `${first} → ${format(end, sameDay ? clock : { ...full, ...clock })}`;
}

/** Text for a value in `locale` and `timeZone`, for places without next-intl (emails, exports). */
export function formatDateValueIn(value: unknown, locale: string, timeZone: string): string | null {
  return formatDateValue(value, (d, options) => new Intl.DateTimeFormat(locale, options).format(d), timeZone);
}
