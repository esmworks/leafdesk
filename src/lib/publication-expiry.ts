/** Furthest ahead a published link's expiry may be set: ten years. */
export const MAX_EXPIRY_MS = 10 * 366 * 24 * 60 * 60 * 1000;

export type ExpiryProblem = "expiryInvalid" | "expiryPast" | "expiryTooFar";

/**
 * A link's new expiry as given (an ISO time or null to keep it working): the time, null, or what is
 * wrong with it. It must be ahead of `now`, by at most MAX_EXPIRY_MS.
 */
export function parseExpiry(value: unknown, now = new Date()): { at: Date | null } | { problem: ExpiryProblem } {
  if (value === null) return { at: null };
  const at = typeof value === "string" && value.length <= 64 ? new Date(value) : null;
  if (!at || !Number.isFinite(at.getTime())) return { problem: "expiryInvalid" };
  if (at.getTime() <= now.getTime()) return { problem: "expiryPast" };
  if (at.getTime() > now.getTime() + MAX_EXPIRY_MS) return { problem: "expiryTooFar" };
  return { at };
}
