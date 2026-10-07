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
