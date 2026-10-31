import type { DatePhrase } from "./date-phrase";
import { dayNumber, wallClock, weekdayOf, zonedInstant } from "./time-zone";

/**
 * Snoozing a conversation in the Mail tab: it waits in the mailbox's snoozed folder until the
 * moment picked, then comes back to the inbox unread (server/mail-client/snooze.ts). The moments
 * offered are worked out here, in the person's time zone, for the picker and its tests.
 */

/** A conversation is snoozed for a year at most, and for a minute at least. */
export const MAIL_SNOOZE_MAX_DAYS = 365;
export const MAIL_SNOOZE_MIN_MS = 60_000;
/** The time of day a snooze to a day (tomorrow, a date typed without a time) ends at. */
export const SNOOZE_MORNING = 8 * 60;
/** "Later today" ends at this time, offered until an hour before it. */
const SNOOZE_EVENING = 18 * 60;

export type SnoozeChoice = { key: "laterToday" | "tomorrow" | "weekend" | "nextWeek"; at: number };

/**
 * The moments the picker offers at `now`: this evening (until an hour before), tomorrow morning,
 * Saturday morning (Monday to Friday), next Monday morning; one that falls on another is left out.
 */
export function snoozeChoices(now: number, timeZone: string): SnoozeChoice[] {
  const { day: today, minutes } = wallClock(now, timeZone);
  const weekday = weekdayOf(today);
  const choices: SnoozeChoice[] = [];
  if (minutes < SNOOZE_EVENING - 60) choices.push({ key: "laterToday", at: zonedInstant(today, SNOOZE_EVENING, timeZone) });
  choices.push({ key: "tomorrow", at: zonedInstant(today + 1, SNOOZE_MORNING, timeZone) });
  if (weekday >= 1 && weekday <= 5) choices.push({ key: "weekend", at: zonedInstant(today + 6 - weekday, SNOOZE_MORNING, timeZone) });
  choices.push({ key: "nextWeek", at: zonedInstant(today + ((8 - weekday) % 7 || 7), SNOOZE_MORNING, timeZone) });
  return choices.filter((c, i) => choices.findIndex((o) => o.at === c.at) === i);
}

/** The moment a typed date means: its time, or the morning of its day. Null when it isn't ahead. */
export function snoozeMoment(found: DatePhrase, now: number, timeZone: string): number | null {
  const at = found.kind === "moment" ? Date.parse(found.at) : zonedInstant(dayNumber(found.day), SNOOZE_MORNING, timeZone);
  return snoozeAllowed(at, now) ? at : null;
}

/** Whether a conversation may be snoozed until `at`: a minute ahead at least, a year at most. */
export const snoozeAllowed = (at: number, now: number) => Number.isFinite(at) && at - now >= MAIL_SNOOZE_MIN_MS && at - now <= MAIL_SNOOZE_MAX_DAYS * 86_400_000;
