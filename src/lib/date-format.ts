import type { DateFormatKind } from "@/db/schema/app";
import { parseDateValue } from "./date-value";
import { dayNumber, localDay } from "./time-zone";

/**
 * Dates shown in the format a date property (or a created or last edited time) chooses: the day as
 * "October 24, 2026" ("full"), "10/24/2026" ("short", in the viewer's language), or numerically in
 * a fixed order ("mdy", "dmy", "ymd", always with "/"), and times on a 12- or 24-hour clock. The
 * words and digits are the viewer's language's. Only how values show: stored values, exports, CSV
 * and MCP keep ISO dates. Pure and client-safe.
 */

export type DateStyle = { format?: DateFormatKind; clock?: "12h" | "24h" };

/** Intl options in, text out: next-intl's dateTime, or an Intl.DateTimeFormat's format. */
export type DateFormatter = (date: Date, options: DayFormatOptions) => string;
export type DayFormatOptions = Pick<Intl.DateTimeFormatOptions, "year" | "month" | "day" | "hour" | "minute" | "timeZone" | "hourCycle">;

const DAY_MS = 86_400_000;
const ORDER: Record<"mdy" | "dmy" | "ymd", ("year" | "month" | "day")[]> = {
  mdy: ["month", "day", "year"],
  dmy: ["day", "month", "year"],
  ymd: ["year", "month", "day"],
};

/** Whether a style changes anything (an empty one leaves dates as the locale writes them). */
export const isStyled = (style: DateStyle | null | undefined): style is DateStyle => Boolean(style?.format || style?.clock);

/** A day (a Date at its start) in `timeZone` as the style writes it. */
export function formatDay(format: DateFormatter, date: Date, kind: DateFormatKind | undefined, timeZone: string): string {
  if (kind === "mdy" || kind === "dmy" || kind === "ymd") {
    return ORDER[kind].map((part) => format(date, { [part]: part === "year" ? "numeric" : "2-digit", timeZone })).join("/");
  }
  if (kind === "full") return format(date, { year: "numeric", month: "long", day: "numeric", timeZone });
  if (kind === "short") return format(date, { year: "numeric", month: "numeric", day: "numeric", timeZone });
  return format(date, { year: "numeric", month: "short", day: "numeric", timeZone });
}

/** A time of day on the style's clock (the locale's without one). */
export function formatClock(format: DateFormatter, date: Date, clock: DateStyle["clock"], timeZone: string): string {
  return format(date, { hour: "numeric", minute: "2-digit", timeZone, ...(clock ? { hourCycle: clock === "12h" ? "h12" : "h23" } : {}) });
}

/**
 * A stored date value (a day, an instant or a range of either, see lib/date-value) as the style
 * writes it: "24/10/2026", "24/10/2026, 14:30", "October 24, 2026 → October 26, 2026". Days print
 * as days whatever the zone; instants in `timeZone`. Null for anything that isn't a date.
 */
export function formatStyledDate(value: unknown, format: DateFormatter, timeZone: string, style: DateStyle): string | null {
  const parts = parseDateValue(value);
  if (!parts) return null;
  const zone = parts.time ? timeZone : "UTC";
  const date = (s: string) => (parts.time ? new Date(Date.parse(s)) : new Date(dayNumber(s) * DAY_MS));
  const at = (d: Date) => {
    const day = formatDay(format, d, style.format, zone);
    return parts.time ? `${day}, ${formatClock(format, d, style.clock, zone)}` : day;
  };
  const start = date(parts.start);
  if (!parts.end) return at(start);
  const end = date(parts.end);
  const sameDay = parts.time && localDay(start.getTime(), timeZone) === localDay(end.getTime(), timeZone);
  return `${at(start)} → ${sameDay ? formatClock(format, end, style.clock, zone) : at(end)}`;
}

/** formatStyledDate for places without next-intl, in `locale`. */
export function formatStyledDateIn(value: unknown, locale: string, timeZone: string, style: DateStyle): string | null {
  return formatStyledDate(value, (d, options) => new Intl.DateTimeFormat(locale, options).format(d), timeZone, style);
}
