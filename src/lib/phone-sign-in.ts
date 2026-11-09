/**
 * Signing a phone in with a QR code (server/phone-sign-in.ts): the account page shows a link as a
 * QR code, the phone opens it and confirms, and Better Auth's `/phone-sign-in` endpoint gives that
 * browser a session of the same person. Pure, for the page, the endpoint and the tests.
 */

/** How long a code shown on the account page signs a phone in. */
export const PHONE_SIGN_IN_SECONDS = 120;

/** Better Auth's endpoint (under /api/auth) that turns a code into a session. */
export const PHONE_SIGN_IN_ENDPOINT = "/phone-sign-in";

/** What the endpoint answers when it refuses, for the phone's page to explain. */
export const PHONE_SIGN_IN_ERRORS = ["PHONE_LINK_INVALID", "PHONE_LINK_SSO", "PHONE_LINK_TWO_FACTOR"] as const;
export type PhoneSignInError = (typeof PHONE_SIGN_IN_ERRORS)[number];

export const isPhoneSignInError = (value: unknown): value is PhoneSignInError =>
  typeof value === "string" && (PHONE_SIGN_IN_ERRORS as readonly string[]).includes(value);

/** A token as the server makes them: 32 random bytes, base64url. Anything else is never looked up. */
export const isPhoneToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** The address the QR code holds: the phone's confirmation page. */
export const phoneSignInUrl = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/phone-sign-in/${token}`;

/** Whole seconds left until `expiresAt`, never below 0. */
export function secondsLeft(expiresAt: string | Date, now = Date.now()) {
  const end = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
}
