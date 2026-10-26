import { sharedLimiter, takeAll } from "@/lib/rate-limit";

/**
 * How many invitation emails go out (server/workspaces.ts `emailInvitation`): anyone with an
 * account has a workspace of their own to invite from, and inviting the same address again sends
 * again. Counted per person inviting, per workspace and per address invited, each an hour; past
 * a limit the invitation is still made or renewed, only its email isn't sent (the link is there
 * to share, as when the server has no email).
 */
export const INVITATION_EMAIL_LIMITS = {
  /** Two lists of the most addresses one "Add members" takes (MAX_BULK_EMAILS). */
  actor: [100, 60 * 60_000],
  workspace: [200, 60 * 60_000],
  /** So nobody's inbox fills with invitations, from one workspace or many. */
  recipient: [3, 60 * 60_000],
} as const;

function limiter(kind: keyof typeof INVITATION_EMAIL_LIMITS) {
  const [count, windowMs] = INVITATION_EMAIL_LIMITS[kind];
  return sharedLimiter(`invitation-email:${kind}`, count, windowMs);
}

/** Takes one invitation email from every limit, or none: false when one of them is used up. */
export function takeInvitationEmail(actorId: string, workspaceId: string, email: string, now = Date.now()) {
  const wait = takeAll(
    [
      [limiter("actor"), actorId],
      [limiter("workspace"), workspaceId],
      [limiter("recipient"), email.toLowerCase()],
    ],
    now,
  );
  return wait === 0;
}
