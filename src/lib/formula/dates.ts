import { dateMillis } from "../date-value";
import { fail, type DateValue } from "./types";

/**
 * Date helpers for formulas. Everything works in UTC so the browser and the server always agree;
 * only `today()` looks at the local calendar day (like relative date filters do).
 */

const DAY = 24 * 60 * 60 * 1000;
const UNIT_MS = { weeks: 7 * DAY, days: DAY, hours: 60 * 60 * 1000, minutes: 60 * 1000, seconds: 1000 } as const;
export const DATE_UNITS = ["years", "quarters", "months", "weeks", "days", "hours", "minutes", "seconds"] as const;
export type DateUnit = (typeof DATE_UNITS)[number];

/** A unit name, singular or plural, any case; null when unknown. */
export function dateUnit(raw: string): DateUnit | null {
  const word = raw.trim().toLowerCase();
  const plural = word.endsWith("s") ? word : `${word}s`;
  return (DATE_UNITS as readonly string[]).includes(plural) ? (plural as DateUnit) : null;
}

export function requireUnit(raw: string): DateUnit {
  const unit = dateUnit(raw);
  if (!unit) fail("invalidUnit", `Unknown date unit "${raw}". Use one of: ${DATE_UNITS.join(", ")}`, { unit: raw, units: DATE_UNITS.join(", ") });
  return unit;
}

/**
 * A stored date (YYYY-MM-DD, a time or a range of either, see lib/date-value) or timestamp (ISO) as
 * a date value; null when it isn't one.
 */
export function toDateValue(value: unknown): DateValue | null {
  if (typeof value !== "string" || !value) return null;
  const millis = dateMillis(value);
  if (millis) {
    const ranged = value.includes("/");
    return ranged ? { date: millis.start, time: millis.time, end: millis.end } : { date: millis.start, time: millis.time };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(ms) ? null : { date: ms, time: false };
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  // Without a zone, JavaScript reads a timestamp as local time; formulas read it as UTC.
  const ms = Date.parse(/T[\d:.]+$/.test(value) ? `${value}Z` : value);
  return Number.isNaN(ms) ? null : { date: ms, time: true };
}

const pad = (n: number, size = 2) => String(Math.abs(n)).padStart(size, "0");

/** The stored form: YYYY-MM-DD for days, an ISO timestamp otherwise; a range as "start/end". */
export function storeDate(value: DateValue): string {
  const one = (ms: number) => (value.time ? new Date(ms).toISOString() : new Date(ms).toISOString().slice(0, 10));
  return value.end === undefined ? one(value.date) : `${one(value.date)}/${one(value.end)}`;
}

/** A range's start (any date as itself, without an end). */
export function dateStart(value: DateValue): DateValue {
  return { date: value.date, time: value.time };
}

/** A range's end: its last day or end time; a date without an end is its own end. */
export function dateEnd(value: DateValue): DateValue {
  return { date: value.end ?? value.date, time: value.time };
}

/** Today's calendar day where the formula runs, at midnight UTC. */
export function today(now: Date): DateValue {
  return { date: Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()), time: false };
}

function addMonths(ms: number, months: number) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Jan 31 + 1 month is the last day of February, not March 3.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

export function dateAdd(value: DateValue, amount: number, unit: DateUnit): DateValue {
  if (unit === "years" || unit === "quarters" || unit === "months") {
    const months = Math.trunc(amount) * (unit === "years" ? 12 : unit === "quarters" ? 3 : 1);
    return { date: addMonths(value.date, months), time: value.time };
  }
  const date = value.date + amount * UNIT_MS[unit];
  return { date, time: value.time || date % DAY !== 0 };
}

/** Whole months from `b` to `a`, rounded toward zero (a month counts once its day and time are reached). */
function monthsBetween(a: number, b: number) {
  const da = new Date(a);
  const db = new Date(b);
  let months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
  const restA = a - Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), 1);
  const restB = b - Date.UTC(db.getUTCFullYear(), db.getUTCMonth(), 1);
  if (months > 0 && restA < restB) months--;
  if (months < 0 && restA > restB) months++;
  return months;
}

/** `a - b` in whole units, rounded toward zero (dateBetween(end, start, "days")). */
export function dateBetween(a: DateValue, b: DateValue, unit: DateUnit): number {
  if (unit === "years" || unit === "quarters" || unit === "months") {
    const months = monthsBetween(a.date, b.date);
    return Math.trunc(months / (unit === "years" ? 12 : unit === "quarters" ? 3 : 1)) || 0;
  }
  return Math.trunc((a.date - b.date) / UNIT_MS[unit]) || 0;
}

export type DatePart = "year" | "month" | "day" | "weekday" | "hour" | "minute";

export function datePart(value: DateValue, part: DatePart): number {
  const d = new Date(value.date);
  switch (part) {
    case "year":
      return d.getUTCFullYear();
    case "month":
      return d.getUTCMonth() + 1;
    case "day":
      return d.getUTCDate();
    case "weekday":
      // ISO: Monday is 1, Sunday 7.
      return ((d.getUTCDay() + 6) % 7) + 1;
    case "hour":
      return d.getUTCHours();
    case "minute":
      return d.getUTCMinutes();
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g;

/**
 * Formats a date with tokens: YYYY YY, MMMM (January) MMM (Jan) MM M, DD D, dddd (Monday) ddd,
 * HH H (24h), hh h (12h) with A (AM/PM), mm, ss. Text in [brackets] is kept as is. Without a
 * format: YYYY-MM-DD, plus HH:mm for values with a time, and a range as "start → end". With one,
 * a range's start.
 */
export function formatDate(value: DateValue, format?: string): string {
  if (format === undefined && value.end !== undefined) return `${formatDate(dateStart(value))} → ${formatDate(dateEnd(value))}`;
  const d = new Date(value.date);
  const fmt = format ?? (value.time ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD");
  const h = d.getUTCHours();
  return fmt.replace(TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY":
        return pad(d.getUTCFullYear(), 4);
      case "YY":
        return pad(d.getUTCFullYear() % 100);
      case "MMMM":
        return MONTHS[d.getUTCMonth()];
      case "MMM":
        return MONTHS[d.getUTCMonth()].slice(0, 3);
      case "MM":
        return pad(d.getUTCMonth() + 1);
      case "M":
        return String(d.getUTCMonth() + 1);
      case "DD":
        return pad(d.getUTCDate());
      case "D":
        return String(d.getUTCDate());
      case "dddd":
        return WEEKDAYS[d.getUTCDay()];
      case "ddd":
        return WEEKDAYS[d.getUTCDay()].slice(0, 3);
      case "HH":
        return pad(h);
      case "H":
        return String(h);
      case "hh":
        return pad(h % 12 || 12);
      case "h":
        return String(h % 12 || 12);
      case "mm":
        return pad(d.getUTCMinutes());
      case "ss":
        return pad(d.getUTCSeconds());
      case "A":
        return h < 12 ? "AM" : "PM";
      default:
        return token;
    }
  });
}

/** Reads YYYY-MM-DD or an ISO timestamp; fails for anything else. */
export function parseDate(text: string): DateValue {
  const trimmed = text.trim();
  const value = toDateValue(trimmed) ?? (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(trimmed) ? toDateValue(trimmed.replace(" ", "T")) : null);
  if (!value) fail("invalidDate", `"${trimmed}" is not a date (use YYYY-MM-DD)`, { value: trimmed });
  return value;
}
