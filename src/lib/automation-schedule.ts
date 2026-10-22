import { dayString, localDay, monthDay, weekdayOf, zonedInstant, zoneOffset } from "./time-zone";

/**
 * When a scheduled automation runs: every day, on some weekdays or some days of the month at a
 * time of day, or on a cron expression, all in the automation's IANA time zone. Pure, for the
 * check that starts the runs (server/automations/scheduled.ts) and the editor alike.
 *
 * Daylight saving: a time the clocks skip (02:30 on the night they go forward) runs just after
 * the change, a time that happens twice (when they go back) runs the first time only, as agent
 * schedules do (lib/time-zone zonedInstant). A monthly day the month doesn't have (the 31st, or
 * the 29th in February) runs on the month's last day.
 */
export type AutomationSchedule =
  | { frequency: "daily"; time: string }
  /** `weekdays`: 0 for Sunday to 6 for Saturday. */
  | { frequency: "weekly"; time: string; weekdays: number[] }
  /** `days`: days of the month, 1 to 31. */
  | { frequency: "monthly"; time: string; days: number[] }
  /** Five fields: minute, hour, day of the month, month, day of the week (see parseCron). */
  | { frequency: "cron"; cron: string };

export type ScheduleFrequency = AutomationSchedule["frequency"];
export const SCHEDULE_FREQUENCIES = ["daily", "weekly", "monthly", "cron"] as const satisfies readonly ScheduleFrequency[];
export const MAX_CRON_LENGTH = 120;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** A parsed cron expression: the values each field allows, and whether the day fields were `*`. */
export type Cron = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** One field of a cron expression: `*`, numbers, ranges `a-b`, steps `/n` and lists `a,b`. */
function cronField(text: string, min: number, max: number, names?: string[]): number[] | null {
  const out = new Set<number>();
  const value = (part: string) => {
    const named = names ? names.indexOf(part.toLowerCase()) : -1;
    if (named >= 0) return named + (names === MONTH_NAMES ? 1 : 0);
    if (!/^\d{1,2}$/.test(part)) return NaN;
    return Number(part);
  };
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || !range) return null;
    const step = stepText === undefined ? 1 : /^\d{1,2}$/.test(stepText) ? Number(stepText) : NaN;
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [min, max];
    else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) return null;
      [from, to] = [value(a), value(b)];
    } else {
      from = value(range);
      // "5/15" counts from 5 up to the field's end, as cron does.
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A cron expression (minute hour day-of-month month day-of-week), or null when it isn't one.
 * Months and weekdays may be names (JAN, MON); 7 is Sunday too. As in cron, when both day fields
 * are restricted a day matches either of them.
 */
export function parseCron(text: unknown): Cron | null {
  if (typeof text !== "string" || text.length > MAX_CRON_LENGTH) return null;
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = cronField(fields[0], 0, 59);
  const hours = cronField(fields[1], 0, 23);
  const days = cronField(fields[2], 1, 31);
  const months = cronField(fields[3], 1, 12, MONTH_NAMES);
  const weekdays = cronField(fields[4], 0, 7, DAY_NAMES);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    anyDay: fields[2].startsWith("*"),
    anyWeekday: fields[4].startsWith("*"),
  };
}

/** A schedule from stored or submitted JSON, or null when it isn't a valid one. */
export function parseAutomationSchedule(value: unknown): AutomationSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const numbers = (list: unknown, min: number, max: number) =>
    Array.isArray(list) && list.length && list.every((d) => typeof d === "number" && Number.isInteger(d) && d >= min && d <= max)
      ? [...new Set(list as number[])].sort((a, b) => a - b)
      : null;
  if (input.frequency === "cron") {
    if (!parseCron(input.cron)) return null;
    return { frequency: "cron", cron: (input.cron as string).trim().split(/\s+/).join(" ") };
  }
  if (typeof input.time !== "string" || !TIME.test(input.time)) return null;
  if (input.frequency === "daily") return { frequency: "daily", time: input.time };
  if (input.frequency === "weekly") {
    const weekdays = numbers(input.weekdays, 0, 6);
    return weekdays ? { frequency: "weekly", time: input.time, weekdays } : null;
  }
  if (input.frequency === "monthly") {
    const days = numbers(input.days, 1, 31);
    return days ? { frequency: "monthly", time: input.time, days } : null;
  }
  return null;
}

/** How many days the month of `day` (a day number) has. */
function monthLength(day: number) {
  const [y, m] = dayString(day).split("-").map(Number);
  // monthDay clamps the 31st to the month's last day.
  return Number(dayString(monthDay(y * 12 + (m - 1), 31)).slice(8));
}

/** The minutes of `day` (a day number) the schedule runs at, in order; none when it doesn't run that day. */
function minutesOn(schedule: AutomationSchedule, cron: Cron | null, day: number): number[] {
  const weekday = weekdayOf(day);
  const date = dayString(day);
  const dom = Number(date.slice(8));
  if (schedule.frequency === "cron") {
    const c = cron!;
    if (!c.months.has(Number(date.slice(5, 7)))) return [];
    const byDay = c.days.has(dom);
    const byWeekday = c.weekdays.has(weekday);
    const matches = c.anyDay && c.anyWeekday ? true : c.anyDay ? byWeekday : c.anyWeekday ? byDay : byDay || byWeekday;
    if (!matches) return [];
    return c.hours.flatMap((h) => c.minutes.map((m) => h * 60 + m));
  }
  const at = [minutesOf(schedule.time)];
  if (schedule.frequency === "daily") return at;
  if (schedule.frequency === "weekly") return schedule.weekdays.includes(weekday) ? at : [];
  const last = monthLength(day);
  // A day the month doesn't have runs on its last day.
  const runs = schedule.days.includes(dom) || (dom === last && schedule.days.some((d) => d > last));
  return runs ? at : [];
}

/** Every schedule runs within this many days (February 29 on a Monday: 28 years at most). */
const SEARCH_DAYS = 366 * 29;

/**
 * The first time the schedule runs strictly after `after`, in `timeZone`; null when a cron
 * expression never matches a real day (February 30).
 */
export function nextScheduledRun(schedule: AutomationSchedule, timeZone: string, after: Date): Date | null {
  const cron = schedule.frequency === "cron" ? parseCron(schedule.cron) : null;
  if (schedule.frequency === "cron" && !cron) return null;
  const instant = after.getTime();
  // A day early: the local day `after` falls on can be behind or ahead of the zone's.
  const today = localDay(instant, timeZone);
  const from = today - 1;
  const nowMinute = Math.floor((((instant + zoneOffset(instant, timeZone)) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);
  for (let day = from; day < from + SEARCH_DAYS; day++) {
    // A day over by `after` has nothing left; skipping it spares a minute-by-minute cron the look.
    if (day <= from + 1 && zonedInstant(day + 1, 0, timeZone) <= instant) continue;
    for (const minutes of minutesOn(schedule, cron, day)) {
      // Minutes well before `after` on its own day can't come after it (three hours covers any change of clocks).
      if (day === today && minutes < nowMinute - 180) continue;
      const at = zonedInstant(day, minutes, timeZone);
      if (at > instant) return new Date(at);
    }
  }
  return null;
}
