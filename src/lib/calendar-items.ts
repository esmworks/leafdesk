/**
 * The Calendar place's items (server/calendar.ts): what a person has on their days across a
 * workspace, from the calendars synced into it, its meeting notes and what is assigned to them.
 * Pure and client-safe.
 */
import { calendarEvent, eventsOn, type CalendarEvent } from "./calendar";
import { dayNumber, dayString, weekdayOf } from "./time-zone";

/** Where an item comes from: a synced calendar's event, a meeting note, a row or to-do assigned to the person. */
export type CalendarItemKind = "event" | "meeting" | "task";

export type CalendarItem = {
  /** Unique among the items: the kind and the id of what it is. */
  id: string;
  kind: CalendarItemKind;
  title: string;
  icon: string | null;
  /** When, as a date value (lib/date-value): a day, a time or a range of either. */
  date: string;
  /** The page it opens. */
  href: string;
  /** Under its title: an event's place, a meeting's people, the database or page a task is in. */
  detail: string | null;
};

/** The most days one read of items covers: a month shown whole, with its edges and the week after today. */
export const CALENDAR_MAX_DAYS = 62;
/** How many days the sidebar's Calendar tab lists, from today. */
export const CALENDAR_PANEL_DAYS = 7;

/** An item placed on the viewer's days. */
export type PlacedItem = CalendarEvent & { item: CalendarItem };

/** The items placed in `timeZone`, leaving out any whose date isn't one. */
export function placeItems(items: CalendarItem[], timeZone: string): PlacedItem[] {
  return items.flatMap((item) => {
    const event = calendarEvent(item.id, item.date, timeZone);
    return event ? [{ ...event, item }] : [];
  });
}

/** The days from `from` (YYYY-MM-DD) for `count` days, each with its items: all-day ones first, then by time. */
export function agendaDays(placed: PlacedItem[], from: string, count: number): { day: string; items: PlacedItem[] }[] {
  const first = dayNumber(from);
  return Array.from({ length: count }, (_, i) => ({ day: dayString(first + i), items: eventsOn(placed, first + i) }));
}

/** The minutes an item lasts on its one day, or null when it has no end or covers whole days. */
export function itemMinutes(placed: PlacedItem): number | null {
  if (!placed.time || placed.endMinutes === null || placed.end > placed.start) return null;
  return Math.max(0, placed.endMinutes - placed.startMinutes);
}

/** The ISO week number of a day number (weeks from Monday, the first holding the year's first Thursday). */
export function isoWeek(day: number): number {
  const thursday = day + 3 - ((weekdayOf(day) + 6) % 7);
  const year = new Date(thursday * 86_400_000).getUTCFullYear();
  return Math.floor((thursday - dayNumber(`${year}-01-01`)) / 7) + 1;
}
