import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { threadState } from "@/db/schema";
import { CommentError } from "@/lib/comments";
import { requirePageAccess } from "@/server/access";
import { threadsVisibleTo } from "@/server/property-comments";

/**
 * Each person's own state of a page's comment threads: the threads they marked to come back to
 * later, and when they last saw each one in the page's comments, which tells the replies since
 * apart (lib/thread-activity.ts). Anyone who can open the page keeps their own; nobody else sees it.
 */

/** Most threads one call marks seen: a page's comments panel lists them all at once. */
const MAX_SEEN = 500;

export type ThreadStates = {
  /** The threads the viewer marked to come back to later. */
  marked: string[];
  /** When the viewer last saw each thread they saw (ISO). */
  seen: Record<string, string>;
};

/** `userId`'s marks and the times they saw the page's threads. */
export async function threadStates(userId: string, pageId: string): Promise<ThreadStates> {
  await requirePageAccess(userId, pageId, "view");
  const rows = await db
    .select({ threadId: threadState.threadId, markedAt: threadState.markedAt, seenAt: threadState.seenAt })
    .from(threadState)
    .where(and(eq(threadState.pageId, pageId), eq(threadState.userId, userId)));
  return {
    marked: rows.filter((r) => r.markedAt).map((r) => r.threadId),
    seen: Object.fromEntries(rows.flatMap((r) => (r.seenAt ? [[r.threadId, r.seenAt.toISOString()]] : []))),
  };
}

/** The threads of the page that `userId` marked to come back to later. */
export async function markedThreads(userId: string, pageId: string): Promise<string[]> {
  return (await threadStates(userId, pageId)).marked;
}

/** Marks a thread of the page to come back to later (true) or takes the mark off (false). */
export async function setThreadMarked(userId: string, pageId: string, threadId: string, marked: boolean) {
  await requirePageAccess(userId, pageId, "view");
  if (marked) {
    const threads = await threadsVisibleTo(userId, pageId);
    if (!threads.some((t) => t.id === threadId)) throw new CommentError("That comment doesn't exist anymore", "notFound");
    await db
      .insert(threadState)
      .values({ pageId, threadId, userId, markedAt: new Date() })
      .onConflictDoUpdate({ target: [threadState.pageId, threadState.threadId, threadState.userId], set: { markedAt: new Date() } });
  } else {
    await db
      .update(threadState)
      .set({ markedAt: null })
      .where(and(eq(threadState.pageId, pageId), eq(threadState.threadId, threadId), eq(threadState.userId, userId), isNotNull(threadState.markedAt)));
  }
  return marked;
}

/** `userId` has the page's threads `threadIds` in front of them now (threads the page doesn't have are left out). */
export async function markThreadsSeen(userId: string, pageId: string, threadIds: string[]) {
  await requirePageAccess(userId, pageId, "view");
  const wanted = new Set(threadIds.filter((id) => typeof id === "string").slice(0, MAX_SEEN));
  if (!wanted.size) return;
  const ids = (await threadsVisibleTo(userId, pageId)).map((t) => t.id).filter((id) => wanted.has(id));
  if (!ids.length) return;
  await db
    .insert(threadState)
    .values(ids.map((threadId) => ({ pageId, threadId, userId, seenAt: new Date() })))
    .onConflictDoUpdate({ target: [threadState.pageId, threadState.threadId, threadState.userId], set: { seenAt: sql`excluded.seen_at` } });
}

/** A thread was deleted: nobody's mark or time seen of it is kept. */
export async function forgetThreadStates(pageId: string, threadId: string) {
  await db.delete(threadState).where(and(eq(threadState.pageId, pageId), eq(threadState.threadId, threadId)));
}

/** Of `threadIds` of the page, those `userId` marked (no access check: for callers that made one). */
export async function markedAmong(userId: string, pageId: string, threadIds: string[]): Promise<Set<string>> {
  if (!threadIds.length) return new Set();
  const rows = await db
    .select({ threadId: threadState.threadId })
    .from(threadState)
    .where(
      and(eq(threadState.pageId, pageId), eq(threadState.userId, userId), inArray(threadState.threadId, threadIds), isNotNull(threadState.markedAt)),
    );
  return new Set(rows.map((r) => r.threadId));
}
