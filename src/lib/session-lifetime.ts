/**
 * How long a sign-in lasts, for the whole server (SESSION_MAX_AGE_DAYS). Better Auth ends a session
 * that many days after it was last extended, and extends a session in use at most once a day
 * (`updateAge`), which is also when its "last activity" in My account → Sessions moves. So people
 * who keep using the app stay signed in; a device left alone that long is signed out.
 */

const DAY_SECONDS = 24 * 60 * 60;

/** Better Auth's own default, used when SESSION_MAX_AGE_DAYS is unset or invalid. */
export const DEFAULT_SESSION_DAYS = 7;
/**
 * The session cookie lasts as long as the session, and browsers keep a cookie at most 400 days:
 * Better Auth refuses to set a longer one, and sign-up and sign-in then fail with a server error.
 */
export const MAX_SESSION_DAYS = 400;

/**
 * SESSION_MAX_AGE_DAYS as whole days from 1 to 400. More days than that give 400, the longest a
 * browser keeps the cookie; anything else that isn't a whole number of days gives the default.
 */
export function sessionDaysFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SESSION_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) return DEFAULT_SESSION_DAYS;
  return Math.min(days, MAX_SESSION_DAYS);
}

/**
 * Better Auth's `session.expiresIn` and `updateAge` (seconds) for sessions lasting `days`. A session
 * is extended once a day while in use, or twice a day when it only lasts one, so it is always
 * extended before it runs out.
 */
export function sessionLifetime(days: number): { expiresIn: number; updateAge: number } {
  const expiresIn = days * DAY_SECONDS;
  return { expiresIn, updateAge: Math.min(DAY_SECONDS, expiresIn / 2) };
}
