// Client-safe: the rules of reminders agents set (server/ai-reminders.ts), shared with the
// reminder's window (components/sidebar/reminder-prompt.tsx).

import { dayNumber, dayString, zonedInstant } from "./time-zone";

/** The most a reminder says. */
export const MAX_REMINDER_CHARS = 300;
/** Reminders one run may set. */
export const MAX_REMINDERS_PER_RUN = 3;
/** Reminders one agent may have waiting for one person at once. */
export const MAX_WAITING_REMINDERS = 20;
/** How far ahead a reminder may be set: as far as a notification can be snoozed. */
export const MAX_REMINDER_AHEAD_MS = 30 * 86_400_000;
/** A reminder for a time a little gone by (the model took a while) goes at once rather than failing. */
const LATE_MS = 5 * 60_000;
/** How long after its time a reminder still opens over the page; after that it waits in the inbox. */
export const REMINDER_PROMPT_MS = 12 * 3_600_000;

/** A time with a date, hours and minutes, and maybe an offset or Z: "2026-11-02T09:00", "2026-11-02T09:00+03:00". */
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

export type ReminderTimeError = "format" | "past" | "tooFar";

/**
 * When a reminder set for `value` goes: that instant, or `now` for one a few minutes gone by. A
 * time without an offset is the time on `timeZone`'s clock that day, so a reminder set across a
 * change of clocks still goes at the hour named.
 */
export function reminderTime(value: unknown, now: Date, timeZone: string): { at: Date } | { error: ReminderTimeError } {
  const match = typeof value === "string" ? ISO_TIME.exec(value.trim()) : null;
  if (!match) return { error: "format" };
  const [, date, hour, minute, offset] = match;
  const day = dayNumber(date);
  const time = offset
    ? new Date(match[0]).getTime()
    : dayString(day) === date && Number(hour) < 24 && Number(minute) < 60
      ? zonedInstant(day, Number(hour) * 60 + Number(minute), timeZone)
      : NaN;
  if (!Number.isFinite(time)) return { error: "format" };
  if (time < now.getTime() - LATE_MS) return { error: "past" };
  if (time > now.getTime() + MAX_REMINDER_AHEAD_MS) return { error: "tooFar" };
  return { at: new Date(Math.max(time, now.getTime())) };
}

/** A reminder's text as kept: one paragraph's worth, without control characters, cut to MAX_REMINDER_CHARS. */
export function reminderText(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > MAX_REMINDER_CHARS ? `${clean.slice(0, MAX_REMINDER_CHARS - 1).trimEnd()}…` : clean;
}
