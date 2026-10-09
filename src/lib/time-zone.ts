/**
 * Wall-clock time in IANA time zones, without a date library: the zone's offset comes from
 * `Intl.DateTimeFormat`, which knows each zone's daylight saving rules.
 */

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Whether `value` names a time zone this runtime knows (an IANA name such as "Europe/Istanbul"). */
/** The browser's time zone, UTC when it can't say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function zoneOffset(instant: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - Math.floor(instant / 1000) * 1000;
}

/** A calendar day as a number of days since 1970-01-01 ("2026-10-07" → 20733). */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** The calendar day of a day number, as "YYYY-MM-DD". */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day (YYYY-MM-DD) a timestamp falls on in `timeZone`; null for what is no time. */
export function timestampDay(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const instant = new Date(value).getTime();
  return Number.isNaN(instant) ? null : dayString(localDay(instant, timeZone));
}

/** The weekday of a day number: 0 for Sunday … 6 for Saturday (1970-01-01, day 0, was a Thursday). */
export const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;

/**
 * The day number of `day` of a month counted from January of year 0 (`year * 12 + month`, January
 * being month 0), clamped to the month's length (the 31st of April is the 30th).
 */
export function monthDay(monthIndex: number, day: number): number {
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, length)) / DAY_MS;
}

/** The calendar day (as a day number) that `instant` falls on in `timeZone`. */
export function localDay(instant: number, timeZone: string): number {
  return Math.floor((instant + zoneOffset(instant, timeZone)) / DAY_MS);
}

/**
 * The instant a wall-clock time happens in `timeZone`: `day` (a day number) at `minutes` past
 * midnight. A time the clocks skip (the hour lost when daylight saving starts) moves forward by
 * the change; a time that happens twice (when it ends) is the first one.
 */
export function zonedInstant(day: number, minutes: number, timeZone: string): number {
  const local = day * DAY_MS + minutes * 60_000;
  // The offsets just before and after this time cover any change of clocks near it.
  const before = zoneOffset(local - DAY_MS / 2, timeZone);
  const after = zoneOffset(local + DAY_MS / 2, timeZone);
  const matches = [local - before, local - after].filter((instant) => instant + zoneOffset(instant, timeZone) === local);
  if (matches.length) return Math.min(...matches);
  return local - before;
}

/**
 * Zones that runtimes still list (and resolve to) under a name that has since changed. The stored
 * value stays the listed one, which every runtime knows; forms show the current name.
 */
const RENAMED_ZONES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** A zone's name for people to read: its current name, with spaces ("Asia/Ho Chi Minh"). */
export function timeZoneLabel(timeZone: string): string {
  return (RENAMED_ZONES[timeZone] ?? timeZone).replaceAll("_", " ");
}

/**
 * The zones this runtime knows, as the names it lists, in the order of their labels. `current`
 * is kept, as the listed name when it is another name of a listed zone ("Europe/Kyiv" →
 * "Europe/Kiev").
 */
export function listTimeZones(current: string): { zones: string[]; current: string } {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  let listed = current;
  if (!zones.includes(current) && isTimeZone(current)) {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: current }).resolvedOptions().timeZone;
    if (zones.includes(resolved)) listed = resolved;
  }
  const all = zones.includes(listed) ? zones : [listed, ...zones];
  const labels = new Map(all.map((zone) => [zone, timeZoneLabel(zone)]));
  return { zones: [...all].sort((a, b) => labels.get(a)!.localeCompare(labels.get(b)!)), current: listed };
}
