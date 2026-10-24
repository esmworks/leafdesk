/**
 * Verified pages (server/verification.ts): someone with full access marks a page as checked and
 * right, for a while or with no end. Pure, for the server, the page header and the API alike.
 */

/** How long a verification lasts, as the page menu offers it; a chosen day and "no end" come besides. */
export const VERIFICATION_DURATIONS = ["week", "month", "quarter", "year"] as const;
export type VerificationDuration = (typeof VERIFICATION_DURATIONS)[number];

export const isVerificationDuration = (value: unknown): value is VerificationDuration =>
  typeof value === "string" && (VERIFICATION_DURATIONS as readonly string[]).includes(value);

const DAY_MS = 24 * 60 * 60_000;

/** The verifier hears this long before the end that it is coming (and again when it comes). */
export const REMIND_BEFORE_MS = 3 * DAY_MS;

/** The furthest a verification may run to, from now: past that, "no end" says it better. */
export const MAX_VERIFICATION_MS = 5 * 366 * DAY_MS;

/** When a verification made at `from` for `duration` ends: a week, or one, three or twelve months on (the same day of the month, or the month's last). */
export function verificationEnd(duration: VerificationDuration, from: Date): Date {
  if (duration === "week") return new Date(from.getTime() + 7 * DAY_MS);
  const months = duration === "month" ? 1 : duration === "quarter" ? 3 : 12;
  const end = new Date(from);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, last));
  return end;
}

/** Whether a verification that ends at `until` (null: never) is over at `now`. */
export const verificationExpired = (until: Date | string | null, now: Date = new Date()) =>
  until !== null && new Date(until).getTime() <= now.getTime();

/**
 * A page's verification as the app and the API show it: who verified it (null when their account
 * is gone), when, until when (null: no end), and whether that end has passed.
 */
export type VerificationView = {
  byId: string | null;
  by: string | null;
  at: string;
  until: string | null;
  expired: boolean;
};

/**
 * The end a verification asked for over MCP or the REST API: a duration, "forever" (no end), or a
 * day (YYYY-MM-DD, verified through the end of that day in UTC). Undefined when `value` is none of
 * these, or a day that has passed or is too far off.
 */
export function verificationUntil(value: string, now: Date = new Date()): Date | null | undefined {
  if (value === "forever") return null;
  if (isVerificationDuration(value)) return verificationEnd(value, now);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!day) return undefined;
  const end = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1) - 1);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== value) return undefined;
  return checkedUntil(end, now);
}

/** `until` when it is a time a verification may end at: later than now, and not too far off. */
export function checkedUntil(until: Date, now: Date = new Date()): Date | undefined {
  const at = until.getTime();
  if (Number.isNaN(at) || at <= now.getTime() || at - now.getTime() > MAX_VERIFICATION_MS) return undefined;
  return until;
}

/**
 * Whether the reminder that the end is near is still to come when a verification ends at `until`:
 * not for one with no end, nor one that ends within REMIND_BEFORE_MS of being made.
 */
export const remindsBefore = (until: Date | null, now: Date = new Date()) => until !== null && until.getTime() - now.getTime() > REMIND_BEFORE_MS;
