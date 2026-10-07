import { dayNumber, dayString, localDay, zonedInstant } from "./time-zone";

/**
 * When something repeats: every N days, weeks (on chosen weekdays), months or years, at a time of
 * day in a time zone, from a first day on. Pure, for the scheduler (server/schedules.ts) and the
 * forms that set a rule alike.
 *
 * A monthly rule runs on the first day's day of the month, a yearly one on its date; in a month
 * without that day (the 31st, February 29) it runs on the month's last day. Weeks start on Monday,
 * and "every 2 weeks" counts from the first day's week.
 */
export type RepeatFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** What a schedule does when it runs. */
export type ScheduleKind = "row_template";
/** "row_template": `dateInTitle` puts the day it runs after the template's title. */
export type ScheduleSettings = { dateInTitle?: boolean };
/**
 * Why a run didn't happen. Each pauses the schedule except "failed" (a passing problem; it runs
 * again next time): "runAsGone" (whoever set it has no account), "accessLost" (they can no longer
 * add rows to the database or see the template), "templateGone" (it's no longer a template).
 */
export type ScheduleError = "runAsGone" | "accessLost" | "templateGone" | "failed";

export type RepeatRule = {
  frequency: RepeatFrequency;
  /** Every how many days, weeks, months or years (1 for every one). */
  interval: number;
  /** Weekly only: the days it runs, 0 for Sunday to 6 for Saturday. Empty for the other frequencies. */
  weekdays: number[];
  /** Time of day, "HH:MM" on a 24-hour clock, in the schedule's time zone. */
  time: string;
  /** The first day it may run, "YYYY-MM-DD" in the schedule's time zone. */
  start: string;
};

export const REPEAT_FREQUENCIES: readonly RepeatFrequency[] = ["daily", "weekly", "monthly", "yearly"];
export const MAX_REPEAT_INTERVAL = 99;
/** Weekdays in the order forms show them: Monday first. */
export const WEEKDAYS_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0] as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  if (y < 2000 || y > 2999) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A rule from stored or submitted JSON, or null when it isn't a valid one. */
export function parseRepeatRule(value: unknown): RepeatRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const frequency = input.frequency as RepeatFrequency;
  if (!REPEAT_FREQUENCIES.includes(frequency)) return null;
  const interval = input.interval ?? 1;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > MAX_REPEAT_INTERVAL) return null;
  if (typeof input.time !== "string" || !TIME.test(input.time)) return null;
  if (!isDay(input.start)) return null;
  let weekdays: number[] = [];
  if (frequency === "weekly") {
    if (!Array.isArray(input.weekdays)) return null;
    if (!input.weekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
    weekdays = [...new Set(input.weekdays as number[])].sort((a, b) => a - b);
    if (!weekdays.length) return null;
  }
  return { frequency, interval, weekdays, time: input.time, start: input.start };
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** 0 for Sunday … 6 for Saturday (1970-01-01, day 0, was a Thursday). */
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The day number of `day` of a month counted from January 0000, clamped to the month's length. */
function monthDay(monthIndex: number, day: number) {
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  return Date.UTC(year, month, Math.min(day, daysInMonth(year, month))) / 86_400_000;
}

/**
 * The days the rule runs on, in order, from the period that holds `from` (a day number) on. The
 * first few may fall before `from`; the caller skips those.
 */
function* runDays(rule: RepeatRule, from: number): Generator<number> {
  const start = dayNumber(rule.start);
  const n = rule.interval;
  const first = (index: number) => Math.max(0, Math.floor(index / n)) * n;
  switch (rule.frequency) {
    case "daily": {
      for (let k = first(from - start); ; k += n) yield start + k;
    }
    case "weekly": {
      const monday = start - ((weekdayOf(start) + 6) % 7);
      const order = WEEKDAYS_FROM_MONDAY.filter((d) => rule.weekdays.includes(d)).map((d) => (d + 6) % 7);
      for (let week = first(Math.floor((from - monday) / 7)); ; week += n) {
        for (const offset of order) {
          const day = monday + week * 7 + offset;
          if (day >= start) yield day;
        }
      }
    }
    case "monthly":
    case "yearly": {
      const [y, m, d] = rule.start.split("-").map(Number);
      const startMonth = y * 12 + (m - 1);
      const [fy, fm] = dayString(from).split("-").map(Number);
      const step = rule.frequency === "monthly" ? n : n * 12;
      // One period early: a clamped day near the end of a month can fall before `from`.
      const months = fy * 12 + (fm - 1) - startMonth - step;
      for (let k = Math.max(0, Math.floor(months / step)) * step; ; k += step) {
        const day = monthDay(startMonth + k, d);
        if (day >= start) yield day;
      }
    }
  }
}

/**
 * The first time the rule runs strictly after `after`, in `timeZone`. A day whose time the clocks
 * skip runs just after the change (see zonedInstant).
 */
export function nextOccurrence(rule: RepeatRule, timeZone: string, after: Date): Date {
  const instant = after.getTime();
  const minutes = minutesOf(rule.time);
  // A day early: the day `after` falls on can run earlier in the day than `after`, or later.
  const from = localDay(instant, timeZone) - 1;
  let checked = 0;
  for (const day of runDays(rule, from)) {
    if (day < from) continue;
    const at = zonedInstant(day, minutes, timeZone);
    if (at > instant) return new Date(at);
    // Every rule runs at least once in a year and a day of days; this only guards against a bug.
    if (++checked > 1000) break;
  }
  throw new Error("No next occurrence");
}

/** How a row template repeats, for the template menu. */
export type TemplateRepeatSummary = { enabled: boolean; nextRunAt: string | null; lastError: ScheduleError | null };

const SCHEDULE_ERRORS: readonly ScheduleError[] = ["runAsGone", "accessLost", "templateGone", "failed"];

export function repeatSummary(row: { enabled: boolean; nextRunAt: Date | null; lastError: string | null }): TemplateRepeatSummary {
  return {
    enabled: row.enabled,
    nextRunAt: row.enabled && row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastError: SCHEDULE_ERRORS.includes(row.lastError as ScheduleError) ? (row.lastError as ScheduleError) : null,
  };
}
