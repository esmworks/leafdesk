import { dayString, isTimeZone, localDay, wallClock, zonedInstant, zoneOffset } from "./time-zone";

/**
 * An agent's quiet hours (server/agents/run.ts): from `start` to `end` on the clock of `timeZone`,
 * both "HH:MM", wrapping past midnight when `end` comes before `start` ("22:00" to "07:00"). A
 * connection's call an owner's rule lets go without asking waits for the end of them instead; a
 * call a person approves goes when they do.
 */
export type QuietHours = { start: string; end: string; timeZone: string };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" as minutes past midnight; null for anything else. */
export function clockMinutes(value: unknown): number | null {
  const match = typeof value === "string" ? CLOCK.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** `value` as quiet hours, or null when it isn't: two different times of day and a known zone. */
export function parseQuietHours(value: unknown): QuietHours | null {
  if (!value || typeof value !== "object") return null;
  const { start, end, timeZone } = value as Record<string, unknown>;
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (from === null || to === null || from === to || !isTimeZone(timeZone)) return null;
  return { start: start as string, end: end as string, timeZone };
}

/**
 * When the quiet hours `now` falls in end, or null when it falls in none. A time the clocks skip
 * moves forward with them; on a night the clocks go back, a window ends the second time its end
 * comes round only when `now` is already past the first.
 */
export function quietUntil(now: Date | number, quiet: QuietHours): Date | null {
  const instant = typeof now === "number" ? now : now.getTime();
  const from = clockMinutes(quiet.start);
  const to = clockMinutes(quiet.end);
  if (from === null || to === null || from === to) return null;
  const { day, minutes } = wallClock(instant, quiet.timeZone);
  let endDay: number;
  if (from < to) {
    if (minutes < from || minutes >= to) return null;
    endDay = day;
  } else if (minutes >= from) endDay = day + 1;
  else if (minutes < to) endDay = day;
  else return null;
  let end = zonedInstant(endDay, to, quiet.timeZone);
  // The end's first time came before now, in the hour the clocks went back: its second time is the end.
  if (end <= instant) end += zoneOffset(end, quiet.timeZone) - zoneOffset(instant, quiet.timeZone);
  return end > instant ? new Date(end) : null;
}

/** The day (YYYY-MM-DD) an agent's changes count against its daily limit: on its quiet hours' clock, else UTC's. */
export function changeDay(now: Date | number, timeZone: string | null | undefined): string {
  const instant = typeof now === "number" ? now : now.getTime();
  return dayString(localDay(instant, timeZone && isTimeZone(timeZone) ? timeZone : "UTC"));
}

/** The most changes a day an owner may give an agent. */
export const MAX_DAILY_CHANGES = 10_000;

/** Whether `value` is a daily change limit: a whole number from 1 to MAX_DAILY_CHANGES. */
export const isDailyChangeLimit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DAILY_CHANGES;
