/**
 * What waits in the inbox's Scheduled tab (components/sidebar/inbox-dialog.tsx): AI reminders not
 * come yet and snoozed notifications. Pure and client-safe; a module of its own so the inbox's
 * chunk alone carries it.
 */
import type { DatePhrase } from "./date-phrase";
import { dayNumber, localDay, zonedInstant } from "./time-zone";

/** The hour on the person's clock a day typed without a time means, as snoozing until tomorrow does. */
export const DAY_ONLY_MINUTES = 9 * 60;

/** The instant a time typed in words names: a moment as it is, a day at DAY_ONLY_MINUTES on `timeZone`'s clock. */
export function phraseInstant(found: DatePhrase, timeZone: string): Date {
  return found.kind === "moment" ? new Date(found.at) : new Date(zonedInstant(dayNumber(found.day), DAY_ONLY_MINUTES, timeZone));
}

/**
 * When something still to come comes, short, on `timeZone`'s clock: the time today, the weekday
 * and time within the week ahead, else the date and time ("14:30", "Fri 09:00", "20 Nov, 9:00" in en-GB).
 */
export function comesAt(at: Date, locale: string, timeZone: string, now = new Date()): string {
  const days = localDay(at.getTime(), timeZone) - localDay(now.getTime(), timeZone);
  const time = { hour: "numeric", minute: "2-digit", timeZone } as const;
  if (days === 0) return new Intl.DateTimeFormat(locale, time).format(at);
  if (days > 0 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short", ...time }).format(at);
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...time }).format(at);
}
