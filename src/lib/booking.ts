/**
 * Free time on a person's calendar and the booking links built on it (server/booking.ts): pure
 * slot arithmetic shared by the AI chat's `find_free_time`, the public page `/b/<token>` and the
 * check made again when a visitor books. Everything is in instants (milliseconds); the person's
 * working days and hours are wall-clock times in their own time zone, so a change of clocks moves
 * the slots' instants and not their hours.
 */
import { dateMillis } from "./date-value";
import { dayString, localDay, weekdayOf, zonedInstant } from "./time-zone";

const MINUTE = 60_000;

/** A stretch of time: `start` up to, not including, `end` (milliseconds). */
export type Interval = { start: number; end: number };

export const BOOKING_LIMITS = {
  title: 120,
  description: 1000,
  durationMinutes: { min: 5, max: 480 },
  bufferMinutes: { min: 0, max: 120 },
  /** Within what one read of a calendar covers (CALENDAR_MAX_DAYS), a day either way spare. */
  daysAhead: { min: 1, max: 60 },
  minNoticeMinutes: { min: 0, max: 14 * 24 * 60 },
  /** Working hours move in steps of this many minutes. */
  stepMinutes: 5,
  name: 120,
  email: 254,
  note: 1000,
} as const;

/** The lengths the link form offers. */
export const BOOKING_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
/** What a link starts with. */
export const BOOKING_DEFAULTS = {
  durationMinutes: 30,
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  bufferMinutes: 0,
  daysAhead: 30,
  minNoticeMinutes: 60,
} as const;

/** When a person can be booked: the days and hours (their wall-clock time), and how a slot is cut. */
export type BookingSchedule = {
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: readonly number[];
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  /** Kept free before and after whatever else is on the calendar. */
  bufferMinutes: number;
  /** Today and this many days after it. */
  daysAhead: number;
  /** A slot starting sooner than this from now isn't offered. */
  minNoticeMinutes: number;
};

export type BookingScheduleProblem = "timeZone" | "weekdays" | "hours" | "duration" | "buffer" | "daysAhead" | "notice";

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Why a schedule can't be used, or null when it can. `zoneOk` says whether the time zone is one runtimes know. */
export function scheduleProblem(s: BookingSchedule, zoneOk: boolean): BookingScheduleProblem | null {
  if (!zoneOk) return "timeZone";
  if (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.length > 7 || new Set(s.weekdays).size !== s.weekdays.length || !s.weekdays.every((d) => isWhole(d, 0, 6))) {
    return "weekdays";
  }
  const { stepMinutes: step, durationMinutes: length } = BOOKING_LIMITS;
  if (!isWhole(s.durationMinutes, length.min, length.max)) return "duration";
  if (!isWhole(s.startMinute, 0, 24 * 60 - step) || !isWhole(s.endMinute, step, 24 * 60) || s.startMinute % step || s.endMinute % step) return "hours";
  if (s.endMinute - s.startMinute < s.durationMinutes) return "hours";
  if (!isWhole(s.bufferMinutes, BOOKING_LIMITS.bufferMinutes.min, BOOKING_LIMITS.bufferMinutes.max)) return "buffer";
  if (!isWhole(s.daysAhead, BOOKING_LIMITS.daysAhead.min, BOOKING_LIMITS.daysAhead.max)) return "daysAhead";
  if (!isWhole(s.minNoticeMinutes, BOOKING_LIMITS.minNoticeMinutes.min, BOOKING_LIMITS.minNoticeMinutes.max)) return "notice";
  return null;
}

/** How long something on the calendar with a start and no end blocks. */
export const OPEN_ENDED_MINUTES = 60;

/**
 * The times these date values (lib/date-value) take up: values with a time only. A day, or days,
 * are all-day entries (a birthday, a holiday, a task's due day) and don't block the hours; one
 * with a start and no end (a meeting not yet held) takes OPEN_ENDED_MINUTES.
 */
export function busyFromDates(dates: readonly string[]): Interval[] {
  const busy: Interval[] = [];
  for (const date of dates) {
    const span = dateMillis(date);
    if (!span?.time) continue;
    busy.push({ start: span.start, end: span.end > span.start ? span.end : span.start + OPEN_ENDED_MINUTES * MINUTE });
  }
  return mergeIntervals(busy);
}

/** Overlapping and touching intervals joined, in order. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The working hours of each wanted weekday from day number `fromDay` to `toDay` (both included), cut at `notBefore`. */
export function workingWindows(
  range: { fromDay: number; toDay: number; weekdays: readonly number[]; startMinute: number; endMinute: number; timeZone: string },
  notBefore = -Infinity,
): Interval[] {
  const windows: Interval[] = [];
  for (let day = range.fromDay; day <= range.toDay; day++) {
    if (!range.weekdays.includes(weekdayOf(day))) continue;
    const start = Math.max(zonedInstant(day, range.startMinute, range.timeZone), notBefore);
    const end = zonedInstant(day, range.endMinute, range.timeZone);
    if (end > start) windows.push({ start, end });
  }
  return windows;
}

/** What is left of `windows` once `busy` (each stretch widened by `buffer` minutes either side) is taken out. */
export function takeOut(windows: readonly Interval[], busy: readonly Interval[], bufferMinutes = 0): Interval[] {
  const blocked = mergeIntervals(busy.map((b) => ({ start: b.start - bufferMinutes * MINUTE, end: b.end + bufferMinutes * MINUTE })));
  const free: Interval[] = [];
  for (const window of windows) {
    let from = window.start;
    for (const block of blocked) {
      if (block.end <= from) continue;
      if (block.start >= window.end) break;
      if (block.start > from) free.push({ start: from, end: block.start });
      from = Math.max(from, block.end);
    }
    if (from < window.end) free.push({ start: from, end: window.end });
  }
  return free;
}

/** The free stretches at least `minutes` long. */
export function atLeastLong(free: readonly Interval[], minutes: number): Interval[] {
  return free.filter((i) => i.end - i.start >= minutes * MINUTE);
}

/** The gap between the starts offered: half an hour, or the slot itself when it is shorter. */
export const slotStepMinutes = (durationMinutes: number) => Math.min(30, durationMinutes);

/** The starts of slots of `durationMinutes` that fit in the free stretches, each stretch from its own start. */
export function slotStarts(free: readonly Interval[], durationMinutes: number): number[] {
  const length = durationMinutes * MINUTE;
  const step = slotStepMinutes(durationMinutes) * MINUTE;
  const starts: number[] = [];
  for (const stretch of free) for (let at = stretch.start; at + length <= stretch.end; at += step) starts.push(at);
  return starts;
}

/** The first and last day (day numbers, in the schedule's zone) a link offers at `now`. */
export function offeredDays(s: Pick<BookingSchedule, "timeZone" | "daysAhead">, now: number): { fromDay: number; toDay: number } {
  const fromDay = localDay(now, s.timeZone);
  return { fromDay, toDay: fromDay + s.daysAhead };
}

/** The slots a schedule offers at `now`, given what is on the calendar (`busy`): the instants they start. */
export function bookableSlots(s: BookingSchedule, busy: readonly Interval[], now: number): number[] {
  const windows = workingWindows({ ...offeredDays(s, now), weekdays: s.weekdays, startMinute: s.startMinute, endMinute: s.endMinute, timeZone: s.timeZone }, now + s.minNoticeMinutes * MINUTE);
  return slotStarts(takeOut(windows, busy, s.bufferMinutes), s.durationMinutes);
}

/** Whether `start` is one of the slots a schedule offers at `now`. */
export const slotIsOffered = (s: BookingSchedule, busy: readonly Interval[], start: number, now: number) => bookableSlots(s, busy, now).includes(start);

/** The instants a slot of a schedule starting at `start` takes up. */
export const slotInterval = (s: Pick<BookingSchedule, "durationMinutes">, start: number): Interval => ({ start, end: start + s.durationMinutes * MINUTE });

/** "09:00" as minutes past midnight; null when it isn't a time of day ("24:00" is the end of one). */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= 24 * 60 ? minutes : null;
}

/** Minutes past midnight as "09:00". */
export const clockString = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The days of the week, Monday first, as `weekdayOf` numbers them (0 = Sunday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** The day a slot is on, as a day string in the schedule's zone. */
export const slotDay = (start: number, timeZone: string) => dayString(localDay(start, timeZone));
