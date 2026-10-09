import type { DateOptions, DateReminder } from "@/db/schema/app";
import { dayNumber, isTimeZone, localDay, zonedInstant } from "@/lib/time-zone";

/**
 * Options of date properties: showing days near today relatively ("tomorrow", "in 3 days") and
 * reminding the row's people before the date (see server/date-reminders). A date property holds a
 * day ("2026-10-16"), so a reminder goes at a time of day: 9:00 in the zone of whoever set it.
 * Pure and client-safe.
 */

export type { DateOptions, DateReminder };

/** How many days before the date a reminder can go: on the day, the day before, two days, a week. */
export const REMINDER_DAYS = [0, 1, 2, 7] as const;
/** Reminders go at 9:00. */
const REMINDER_MINUTES = 9 * 60;
/** Relative display: days this close to today read relatively ("in 6 days"), farther ones as dates. */
const RELATIVE_DAYS = 6;

/** What the app or MCP asks for: the display, and the reminder's days before (null: none). */
export type DateOptionsInput = { display?: "date" | "relative"; reminderDays?: number | null; timeZone?: string };

/**
 * Checks date options given by the app or MCP against the property's current ones and returns
 * them as stored (null when there is nothing to store). Missing fields keep what is there; the
 * zone goes with the reminder's days (UTC without one). A reminder keeps its `since` while its
 * days and zone stay the same; a new or changed one starts now.
 */
export function checkDateOptions(
  input: DateOptionsInput,
  current: DateOptions | undefined,
  now: Date,
): { ok: true; options: DateOptions | null } | { ok: false; message: string } {
  if (input.display !== undefined && input.display !== "date" && input.display !== "relative") {
    return { ok: false, message: 'A date display is "date" or "relative"' };
  }
  // A zone on its own moves the reminder there, keeping its days.
  const days = input.reminderDays === undefined && input.timeZone !== undefined ? current?.reminder?.daysBefore : input.reminderDays;
  if (days !== undefined && days !== null && !(REMINDER_DAYS as readonly number[]).includes(days)) {
    return { ok: false, message: `A reminder goes ${REMINDER_DAYS.join(", ")} days before the date` };
  }
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) {
    return { ok: false, message: `Unknown time zone "${input.timeZone}"; use an IANA name such as Europe/Istanbul` };
  }
  const display = input.display === undefined ? current?.display : input.display === "relative" ? "relative" : undefined;
  let reminder = current?.reminder;
  if (days === null) reminder = undefined;
  else if (days !== undefined) {
    const timeZone = input.timeZone ?? reminder?.timeZone ?? "UTC";
    if (reminder?.daysBefore !== days || reminder.timeZone !== timeZone) {
      reminder = { daysBefore: days, timeZone, since: now.toISOString() };
    }
  }
  const options: DateOptions = { ...(display ? { display } : {}), ...(reminder ? { reminder } : {}) };
  return { ok: true, options: Object.keys(options).length ? options : null };
}

/** The instant a reminder goes for a date ("2026-10-16"). */
export function reminderInstant(day: string, reminder: Pick<DateReminder, "daysBefore" | "timeZone">): number {
  return zonedInstant(dayNumber(day) - reminder.daysBefore, REMINDER_MINUTES, reminder.timeZone);
}

/**
 * The date (as a day number) whose reminder time is the latest one at or before `now`: rows with
 * that date are the ones to remind. Each day at 9:00 it moves on by one.
 */
export function dueReminderDay(reminder: Pick<DateReminder, "daysBefore" | "timeZone">, now: number): number {
  const today = localDay(now, reminder.timeZone);
  const sentToday = zonedInstant(today, REMINDER_MINUTES, reminder.timeZone) <= now;
  return (sentToday ? today : today - 1) + reminder.daysBefore;
}

// One formatter per language: every date cell of a relative property asks on every render.
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/**
 * A date near `today` (both "YYYY-MM-DD") said relatively in `locale`: "today", "tomorrow",
 * "in 3 days", "2 days ago". Null further than RELATIVE_DAYS away, where the date reads better.
 */
export function relativeDay(day: string, today: string, locale: string): string | null {
  const diff = dayNumber(day) - dayNumber(today);
  if (!Number.isFinite(diff) || Math.abs(diff) > RELATIVE_DAYS) return null;
  let format = relativeFormats.get(locale);
  if (!format) relativeFormats.set(locale, (format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })));
  return format.format(diff, "day");
}
