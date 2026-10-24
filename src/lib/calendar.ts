/**
 * Where calendar views place rows: the days a date covers on the viewer's calendar, the lanes
 * events spanning several days take in a week, and the columns of events at the same time of day.
 * Days are day numbers (see lib/time-zone), so the arithmetic never meets a time zone.
 */
import { dateDays, dateDraft, dateSortKey } from "./date-value";
import { dayNumber, monthDay, weekdayOf } from "./time-zone";

export const MINUTES_PER_DAY = 24 * 60;

/** A row's date as the calendar shows it. */
export type CalendarEvent = {
  id: string;
  /** First and last day it covers, in the viewer's zone. */
  start: number;
  end: number;
  /** Whether it has times (else it is all-day). */
  time: boolean;
  /** Times only: minutes past midnight it starts at on its first day. */
  startMinutes: number;
  /** Times only: minutes past midnight it ends at on its last day, or null without an end. */
  endMinutes: number | null;
  /** Where it starts, for ordering (see dateSortKey). */
  sort: number;
};

/** The calendar event of a row's date `value` in `timeZone`, or null when it isn't a date. */
export function calendarEvent(id: string, value: unknown, timeZone: string): CalendarEvent | null {
  const days = dateDays(value, timeZone);
  const draft = dateDraft(value, timeZone);
  if (!days || !draft) return null;
  let endMinutes: number | null = null;
  if (draft.time && draft.end !== null) {
    // A range ending at midnight ends on the day before, at its very end.
    endMinutes = dayNumber(draft.end) > days.end ? MINUTES_PER_DAY : draft.endMinutes;
  }
  return {
    id,
    start: days.start,
    end: days.end,
    time: draft.time,
    startMinutes: draft.time ? draft.startMinutes : 0,
    endMinutes,
    sort: dateSortKey(value, timeZone)!,
  };
}

/** Whether a week shows the event in its all-day strip: every day value, and times over several days. */
export const isAllDay = (event: CalendarEvent) => !event.time || event.end > event.start;

/** The day number a week starts on that holds `day`, weeks starting on `weekStart` (0 = Sunday). */
export function weekStartOf(day: number, weekStart: number): number {
  return day - ((weekdayOf(day) - weekStart + 7) % 7);
}

/** The days of the week holding `day`. */
export function weekDays(day: number, weekStart: number): number[] {
  const first = weekStartOf(day, weekStart);
  return Array.from({ length: 7 }, (_, i) => first + i);
}

/** The whole weeks a month shows, as the day each starts on: from the week of the 1st to the one of the last day. */
export function monthWeeks(year: number, month: number, weekStart: number): number[] {
  const index = year * 12 + month;
  const first = weekStartOf(monthDay(index, 1), weekStart);
  const last = monthDay(index + 1, 1) - 1;
  const weeks: number[] = [];
  for (let start = first; start <= last; start += 7) weeks.push(start);
  return weeks;
}

/** The events covering `day`, all-day ones first, then by time, otherwise in the given order. */
export function eventsOn<T extends CalendarEvent>(events: T[], day: number): T[] {
  return order(events.filter((e) => e.start <= day && e.end >= day));
}

function order<T extends CalendarEvent>(events: T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        Number(a.event.time && !isAllDay(a.event)) - Number(b.event.time && !isAllDay(b.event)) ||
        (a.event.time && b.event.time && !isAllDay(a.event) && !isAllDay(b.event) ? a.event.sort - b.event.sort : 0) ||
        a.index - b.index,
    )
    .map(({ event }) => event);
}

/** Whether a day number is a Saturday or a Sunday: the days a calendar without weekends leaves out. */
export const isWeekend = (day: number) => {
  const weekday = weekdayOf(day);
  return weekday === 0 || weekday === 6;
};

/** An event in a week's rows: from column `col` (0–6, of the days shown) across `span` days, in lane `lane`. */
export type WeekBar<T> = {
  event: T;
  col: number;
  span: number;
  lane: number;
  /** Whether it goes on before its first column or after its last (into another week or a day not shown). */
  before: boolean;
  after: boolean;
};

/**
 * Stacks the events touching the week starting on `weekStart` (a day number) into lanes, each a
 * row of bars that don't overlap. Events starting earlier come first, then longer ones (so bars
 * over several days stay at the top), then all-day before timed, then by time, then in the order
 * given (the view's sort). Bars are cut at the week's edges.
 *
 * Only the days `shown` keeps have columns (a calendar without weekends): bars are cut at the days
 * left out too, and an event on none of the shown days has no bar (see eventsOffGrid).
 */
export function weekBars<T extends CalendarEvent>(
  events: T[],
  weekStart: number,
  shown: (day: number) => boolean = () => true,
): { bars: WeekBar<T>[]; lanes: number } {
  const weekEnd = weekStart + 6;
  // Each day's column, -1 for a day left out.
  const columns: number[] = [];
  let count = 0;
  for (let day = weekStart; day <= weekEnd; day++) columns.push(shown(day) ? count++ : -1);
  const column = (day: number) => columns[day - weekStart];
  const touching = events
    .flatMap((event, index) => {
      let from = Math.max(event.start, weekStart);
      let to = Math.min(event.end, weekEnd);
      while (from <= to && column(from) === -1) from++;
      while (to >= from && column(to) === -1) to--;
      return from <= to ? [{ event, index, from, to }] : [];
    })
    .sort(
      (a, b) =>
        a.from - b.from ||
        b.to - b.from - (a.to - a.from) ||
        Number(a.event.time) - Number(b.event.time) ||
        (a.event.time && b.event.time ? a.event.sort - b.event.sort : 0) ||
        a.index - b.index,
    );
  // The last column each lane is taken up to.
  const taken: number[] = [];
  const bars = touching.map(({ event, from, to }) => {
    const first = column(from);
    const last = column(to);
    let lane = taken.findIndex((end) => end < first);
    if (lane === -1) lane = taken.length;
    taken[lane] = last;
    return { event, col: first, span: last - first + 1, lane, before: event.start < from, after: event.end > to };
  });
  return { bars, lanes: taken.length };
}

/**
 * The events touching the days `first` to `last` that cover none of the days `shown` keeps: on a
 * calendar without weekends, the rows dated only on a Saturday or Sunday, listed apart so they
 * stay in reach.
 */
export function eventsOffGrid<T extends CalendarEvent>(events: T[], first: number, last: number, shown: (day: number) => boolean): T[] {
  return events.filter((event) => {
    const to = Math.min(event.end, last);
    for (let day = Math.max(event.start, first); day <= to; day++) if (shown(day)) return false;
    return event.start <= last && event.end >= first;
  });
}

/** A timed event on a day's hours: from `top` to `bottom` minutes, in column `col` of `cols` side by side. */
export type DayBlock<T> = { event: T; top: number; bottom: number; col: number; cols: number };

/**
 * Lays out a day's timed events on its hours: an event without an end (or a shorter one) takes
 * `minLength` minutes, and events at the same time share the width in columns.
 */
export function dayBlocks<T extends CalendarEvent>(events: T[], minLength = 30): DayBlock<T>[] {
  const blocks = events
    .map((event) => {
      const top = event.startMinutes;
      const end = event.endMinutes ?? top;
      return { event, top, bottom: Math.min(Math.max(end, top + minLength), MINUTES_PER_DAY), col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Events overlapping one another, directly or through others, share their columns.
  let cluster: DayBlock<T>[] = [];
  let clusterEnd = -1;
  const columns: number[] = [];
  const close = () => {
    for (const block of cluster) block.cols = columns.length;
    cluster = [];
    columns.length = 0;
  };
  for (const block of blocks) {
    if (block.top >= clusterEnd) close();
    let col = columns.findIndex((bottom) => bottom <= block.top);
    if (col === -1) col = columns.length;
    columns[col] = block.bottom;
    block.col = col;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.bottom);
  }
  close();
  return blocks;
}

/** Where engines have no week info: Sunday or Saturday where weeks start then, else Monday. */
const FIRST_DAY: Record<string, number> = { en: 0, pt: 0, he: 0, ja: 0, ko: 0, ar: 6, fa: 6 };

/** First weekday of the locale as a `getUTCDay()` index (0 = Sunday). */
export function firstDayOfWeek(locale: string) {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    // Older engines without week info fall through to the default below.
  }
  return FIRST_DAY[locale.split("-")[0]] ?? 1;
}
