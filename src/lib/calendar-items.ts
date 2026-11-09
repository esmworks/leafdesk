/**
 * The Calendar place's items (server/calendar.ts): what a person has on their days across a
 * workspace, from the calendars synced into it, its meeting notes, what is assigned to them and the
 * reminders the AI chat and agents set them that haven't come yet. Pure and client-safe.
 */
import { calendarEvent, eventsOn, type CalendarEvent } from "./calendar";
import { moveDateStart, parseDateValue } from "./date-value";
import { dayNumber, dayString, weekdayOf, zonedInstant } from "./time-zone";
import type { WorkTaskRef } from "./work-blocks";

/**
 * Where an item comes from: a synced calendar's event, a meeting note, a row or to-do assigned to
 * the person, a reminder an agent or the AI chat set them (server/ai-reminders.ts) still to come,
 * time the person planned for one of their tasks (server/work-blocks.ts).
 */
export type CalendarItemKind = "event" | "meeting" | "task" | "reminder" | "block";

export type CalendarItem = {
  /** Unique among the items: the kind and the id of what it is. */
  id: string;
  kind: CalendarItemKind;
  title: string;
  icon: string | null;
  /** When, as a date value (lib/date-value): a day, a time or a range of either. */
  date: string;
  /** The page it opens; null for a reminder about no page, which opens the inbox's Scheduled tab. */
  href: string | null;
  /** Under its title: an event's place, a meeting's people, the database or page a task is in, the agent that set a reminder. */
  detail: string | null;
  /**
   * Whether the person may drag it to another day or time (moveCalendarItem says for sure), and
   * whether it may become a whole day: a planned meeting has a time, a held one doesn't move, nor
   * does an event of a calendar read without writing back.
   */
  moves: { allDay: boolean } | null;
  /** A planned block's task is done (its row's status, its to-do ticked): it still shows, struck through. */
  done?: boolean;
  /** A planned block's task, and whether it can be marked done from the block (a status with a done option, or a to-do still open). */
  task?: { ref: WorkTaskRef; markable: boolean };
};

/**
 * Time planned for a task, as an item: at its times, with the task's title and place, opening the
 * task. It moves and changes its length on the hours, never becoming whole days.
 */
export function workBlockItem(block: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  icon: string | null;
  href: string;
  detail: string | null;
  done: boolean;
  ref: WorkTaskRef;
  markable: boolean;
}): CalendarItem {
  return {
    id: `block:${block.id}`,
    kind: "block",
    title: block.title,
    icon: block.icon,
    date: `${block.startsAt.toISOString()}/${block.endsAt.toISOString()}`,
    href: block.href,
    detail: block.detail,
    moves: { allDay: false },
    done: block.done,
    task: { ref: block.ref, markable: block.markable && !block.done },
  };
}

/** The longest a reminder's text is as an item's title. */
const REMINDER_TITLE_CHARS = 200;

/**
 * A reminder still to come as an item, at its time: about its page when it has one, by the agent
 * that set it (no one named when the person set it themselves through the AI chat). It moves to
 * another time, never to a whole day.
 */
export function reminderItem(
  reminder: { id: string; text: string; at: Date; pageId: string | null; agentName: string | null; own: boolean },
  workspaceId: string,
): CalendarItem {
  const text = reminder.text.replace(/\s+/g, " ").trim();
  return {
    id: `reminder:${reminder.id}`,
    kind: "reminder",
    title: text.length > REMINDER_TITLE_CHARS ? `${text.slice(0, REMINDER_TITLE_CHARS - 1)}…` : text,
    icon: null,
    date: reminder.at.toISOString(),
    href: reminder.pageId ? `/w/${workspaceId}/p/${reminder.pageId}` : null,
    detail: reminder.own ? null : reminder.agentName,
    moves: { allDay: false },
  };
}

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

/** Where an item is dropped on a week: a day of the all-day strip (`minutes` null) or a time of a day. */
export type CalendarDrop = { day: number; minutes: number | null };

/**
 * The date an item gets dropped at `drop`, picked up `grabDays` days after its first: on the
 * all-day strip whole days, as many as it covered; on the hours a time there, as long as before
 * when it had times and an end, else without an end. Null when nothing changes.
 */
export function droppedDate(placed: PlacedItem, drop: CalendarDrop, timeZone: string, grabDays = 0): string | null {
  const value = placed.item.date;
  let next: string | null;
  if (drop.minutes === null) {
    const start = drop.day - grabDays;
    const end = start + (placed.end - placed.start);
    next = end > start ? `${dayString(start)}/${dayString(end)}` : dayString(start);
  } else {
    const at = zonedInstant(drop.day, drop.minutes, timeZone);
    next = (placed.time ? moveDateStart(value, at) : null) ?? new Date(at).toISOString();
  }
  return next === value || (parseDateValue(next) === null) ? null : next;
}
