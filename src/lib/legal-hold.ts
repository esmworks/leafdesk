/**
 * Legal holds (server/legal-hold.ts): what a hold may hold, and the reasons something is refused
 * while one stands. Pure, for the server and the settings tab alike.
 */

export const LEGAL_HOLD_NAME_MAX = 200;
export const LEGAL_HOLD_REASON_MAX = 2000;
/** People one hold covers at most; a larger matter takes several holds. */
export const LEGAL_HOLD_MAX_PEOPLE = 200;

/**
 * - `pageHeld`: the page, or a page under it, was created or edited by someone under a hold;
 * - `templateHeld`, `propertyHeld`, `commentHeld`, `letterheadHeld`: the same for a template, a
 *   deleted property's values, a comment, a PDF letterhead;
 * - `workspaceHeld`: the workspace has a hold, so it can't be deleted;
 * - the rest are about setting or releasing a hold.
 */
export type LegalHoldErrorCode =
  | "pageHeld"
  | "templateHeld"
  | "propertyHeld"
  | "commentHeld"
  | "letterheadHeld"
  | "workspaceHeld"
  | "nameRequired"
  | "nameTooLong"
  | "reasonTooLong"
  | "noPeople"
  | "tooManyPeople"
  | "unknownPerson"
  | "notFound";

export const LEGAL_HOLD_ERROR_CODES: readonly LegalHoldErrorCode[] = [
  "pageHeld",
  "templateHeld",
  "propertyHeld",
  "commentHeld",
  "letterheadHeld",
  "workspaceHeld",
  "nameRequired",
  "nameTooLong",
  "reasonTooLong",
  "noPeople",
  "tooManyPeople",
  "unknownPerson",
  "notFound",
];

export class LegalHoldError extends Error {
  constructor(
    readonly code: LegalHoldErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "LegalHoldError";
  }
}

export type LegalHoldInput = { name: string; reason: string; userIds: string[] };

/** Checks and trims what an owner typed for a new hold; throws LegalHoldError when it won't do. */
export function cleanLegalHoldInput(input: unknown): LegalHoldInput {
  const value = (input ?? {}) as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!name) throw new LegalHoldError("nameRequired", "Give the hold a name.");
  if (name.length > LEGAL_HOLD_NAME_MAX) throw new LegalHoldError("nameTooLong", "The name is too long.");
  if (reason.length > LEGAL_HOLD_REASON_MAX) throw new LegalHoldError("reasonTooLong", "The reason is too long.");
  const ids = Array.isArray(value.userIds) ? value.userIds : [];
  if (ids.some((id) => typeof id !== "string" || !id || id.length > 100)) throw new LegalHoldError("unknownPerson", "Someone isn't in this workspace.");
  const userIds = [...new Set(ids as string[])];
  if (!userIds.length) throw new LegalHoldError("noPeople", "Choose who the hold is on.");
  if (userIds.length > LEGAL_HOLD_MAX_PEOPLE) throw new LegalHoldError("tooManyPeople", "That's too many people for one hold.");
  return { name, reason, userIds };
}

/**
 * Who wrote in a page's comment threads: from the threads map of its Yjs document as `toJSON`
 * gives it (BlockNote's thread store: each thread has `comments`, each comment a `userId`), or
 * from the threads as collab reads them (PlainThread[]). For one thread when `threadId` is given,
 * for one comment of it when `commentId` is too.
 */
export function commentAuthors(threads: unknown, threadId?: string, commentId?: string): Set<string> {
  const out = new Set<string>();
  if (!threads || typeof threads !== "object") return out;
  const entries = Array.isArray(threads)
    ? threads.map((thread) => [(thread as { id?: unknown } | null)?.id, thread] as const)
    : Object.entries(threads as Record<string, unknown>);
  for (const [id, thread] of entries) {
    if (threadId !== undefined && id !== threadId) continue;
    const comments = (thread as { comments?: unknown } | null)?.comments;
    if (!Array.isArray(comments)) continue;
    for (const comment of comments as { id?: unknown; userId?: unknown }[]) {
      if (commentId !== undefined && comment?.id !== commentId) continue;
      if (typeof comment?.userId === "string") out.add(comment.userId);
    }
  }
  return out;
}
