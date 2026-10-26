import type { JiraSyncError } from "./jira-sync";
import { dayNumber, dayString, isTimeZone, weekdayOf, zonedInstant, zoneOffset } from "./time-zone";

/**
 * Keeping a database in step with a calendar published as iCalendar (an .ics address: Google
 * Calendar's secret address, Outlook's published calendar, a booking tool's feed), one way
 * (server/ical-sync for setting it up, server/jira-sync/run for the runs every synced database
 * shares). Each event is a row, found again by its UID; each occurrence of a repeating event is a
 * row of its own, found by its UID and the time it was planned for. Pure, shared by the server,
 * the import dialog and the sync's dialog on the database.
 *
 * Events come from the address as text (RFC 5545): their summary is the row's title, and their
 * times, place, notes, status, organizer and link go to the properties the sync made
 * (IcalMapping), written over on each run. A run takes the events of ICAL_DAYS_BEFORE days back to
 * ICAL_DAYS_AFTER days ahead; rows of older events stay as they are.
 */

const DAY_MS = 86_400_000;

/** Days back from now a run takes events from (repeating ones are worked out in this window). */
export const ICAL_DAYS_BEFORE = 90;
/** Days ahead a run takes events to. */
export const ICAL_DAYS_AFTER = 365;
/** Events (occurrences of repeating ones counted one by one) a run takes at most. */
export const MAX_ICAL_EVENTS = 5000;
/** The biggest calendar file a run reads, in bytes. */
export const MAX_ICAL_BYTES = 10_000_000;

/** What a sync reads: the calendar's address (kept sealed: a private calendar's address is its key). */
export type IcalQuery = { url: string };

export const ICAL_STATUSES = ["confirmed", "tentative", "cancelled"] as const;
export type IcalStatus = (typeof ICAL_STATUSES)[number];

/** The properties a sync writes, by what each holds (their ids in the database), and its status options' names. */
export type IcalMapping = {
  /** Text: the event's UID (with the planned time, for an occurrence of a repeating event). */
  key: string;
  when?: string;
  location?: string;
  description?: string;
  status?: string;
  organizer?: string;
  link?: string;
  statuses: Record<IcalStatus, string>;
  /** The title of an event without one, in the language of whoever set the sync up. */
  untitled?: string;
};
export type IcalField = Exclude<keyof IcalMapping, "statuses" | "untitled">;

/** Names of the properties, options and views a new sync makes, in its maker's language. */
export type IcalNames = {
  key: string;
  when: string;
  location: string;
  description: string;
  status: string;
  organizer: string;
  link: string;
  untitled: string;
  calendar: string;
  statuses: Record<IcalStatus, string>;
};

export const ENGLISH_ICAL_NAMES: IcalNames = {
  key: "Event ID",
  when: "When",
  location: "Location",
  description: "Description",
  status: "Status",
  organizer: "Organizer",
  link: "Link",
  untitled: "Untitled event",
  calendar: "Calendar",
  statuses: { confirmed: "Confirmed", tentative: "Tentative", cancelled: "Cancelled" },
};

/**
 * Why a run didn't happen, in the codes every synced database uses (`lastError` is one column):
 * "unauthorized" / "forbidden" (the address asks for a sign-in, or refuses), "notFound" (nothing
 * there, or it isn't a calendar), "tooManyIssues" (more than MAX_ICAL_EVENTS events in the window,
 * or a file past MAX_ICAL_BYTES), "unreachable" and "failed" (passing), and "runAsGone",
 * "accessLost", "keyGone" as for Jira.
 */
export type IcalSyncError = Exclude<JiraSyncError, "badQuery">;
export type IcalErrorCode = IcalSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A sync as its dialog on the database shows it: the calendar's host only, never its address. */
export type IcalSyncView = {
  host: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: IcalSyncError | null;
  /** Full access to the database: may change it, sync it or stop it. */
  canManage: boolean;
};

/**
 * A calendar address as a sync fetches it: webcal:// is https, http stays http (the fetch allows it
 * on the usual web ports). Null for anything else.
 */
export function icalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^webcals?:\/\//i, "https://");
  if (!text || text.length > 2000) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// --- Reading the file -------------------------------------------------------------------------

type ContentLine = { name: string; params: Record<string, string>; value: string };
type Component = { type: string; lines: ContentLine[]; children: Component[] };

/** The text's content lines, folded lines joined (RFC 5545 3.1). */
function contentLines(text: string): ContentLine[] {
  const out: ContentLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    if (!raw.trim()) continue;
    // The value starts at the first colon outside a quoted parameter value.
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') quoted = !quoted;
      else if (raw[i] === ":" && !quoted) {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    const [name, ...paramParts] = splitOutsideQuotes(raw.slice(0, colon), ";");
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eq = part.indexOf("=");
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
    }
    out.push({ name: name.toUpperCase(), params, value: raw.slice(colon + 1) });
  }
  return out;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === separator && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The calendar's components, nested as BEGIN and END say. */
function components(lines: ContentLine[]): Component[] {
  const root: Component = { type: "ROOT", lines: [], children: [] };
  const stack = [root];
  for (const line of lines) {
    const top = stack[stack.length - 1];
    if (line.name === "BEGIN") {
      const child: Component = { type: line.value.trim().toUpperCase(), lines: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (line.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.lines.push(line);
  }
  return root.children;
}

/** A TEXT value as written (RFC 5545 3.3.11): \n, \, \; and \\ unescaped. */
function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const first = (c: Component, name: string) => c.lines.find((l) => l.name === name);
const text = (c: Component, name: string) => {
  const line = first(c, name);
  return line ? unescapeText(line.value).trim() : "";
};

/** Zone names Windows calendars write, for the zones most people use; others go by the calendar's zone. */
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "E. South America Standard Time": "America/Sao_Paulo",
};

/** Whether each zone name seen is one this runtime knows (asking takes a while; calendars repeat a few names). */
const knownZones = new Map<string, boolean>();

function zoneOf(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  const name = tzid.replace(/^\//, "").trim();
  let known = knownZones.get(name);
  if (known === undefined) {
    known = isTimeZone(name);
    if (knownZones.size < 1000) knownZones.set(name, known);
  }
  if (known) return name;
  return WINDOWS_ZONES[name] ?? fallback;
}

/** A point in an event: a whole day (a day number), or an instant (ms) with the zone its wall time is in. */
type When = { kind: "day"; day: number } | { kind: "time"; instant: number; zone: string; day: number; minutes: number };

/** The instant of a wall time in a zone, as zonedInstant works it out. */
type Zoned = (day: number, minutes: number, zone: string) => number;

/**
 * zonedInstant for one reading of a calendar, with each zone's offset looked up once a day: a
 * calendar's repeating events ask for the same days again and again, and every lookup is slow.
 * On a day whose zone keeps one offset from the day before to the day after (so the clocks don't
 * change near any time of it) the instant follows from that offset; around a change, zonedInstant.
 */
function zonedMemo(): Zoned {
  const steady = new Map<string, number | null>();
  return (day, minutes, zone) => {
    const key = `${zone} ${day}`;
    let offset = steady.get(key);
    if (offset === undefined) {
      const offsets = [day - 1, day, day + 1, day + 2].map((d) => zoneOffset(d * DAY_MS, zone));
      offset = offsets.every((o) => o === offsets[0]) ? offsets[0] : null;
      steady.set(key, offset);
    }
    return offset === null ? zonedInstant(day, minutes, zone) : day * DAY_MS + minutes * 60_000 - offset;
  };
}

/** A DATE or DATE-TIME value (RFC 5545 3.3.4, 3.3.5) in `zone` when it names none. */
function parseWhen(line: ContentLine | undefined, zone: string, zoned: Zoned = zonedInstant): When | null {
  if (!line) return null;
  const value = line.value.trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day || line.params.VALUE === "DATE") {
    const m = day ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    return m ? { kind: "day", day: dayNumber(`${m[1]}-${m[2]}-${m[3]}`) } : null;
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time) return null;
  const d = dayNumber(`${time[1]}-${time[2]}-${time[3]}`);
  const minutes = Number(time[4]) * 60 + Number(time[5]);
  const seconds = Number(time[6]);
  if (time[7]) return { kind: "time", instant: d * DAY_MS + minutes * 60_000 + seconds * 1000, zone: "UTC", day: d, minutes };
  const in_ = zoneOf(line.params.TZID, zone);
  return { kind: "time", instant: zoned(d, minutes, in_) + seconds * 1000, zone: in_, day: d, minutes };
}

/** A DURATION value (RFC 5545 3.3.6) in ms; null when it isn't one. */
function parseDuration(value: string | undefined): number | null {
  const m = value && /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 * 3600 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** Where a time is on its zone's clock: shifted by whole days, the same wall time (DST aside). */
function shift(start: When, day: number, zoned: Zoned): When {
  if (start.kind === "day") return { kind: "day", day };
  if (start.zone === "UTC") return { ...start, day, instant: start.instant + (day - start.day) * DAY_MS };
  const seconds = Math.round(start.instant / 1000) % 60;
  return { ...start, day, instant: zoned(day, start.minutes, start.zone) + seconds * 1000 };
}

const startMs = (w: When) => (w.kind === "day" ? w.day * DAY_MS : w.instant);

// --- Repeating events ---------------------------------------------------------------------------

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: number | null;
  byDay: { weekday: number; nth: number }[];
  byMonthDay: number[];
  byMonth: number[];
};

function parseRule(value: string, zone: string, zoned: Zoned): Rule | null {
  const parts = Object.fromEntries(
    value
      .split(";")
      .map((p) => p.split("="))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v]),
  );
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const until = parts.UNTIL ? parseWhen({ name: "UNTIL", params: {}, value: parts.UNTIL }, zone, zoned) : null;
  const byDay = (parts.BYDAY ?? "")
    .split(",")
    .filter(Boolean)
    .flatMap((d: string) => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
      return m ? [{ weekday: WEEKDAYS.indexOf(m[2].toUpperCase()), nth: m[1] ? Number(m[1]) : 0 }] : [];
    });
  const numbers = (v: string | undefined) => (v ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    count: parts.COUNT ? Math.max(0, Number(parts.COUNT) || 0) : null,
    // UNTIL is inclusive; a day counts to its end.
    until: until ? (until.kind === "day" ? (until.day + 1) * DAY_MS - 1 : until.instant) : null,
    byDay,
    byMonthDay: numbers(parts.BYMONTHDAY),
    byMonth: numbers(parts.BYMONTH).filter((n) => n >= 1 && n <= 12),
  };
}

/** Days of a month (year, month 0–11) a monthly or yearly rule takes, in order. */
function daysInMonth(year: number, month: number, rule: Rule, startDay: number): number[] {
  const firstDay = Date.UTC(year, month, 1) / DAY_MS;
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Set<number>();
  if (rule.byDay.length) {
    for (const { weekday, nth } of rule.byDay) {
      const matching: number[] = [];
      for (let d = 0; d < length; d++) if (weekdayOf(firstDay + d) === weekday) matching.push(firstDay + d);
      if (nth === 0) matching.forEach((d) => out.add(d));
      else {
        const pick = nth > 0 ? matching[nth - 1] : matching[matching.length + nth];
        if (pick !== undefined) out.add(pick);
      }
    }
  } else if (rule.byMonthDay.length) {
    for (const n of rule.byMonthDay) {
      const d = n > 0 ? n : length + n + 1;
      if (d >= 1 && d <= length) out.add(firstDay + d - 1);
    }
  } else {
    // The start's day of the month; months without it are skipped (RFC 5545 3.3.10).
    const d = new Date(startDay * DAY_MS).getUTCDate();
    if (d <= length) out.add(firstDay + d - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Periods a rule's COUNT is counted through before the days asked for; a rule still running after more has ended. */
const MAX_COUNTED_PERIODS = 10_000;

/**
 * The days from `from` to `to` (day numbers) a rule repeats on, its first occurrence being
 * `start`, in order, until its COUNT or its UNTIL: at most `limit`, only those `wanted` when it is
 * given. The periods (days, weeks, months, years) that end before `from` are jumped over, and
 * counted for COUNT without any time zone lookup, so a rule that started years ago costs no more
 * than a new one.
 */
function ruleDays(rule: Rule, start: When, from: number, to: number, limit: number, zoned: Zoned, wanted?: Set<number>): number[] {
  const out: number[] = [];
  const first = start.day;
  const date = new Date(first * DAY_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  // Weeks start on Monday (WKST's default).
  const monday = first - ((weekdayOf(first) + 6) % 7);
  const weekdays = [...new Set(rule.byDay.length ? rule.byDay.map((d) => d.weekday) : [weekdayOf(first)])];
  /** The days of the rule's `step`th period, the one of its start being the 0th. */
  const period = (step: number): number[] => {
    if (rule.freq === "DAILY") return [first + step * rule.interval];
    if (rule.freq === "WEEKLY") return weekdays.map((w) => monday + step * 7 * rule.interval + ((w + 6) % 7)).sort((a, b) => a - b);
    if (rule.freq === "MONTHLY") {
      const index = month + step * rule.interval;
      return rule.byMonth.length && !rule.byMonth.includes((index % 12) + 1) ? [] : daysInMonth(year + Math.floor(index / 12), index % 12, rule, first);
    }
    const months = rule.byMonth.length ? rule.byMonth.map((m) => m - 1) : [month];
    return months.flatMap((m) => daysInMonth(year + step * rule.interval, m, rule, first));
  };
  /** The first day of the `step`th period. */
  const periodStart = (step: number): number => {
    if (rule.freq === "DAILY") return first + step * rule.interval;
    if (rule.freq === "WEEKLY") return monday + step * 7 * rule.interval;
    if (rule.freq === "MONTHLY") {
      const index = month + step * rule.interval;
      return Date.UTC(year + Math.floor(index / 12), index % 12, 1) / DAY_MS;
    }
    return Date.UTC(year + step * rule.interval, 0, 1) / DAY_MS;
  };

  // The first period that can hold `from`: every one before it ends before `from`.
  let step = 0;
  if (from > first) {
    const target = new Date(from * DAY_MS);
    const span =
      rule.freq === "DAILY"
        ? from - first
        : rule.freq === "WEEKLY"
          ? Math.floor((from - monday) / 7)
          : rule.freq === "MONTHLY"
            ? (target.getUTCFullYear() - year) * 12 + target.getUTCMonth() - month
            : target.getUTCFullYear() - year;
    step = Math.floor(span / rule.interval);
  }
  // COUNT counts the occurrences in the periods jumped over too.
  let counted = 0;
  if (rule.count !== null && step > 0) {
    if (rule.freq === "DAILY") counted = step;
    else if (rule.freq === "WEEKLY") counted = period(0).filter((d) => d >= first).length + (step - 1) * weekdays.length;
    else {
      if (step > MAX_COUNTED_PERIODS) return out;
      for (let s = 0; s < step && counted < rule.count; s++) counted += period(s).filter((d) => d >= first).length;
    }
  }
  for (; periodStart(step) <= to; step++) {
    for (const day of period(step)) {
      if (day < first) continue;
      if (rule.count !== null && counted >= rule.count) return out;
      if (day > to) return out;
      counted++;
      if (day < from || (wanted && !wanted.has(day))) continue;
      // Only the days asked for are put on their zone's clock (to compare with UNTIL).
      if (rule.until !== null && startMs(shift(start, day, zoned)) > rule.until) return out;
      out.push(day);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// --- Events as rows ------------------------------------------------------------------------------

/** One event (or occurrence) as a row: what the sync writes, before it is matched to the database's properties. */
export type IcalRow = {
  key: string;
  title: string;
  /** A day, a day range, a time or a time range, as a date property takes it ("start/end"). */
  when: string;
  location: string;
  description: string;
  status: IcalStatus | null;
  organizer: string;
  link: string | null;
  /** When it starts (ms), to keep the nearest when there are too many. */
  start: number;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The date property's value from an event's start and end (end exclusive for whole days). */
function whenValue(start: When, end: When | null, length: number | null): string {
  if (start.kind === "day") {
    const last =
      end?.kind === "day" ? end.day - 1 : length !== null ? start.day + Math.max(0, Math.ceil(length / DAY_MS) - 1) : start.day;
    return last > start.day ? `${dayString(start.day)}/${dayString(last)}` : dayString(start.day);
  }
  const finish = end && end.kind === "time" ? end.instant : length !== null ? start.instant + length : start.instant;
  return finish > start.instant ? `${iso(start.instant)}/${iso(finish)}` : iso(start.instant);
}

function statusOf(value: string): IcalStatus | null {
  const s = value.toLowerCase();
  return (ICAL_STATUSES as readonly string[]).includes(s) ? (s as IcalStatus) : null;
}

function organizerOf(c: Component): string {
  const line = first(c, "ORGANIZER");
  if (!line) return "";
  const email = line.value.replace(/^mailto:/i, "").trim();
  const name = line.params.CN?.trim();
  return name && email && name !== email ? `${name} <${email}>` : name || email;
}

function linkOf(c: Component): string | null {
  const url = text(c, "URL");
  return /^https?:\/\//i.test(url) ? url : null;
}

/** An occurrence's key part: the time (or day) it was planned for. */
const plannedKey = (w: When) => (w.kind === "day" ? dayString(w.day) : iso(w.instant));

export type IcalCalendar = { name: string; rows: IcalRow[]; tooMany: boolean };

/**
 * The calendar's events from `now` less ICAL_DAYS_BEFORE days to ICAL_DAYS_AFTER days ahead as
 * rows, repeating ones worked out (RRULE with DAILY, WEEKLY, MONTHLY and YEARLY, INTERVAL, COUNT,
 * UNTIL, BYDAY, BYMONTHDAY and BYMONTH; EXDATE; occurrences moved or cancelled by RECURRENCE-ID).
 * Null when the text isn't a calendar. `tooMany`: more than MAX_ICAL_EVENTS were found.
 */
export function readCalendar(source: string, now: number, untitled = ENGLISH_ICAL_NAMES.untitled): IcalCalendar | null {
  const calendar = components(contentLines(source)).find((c) => c.type === "VCALENDAR");
  if (!calendar) return null;
  const zone = zoneOf(text(calendar, "X-WR-TIMEZONE") || undefined, "UTC");
  const windowStart = now - ICAL_DAYS_BEFORE * DAY_MS;
  const windowEnd = now + ICAL_DAYS_AFTER * DAY_MS;
  const events = calendar.children.filter((c) => c.type === "VEVENT");
  const zoned = zonedMemo();
  // Moved or cancelled occurrences, by UID and the time they were planned for; and, by UID, the
  // days of occurrences moved to a time that may be in the window (planned for any day).
  const overrides = new Map<string, Component>();
  const movedIn = new Map<string, Set<number>>();
  for (const event of events) {
    const recurrence = parseWhen(first(event, "RECURRENCE-ID"), zone, zoned);
    if (!recurrence) continue;
    const uid = text(event, "UID");
    overrides.set(`${uid}/${plannedKey(recurrence)}`, event);
    const moved = parseWhen(first(event, "DTSTART"), zone, zoned);
    if (!moved || startMs(moved) > windowEnd) continue;
    const movedEnd = parseWhen(first(event, "DTEND"), zone, zoned);
    // Without an end of its own it lasts as long as the event, not known yet.
    const length = movedEnd ? startMs(movedEnd) - startMs(moved) : parseDuration(first(event, "DURATION")?.value);
    if (length !== null && startMs(moved) + Math.max(0, length) < windowStart) continue;
    // A day either side: the planned time may be written in another zone than the event's.
    const days = movedIn.get(uid) ?? new Set<number>();
    for (const day of [recurrence.day - 1, recurrence.day, recurrence.day + 1]) days.add(day);
    movedIn.set(uid, days);
  }

  const rows: IcalRow[] = [];
  const row = (event: Component, key: string, start: When, end: When | null, length: number | null): IcalRow => ({
    key,
    title: text(event, "SUMMARY") || untitled,
    when: whenValue(start, end, length),
    location: text(event, "LOCATION"),
    description: text(event, "DESCRIPTION"),
    status: statusOf(text(event, "STATUS")),
    organizer: organizerOf(event),
    link: linkOf(event),
    start: startMs(start),
  });
  const inWindow = (start: When, finish: number) => finish >= windowStart && startMs(start) <= windowEnd;

  events: for (const event of events) {
    // Past MAX_ICAL_EVENTS the run stops anyway: the rest needn't be worked out.
    if (rows.length > MAX_ICAL_EVENTS) break;
    if (first(event, "RECURRENCE-ID")) continue;
    const uid = text(event, "UID");
    const start = parseWhen(first(event, "DTSTART"), zone, zoned);
    if (!uid || !start) continue;
    const end = parseWhen(first(event, "DTEND"), zone, zoned);
    const length = end ? startMs(end) - startMs(start) : parseDuration(first(event, "DURATION")?.value);
    const rruleLine = first(event, "RRULE");
    const rule = rruleLine ? parseRule(rruleLine.value, zone, zoned) : null;
    if (!rule) {
      if (inWindow(start, startMs(start) + Math.max(0, length ?? 0))) rows.push(row(event, uid, start, end, length));
      continue;
    }
    const excluded = new Set(
      event.lines
        .filter((l) => l.name === "EXDATE")
        .flatMap((l) => l.value.split(",").map((value) => parseWhen({ ...l, value }, zone, zoned)))
        .flatMap((w) => (w ? [plannedKey(w)] : [])),
    );
    // The days whose occurrences can reach into the window (with a day either side for the zones),
    // and those around each occurrence planned before them but moved into it.
    const firstDay = Math.floor((windowStart - Math.max(0, length ?? 0)) / DAY_MS) - 2;
    const lastDay = Math.floor(windowEnd / DAY_MS);
    const days = new Set(ruleDays(rule, start, firstDay, lastDay, MAX_ICAL_EVENTS * 4, zoned));
    const movedDays = movedIn.get(uid);
    let movedFrom = firstDay;
    for (const day of movedDays ?? []) movedFrom = Math.min(movedFrom, day);
    if (movedDays && movedFrom < firstDay) for (const day of ruleDays(rule, start, movedFrom, firstDay - 1, movedDays.size, zoned, movedDays)) days.add(day);
    for (const day of [...days].sort((a, b) => a - b)) {
      if (rows.length > MAX_ICAL_EVENTS) break events;
      const planned = shift(start, day, zoned);
      const plannedAt = plannedKey(planned);
      if (excluded.has(plannedAt)) continue;
      const key = `${uid}/${plannedAt}`;
      const moved = overrides.get(key);
      if (moved) {
        if (statusOf(text(moved, "STATUS")) === "cancelled") continue;
        const movedStart = parseWhen(first(moved, "DTSTART"), zone, zoned) ?? planned;
        const movedEnd = parseWhen(first(moved, "DTEND"), zone, zoned);
        const movedLength = movedEnd ? startMs(movedEnd) - startMs(movedStart) : (parseDuration(first(moved, "DURATION")?.value) ?? length);
        if (inWindow(movedStart, startMs(movedStart) + Math.max(0, movedLength ?? 0))) rows.push(row(moved, key, movedStart, movedEnd, movedLength));
        continue;
      }
      if (!inWindow(planned, startMs(planned) + Math.max(0, length ?? 0))) continue;
      rows.push(row(event, key, planned, null, length));
    }
  }
  rows.sort((a, b) => a.start - b.start);
  return { name: text(calendar, "X-WR-CALNAME"), rows: rows.slice(0, MAX_ICAL_EVENTS), tooMany: rows.length > MAX_ICAL_EVENTS };
}

/** A row's values for the properties the sync writes, as normalizeRowProperties takes them. */
export function icalValues(row: IcalRow, mapping: Partial<IcalMapping> & { statuses: Record<IcalStatus, string> }) {
  const values: Record<string, unknown> = {};
  if (mapping.key) values[mapping.key] = row.key;
  if (mapping.when) values[mapping.when] = row.when;
  if (mapping.location) values[mapping.location] = row.location || null;
  if (mapping.description) values[mapping.description] = row.description || null;
  if (mapping.status) values[mapping.status] = row.status ? mapping.statuses[row.status] : null;
  if (mapping.organizer) values[mapping.organizer] = row.organizer || null;
  if (mapping.link) values[mapping.link] = row.link;
  return values;
}
