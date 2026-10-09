import type { PropertyType, TimelineZoom } from "@/db/schema/app";
import { localDay } from "./properties";
import { holdsTimestamp } from "./property-types";
import { timestampDay } from "./time-zone";

/**
 * Date math for timeline views. Days are whole numbers counted from 1970-01-01 (UTC), so a date
 * value (`YYYY-MM-DD`) maps to exactly one number whatever the viewer's time zone, and moving a
 * bar is plain addition. Weeks start on Monday.
 */

const MS_PER_DAY = 86_400_000;

/** Pixels one day takes at each zoom level: a column is a day, a week or a month. */
export const DAY_WIDTH: Record<TimelineZoom, number> = { day: 40, week: 20, month: 4 };

/**
 * The widest range a timeline lays out at each zoom (about two, five and twenty years). Bars
 * outside it are clipped at the edge; everything is still reachable by zooming out.
 */
export const MAX_RANGE_DAYS: Record<TimelineZoom, number> = { day: 730, week: 1830, month: 7300 };

/** Empty space kept before the first and after the last bar (and today). */
const PADDING_DAYS: Record<TimelineZoom, number> = { day: 14, week: 42, month: 180 };

export type DaySpan = { start: number; end: number };

/** The day number of a `YYYY-MM-DD` value (anything after the date is ignored), or null. */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const time = Date.UTC(year, month - 1, day);
  const d = new Date(time);
  // Rejects overflowing dates such as 2026-02-30.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return Math.floor(time / MS_PER_DAY);
}

/** The `YYYY-MM-DD` value of a day number. */
export function dayValue(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The UTC date of a day number, for formatting with `timeZone: "UTC"`. */
export function dayDate(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

/** The Monday on or before a day. 1970-01-01 was a Thursday. */
export function weekStart(day: number): number {
  return day - (((day + 3) % 7) + 7) % 7;
}

/** The first day of the day's month. */
export function monthStart(day: number): number {
  const d = dayDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_PER_DAY);
}

/** The first day of the month `months` after the day's month (negative goes back). */
export function addMonths(day: number, months: number): number {
  const d = dayDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1) / MS_PER_DAY);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** First day of the unit (column) a day falls in at a zoom level. */
export function unitStart(day: number, zoom: TimelineZoom): number {
  if (zoom === "day") return day;
  if (zoom === "week") return weekStart(day);
  return monthStart(day);
}

/** First day of the unit after the one a day falls in. */
export function nextUnit(day: number, zoom: TimelineZoom): number {
  if (zoom === "day") return day + 1;
  if (zoom === "week") return weekStart(day) + 7;
  return addMonths(day, 1);
}

/**
 * The day a start or end value falls on. Dates are days already; created and edited times are
 * instants, placed on their day in the viewer's `timeZone` (the browser's when left out).
 */
export function valueDay(value: unknown, type: PropertyType, timeZone?: string): number | null {
  if (holdsTimestamp(type)) return dayNumber(timeZone ? timestampDay(value, timeZone) : localDay(value));
  return type === "date" ? dayNumber(value) : null;
}

/**
 * Where a row's bar goes: from its start value to its end value. Without an end (or with an end
 * before the start) the bar covers the start day only; without a start the row has no bar.
 */
export function rowSpan(
  properties: Record<string, unknown>,
  start: { id: string; type: PropertyType },
  end?: { id: string; type: PropertyType } | null,
  timeZone?: string,
): DaySpan | null {
  const from = valueDay(properties[start.id], start.type, timeZone);
  if (from === null) return null;
  const to = end ? valueDay(properties[end.id], end.type, timeZone) : null;
  return { start: from, end: to !== null && to >= from ? to : from };
}

/**
 * The days a timeline lays out: every bar and today with some room around them, widened to whole
 * columns. When that is wider than the zoom allows, the range is centred on `focus` instead.
 */
export function timelineRange(spans: DaySpan[], focus: number, zoom: TimelineZoom): DaySpan {
  let start = focus;
  let end = focus;
  for (const s of spans) {
    if (s.start < start) start = s.start;
    if (s.end > end) end = s.end;
  }
  start -= PADDING_DAYS[zoom];
  end += PADDING_DAYS[zoom];
  if (end - start + 1 > MAX_RANGE_DAYS[zoom]) {
    start = focus - Math.floor(MAX_RANGE_DAYS[zoom] / 2);
    end = start + MAX_RANGE_DAYS[zoom] - 1;
  }
  return { start: unitStart(start, zoom), end: nextUnit(end, zoom) - 1 };
}

export type TimelineUnit = { start: number; days: number };

/** Consecutive units covering the range, cut at its edges. */
function unitsOf(range: DaySpan, next: (day: number) => number): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  for (let day = range.start; day <= range.end; ) {
    const end = Math.min(next(day), range.end + 1);
    units.push({ start: day, days: end - day });
    day = end;
  }
  return units;
}

/**
 * The two header rows: the columns (days, weeks or months) and above them what they belong to
 * (months, or years for month columns).
 */
export function headerUnits(range: DaySpan, zoom: TimelineZoom): { top: TimelineUnit[]; columns: TimelineUnit[] } {
  const columns = unitsOf(range, (day) => nextUnit(day, zoom));
  const top =
    zoom === "month"
      ? unitsOf(range, (day) => {
          const d = dayDate(day);
          return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / MS_PER_DAY);
        })
      : unitsOf(range, (day) => addMonths(day, 1));
  return { top, columns };
}

/** Horizontal position of a day's left edge. */
export function dayX(day: number, range: DaySpan, zoom: TimelineZoom): number {
  return (day - range.start) * DAY_WIDTH[zoom];
}

/** The day under a horizontal position. */
export function dayAtX(x: number, range: DaySpan, zoom: TimelineZoom): number {
  return range.start + Math.floor(x / DAY_WIDTH[zoom]);
}

/** Whole days a drag of `dx` pixels moves by (half a day or more rounds away from zero). */
export function dragDays(dx: number, zoom: TimelineZoom): number {
  const days = dx / DAY_WIDTH[zoom];
  return Math.sign(days) * Math.round(Math.abs(days));
}

export type DragMode = "move" | "start" | "end";

/**
 * A bar after dragging it: moving keeps its length; dragging an edge moves only that edge and
 * never past the other one (the shortest bar is one day).
 */
export function dragSpan(span: DaySpan, mode: DragMode, days: number): DaySpan {
  if (mode === "move") return { start: span.start + days, end: span.end + days };
  if (mode === "start") return { start: Math.min(span.start + days, span.end), end: span.end };
  return { start: span.start, end: Math.max(span.end + days, span.start) };
}

/**
 * The values to write after a drag, keyed by property id. The start is written when it moved; the
 * end when there is an end property and it changed. A row that had no end only gets one once
 * its bar is longer than a day, so moving a one-day bar keeps it a plain date.
 */
export function spanValues(
  before: DaySpan,
  after: DaySpan,
  startId: string,
  end: { id: string; hasValue: boolean } | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (after.start !== before.start) out[startId] = dayValue(after.start);
  if (end && (end.hasValue ? after.end !== before.end : after.end !== after.start)) out[end.id] = dayValue(after.end);
  return out;
}
