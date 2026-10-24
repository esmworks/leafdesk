import { suggestionAuthor, type Decision, type SuggestionSummary } from "@/lib/suggestions";
import { redactError } from "@/lib/redact";
import { AccessError, hasLevel, requirePageAccess, resolvePageAccess } from "@/server/access";
import { getCollab, type AnsweredSuggestion } from "@/server/collab/bridge";
import { CommentError } from "@/lib/comments";
import { recordComment } from "@/server/notifications";
import { newThreadAudience } from "@/server/page-watch";
import { followOnTakingPart } from "@/server/row-follow";
import { db } from "@/db";
import { page } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Suggested edits (lib/suggestions): changes to a page's body proposed in suggesting mode, which
 * show as marked text until someone accepts or rejects them. Everyone who can view the page sees
 * them live; the page as it reads elsewhere (Markdown, search, published pages, PDF, exports,
 * history, the API and the AI) leaves them out (synced-body fragmentBlocks).
 *
 * Who may do what:
 * - People who may edit suggest in the editor's suggesting mode, and accept or reject anyone's.
 * - People who may only comment suggest too: their connection takes nothing but their own
 *   suggestions (collab/suggest-guard.ts), so they never edit the page itself. They may withdraw
 *   their own (a rejection), not answer other people's.
 * - The server opens each suggestion's comment thread in its author's name (collab/suggestion-doc
 *   syncSuggestionThreads) and resolves it once the suggestion is answered or withdrawn.
 *
 * Inbox: a new suggestion tells the page's watchers (a row's followers) as a new thread does, and
 * an answer tells its author; both are "comment" notifications whose `message` says which.
 */

/** Most suggestions one call answers by id. */
const MAX_IDS = 500;

function cleanIds(ids: unknown): string[] | null {
  if (ids === null) return null;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || !ids.every((id) => typeof id === "string" && id.length <= 200 && suggestionAuthor(id))) {
    throw new CommentError("That suggestion doesn't exist anymore", "notFound");
  }
  return [...new Set(ids as string[])];
}

/** The page's pending suggested edits, for anyone who can view it. */
export async function listSuggestedEdits(userId: string, pageId: string): Promise<SuggestionSummary[]> {
  await requirePageAccess(userId, pageId, "view");
  return getCollab().readSuggestions(pageId);
}

/**
 * Accepts or rejects suggested edits of the page: `ids`, or every pending one (null). Accepting
 * needs edit access, and so does rejecting other people's; someone who may comment withdraws their
 * own. Returns the ones answered (the others were answered or withdrawn already). Throws
 * AccessError when the person may not, and the page's lock or trash errors when it can't change.
 */
export async function answerSuggestions(userId: string, pageId: string, decision: Decision, ids: unknown): Promise<AnsweredSuggestion[]> {
  if (decision !== "accept" && decision !== "reject") throw new CommentError("Unknown answer", "invalidBody");
  const picked = cleanIds(ids);
  const { page: target, level } = await resolvePageAccess(userId, pageId);
  if (!target || !hasLevel(level, "comment")) throw new AccessError();
  if (!hasLevel(level, "edit") && (decision !== "reject" || !picked || picked.some((id) => suggestionAuthor(id) !== userId))) {
    throw new AccessError();
  }
  const answered = await getCollab().resolveSuggestions(pageId, decision, picked, { userId });
  // Each author hears what became of theirs, once per thread; withdrawing one's own tells nobody.
  for (const suggestion of answered) {
    if (!suggestion.threadId || !suggestion.authorId || suggestion.authorId === userId) continue;
    await recordComment(userId, target.workspaceId, pageId, suggestion.threadId, [suggestion.authorId], decision === "accept" ? "accepted" : "rejected");
  }
  return answered;
}

/**
 * New suggestions reach the page's watchers (a database row's followers) like a new comment thread,
 * from their author, who follows the row from then on. Called by the collab service after a save
 * opened their threads; never throws.
 */
export async function announceSuggestions(workspaceId: string, pageId: string, opened: { threadId: string; authorId: string }[]) {
  try {
    const [row] = await db.select({ createdBy: page.createdBy }).from(page).where(eq(page.id, pageId)).limit(1);
    if (!row) return;
    const audience = await newThreadAudience(pageId, row.createdBy);
    for (const { threadId, authorId } of opened) {
      await recordComment(authorId, workspaceId, pageId, threadId, audience, "suggested");
    }
    await followOnTakingPart(pageId, [...new Set(opened.map((o) => o.authorId))]);
  } catch (error) {
    console.error("[suggestions] could not announce new suggested edits", redactError(error));
  }
}
