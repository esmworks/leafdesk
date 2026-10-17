import { isAgentEmail } from "./agents";

/**
 * The domain of people a restored backup (server/backup) names who have no account on this
 * server: `person-<id>@people.leafdesk.invalid`. They keep what they wrote, commented and were
 * assigned, under their name, but nobody can sign in, get mail or be invited with such an address,
 * and their real address isn't taken from them: they sign up with it as anyone does.
 */
export const RESTORED_EMAIL_DOMAIN = "people.leafdesk.invalid";

export const restoredEmail = (userId: string) => `person-${userId}@${RESTORED_EMAIL_DOMAIN}`;

export const isRestoredEmail = (email: string | null | undefined) =>
  typeof email === "string" && email.trim().toLowerCase().endsWith(`@${RESTORED_EMAIL_DOMAIN}`);

/** An address nobody holds: an agent's or a restored person's. No sign-in, mail or invitation. */
export const isReservedEmail = (email: string | null | undefined) => isAgentEmail(email) || isRestoredEmail(email);
