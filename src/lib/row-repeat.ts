import { dateDays, isDay, shiftDateValue } from "./date-value";
import { MAX_REPEAT_INTERVAL, REPEAT_FREQUENCIES, type RepeatFrequency } from "./schedule";
import { dayNumber, dayString, monthDay, weekdayOf } from "./time-zone";

/**
 * Rows that come round again (server/row-repeat.ts): a rule on one date property of a row. When
 * the row is marked done, a copy of it opens with that date moved to the next time. Pure and
 * client-safe.
 */

/** What the next time is counted from: the date the row had, or the day it was done. */
export type RepeatFrom = "due" | "done";
export const REPEAT_FROMS: readonly RepeatFrom[] = ["due", "done"];

export type RowRepeatRule = {
  frequency: RepeatFrequency;
  /** Every how many days, weeks, months or years (1 for every one). */
  interval: number;
  /** Weekly rules counted from the date only: the days, 0 for Sunday to 6 for Saturday. Else empty. */
  weekdays: number[];
  from: RepeatFrom;
  /**
   * The day the rule was set on (YYYY-MM-DD): monthly and yearly rules keep its day of the month
   * (and month), so a rule set on the 31st comes back on the 31st after a shorter month.
   */
  anchor: string;
  /** The last day a copy may fall on (YYYY-MM-DD), or null for no end. */
  until: string | null;
};

/** The weekdays of "every weekday": Monday to Friday. */
export const WORKDAYS = [1, 2, 3, 4, 5] as const;

/** Copies one chain of repeats may open in a day before it stops (an automation marking each copy done). */
export const MAX_REPEATS_PER_DAY = 20;

/** Why a rule couldn't open its next copy, shown in the date's repeat menu. */
export type RowRepeatError = "accessLost" | "tooMany";
export const ROW_REPEAT_ERRORS: readonly RowRepeatError[] = ["accessLost", "tooMany"];

/** A row's rule as the app shows it (server/row-repeat.ts `rowRepeatsOf`). */
export type RowRepeatView = {
  propertyId: string;
  rule: RowRepeatRule;
  timeZone: string;
  lastError: RowRepeatError | null;
};

/**
 * A rule from stored or submitted JSON, or null when it isn't a valid one. `anchor` may be left out
 * of what is submitted: `fallbackAnchor` (the row's date, else today) takes its place.
 */
export function parseRowRepeatRule(value: unknown, fallbackAnchor?: string): RowRepeatRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const frequency = input.frequency as RepeatFrequency;
  if (!REPEAT_FREQUENCIES.includes(frequency)) return null;
  const interval = input.interval ?? 1;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > MAX_REPEAT_INTERVAL) return null;
  const from = (input.from ?? "due") as RepeatFrom;
  if (!REPEAT_FROMS.includes(from)) return null;
  const anchor = input.anchor ?? fallbackAnchor;
  if (!isDay(anchor)) return null;
  const until = input.until ?? null;
  if (until !== null && !isDay(until)) return null;
  let weekdays: number[] = [];
  if (frequency === "weekly" && from === "due") {
    const days = input.weekdays ?? [weekdayOf(dayNumber(anchor))];
    if (!Array.isArray(days) || !days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
    weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
    if (!weekdays.length) return null;
  }
  return { frequency, interval, weekdays, from, anchor, until };
}

/** Whether two rules come round the same way (field by field: stored rules come back with their keys reordered). */
export function sameRepeatRule(a: RowRepeatRule | null, b: RowRepeatRule | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.frequency === b.frequency &&
    a.interval === b.interval &&
    a.from === b.from &&
    a.anchor === b.anchor &&
    a.until === b.until &&
    a.weekdays.length === b.weekdays.length &&
    a.weekdays.every((d, i) => d === b.weekdays[i])
  );
}

const monthIndexOf = (day: number) => {
  const [y, m] = dayString(day).split("-").map(Number);
  return y * 12 + (m - 1);
};
const dayOfMonth = (day: string) => Number(day.slice(8, 10));
const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;

/** The first day `k` steps of `step` from `base` gives that is after `base` and not before `today`. */
function stepsFrom(base: number, today: number, at: (k: number) => number): number {
  let k = 1;
  // Jump close to today first: a rule left for years doesn't walk there one step at a time.
  const gap = today - base;
  if (gap > 0) {
    const one = at(1) - base;
    if (one > 0) k = Math.max(1, Math.floor(gap / one) - 1);
  }
  for (let checked = 0; checked < 10_000; checked++, k++) {
    const day = at(k);
    if (day > base && day >= today) return day;
  }
  throw new Error("No next repeat");
}

/**
 * The day (a day number) the copy of a row done on `done` falls on, `base` being the day of its
 * date (or `done` when it had none), `today` the day it is in the rule's zone. A rule counted from
 * the date gives its first time after `base` that isn't before today, so a row done late opens one
 * copy, not one per time it missed. Null once that day is past `until`.
 */
export function nextRepeatDay(rule: RowRepeatRule, base: number, done: number, today: number): number | null {
  const n = rule.interval;
  let next: number;
  if (rule.from === "done") {
    const doneDay = dayString(done);
    switch (rule.frequency) {
      case "daily":
        next = done + n;
        break;
      case "weekly":
        next = done + 7 * n;
        break;
      case "monthly":
        next = monthDay(monthIndexOf(done) + n, dayOfMonth(doneDay));
        break;
      case "yearly":
        next = monthDay(monthIndexOf(done) + 12 * n, dayOfMonth(doneDay));
        break;
    }
  } else {
    switch (rule.frequency) {
      case "daily":
        next = stepsFrom(base, today, (k) => base + k * n);
        break;
      case "weekly": {
        const monday = base - ((weekdayOf(base) + 6) % 7);
        const offsets = rule.weekdays.map((d) => (d + 6) % 7).sort((a, b) => a - b);
        // Days of the weeks the rule runs in: base's week, then every n-th week after it.
        const days = (week: number) => offsets.map((o) => monday + week * 7 * n + o);
        next = Number.NaN;
        const fromWeek = today > base ? Math.max(0, Math.floor((today - monday) / (7 * n)) - 1) : 0;
        for (let week = fromWeek; week < fromWeek + 10_000; week++) {
          const found = days(week).find((day) => day > base && day >= today);
          if (found !== undefined) {
            next = found;
            break;
          }
        }
        if (Number.isNaN(next)) throw new Error("No next repeat");
        break;
      }
      case "monthly": {
        const month = monthIndexOf(base);
        next = stepsFrom(base, today, (k) => monthDay(month + k * n, dayOfMonth(rule.anchor)));
        break;
      }
      case "yearly": {
        const year = Math.floor(monthIndexOf(base) / 12);
        next = stepsFrom(base, today, (k) => monthDay((year + k * n) * 12 + monthOf(rule.anchor), dayOfMonth(rule.anchor)));
        break;
      }
    }
  }
  if (rule.until !== null && next > dayNumber(rule.until)) return null;
  return next;
}

/**
 * The date value the copy of a row gets: `value` (the row's date, any of the stored shapes, or
 * nothing) moved to the next time, keeping its time of day and how long it lasts. `done` and
 * `today` are YYYY-MM-DD in `timeZone`. Null once the rule has ended (`until`).
 */
export function nextRepeatValue(rule: RowRepeatRule, value: unknown, done: string, today: string, timeZone: string): string | null {
  const days = dateDays(value, timeZone);
  const base = days ? days.start : dayNumber(done);
  const next = nextRepeatDay(rule, base, dayNumber(done), dayNumber(today));
  if (next === null) return null;
  if (!days) return dayString(next);
  return shiftDateValue(value, next - base, timeZone);
}

/** The date "skip this one" moves a row's date to: where its copy would go had it been done today. */
export function skippedRepeatValue(rule: RowRepeatRule, value: unknown, today: string, timeZone: string): string | null {
  return nextRepeatValue(rule, value, today, today, timeZone);
}

/** The ready-made rules the repeat menu offers for a row dated `anchor`. */
export function repeatPresets(anchor: string): { key: "daily" | "workdays" | "weekly" | "monthly" | "yearly"; rule: RowRepeatRule }[] {
  const base = { interval: 1, from: "due" as const, anchor, until: null };
  return [
    { key: "daily", rule: { ...base, frequency: "daily", weekdays: [] } },
    { key: "workdays", rule: { ...base, frequency: "weekly", weekdays: [...WORKDAYS] } },
    { key: "weekly", rule: { ...base, frequency: "weekly", weekdays: [weekdayOf(dayNumber(anchor))] } },
    { key: "monthly", rule: { ...base, frequency: "monthly", weekdays: [] } },
    { key: "yearly", rule: { ...base, frequency: "yearly", weekdays: [] } },
  ];
}

/** Which ready-made rule `rule` is, if any. */
export function presetOf(rule: RowRepeatRule): ReturnType<typeof repeatPresets>[number]["key"] | null {
  return repeatPresets(rule.anchor).find((p) => sameRepeatRule(p.rule, rule))?.key ?? null;
}
