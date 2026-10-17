import { isDay } from "./date-value";
import { browserTimeZone, dayNumber, dayString, isTimeZone, localDay } from "./time-zone";

/**
 * Daily notes (see server/journal.ts): one page per person, workspace and calendar day, the day
 * written `YYYY-MM-DD` in the person's own time zone. Pure and client-safe.
 */

export { isDay };

/** The calendar day it is now in `timeZone` (the browser's when missing; UTC when it isn't one). */
export function today(timeZone: string = browserTimeZone(), now = Date.now()): string {
  return dayString(localDay(now, isTimeZone(timeZone) ? timeZone : "UTC"));
}

/** The day `days` after (or before, when negative) `day`. */
export const addDays = (day: string, days: number) => dayString(dayNumber(day) + days);

/** A daily note's title: its day as a long date in `locale` ("October 17, 2026"). */
export function dailyNoteTitle(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(date);
  }
}

/**
 * A daily note's place among its journal's pages: the later the day, the higher it is listed, and
 * above the pages added there by hand (which take positions from 1 up).
 */
export const dailyNotePosition = (day: string) => -dayNumber(day);

/** The first and last day of the month `day` falls in. */
export function monthOf(day: string): { first: string; last: string } {
  const [y, m] = day.split("-").map(Number);
  const first = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
  return { first, last: addDays(next, -1) };
}
