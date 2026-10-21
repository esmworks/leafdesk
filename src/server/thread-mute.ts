import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { threadMute } from "@/db/schema";
import { CommentError } from "@/lib/comments";
import { requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";

/**
 * Muting the replies in one comment thread: the person no longer hears about new comments there
 * (inbox, email or push), until they post in it again or someone mentions them in it (see
 * replyAudience in lib/comments). Whole pages are muted in server/page-watch.ts instead.
 */

/** The threads of the page whose replies `userId` muted. */
export async function mutedThreads(userId: string, pageId: string): Promise<string[]> {
  await requirePageAccess(userId, pageId, "view");
  const rows = await db
    .select({ threadId: threadMute.threadId })
    .from(threadMute)
    .where(and(eq(threadMute.pageId, pageId), eq(threadMute.userId, userId)));
  return rows.map((r) => r.threadId);
}

/** Mutes the replies in a thread of the page (true) or hears about them again (false), for someone who can open it. */
export async function setThreadMuted(userId: string, pageId: string, threadId: string, muted: boolean) {
  await requirePageAccess(userId, pageId, "view");
  if (muted) {
    const threads = await getCollab().readThreads(pageId);
    if (!threads.some((t) => t.id === threadId)) throw new CommentError("That comment doesn't exist anymore", "notFound");
    await db.insert(threadMute).values({ pageId, threadId, userId }).onConflictDoNothing();
  } else {
    await unmuteThread(pageId, threadId, [userId]);
  }
  return muted;
}

/** Those of the thread's people who muted its replies. */
export async function threadMuters(pageId: string, threadId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: threadMute.userId })
    .from(threadMute)
    .where(and(eq(threadMute.pageId, pageId), eq(threadMute.threadId, threadId)));
  return rows.map((r) => r.userId);
}

/** Ends the mutes of `userIds` on the thread. */
export async function unmuteThread(pageId: string, threadId: string, userIds: string[]) {
  if (!userIds.length) return;
  await db
    .delete(threadMute)
    .where(and(eq(threadMute.pageId, pageId), eq(threadMute.threadId, threadId), inArray(threadMute.userId, userIds)));
}

/** A thread was deleted: nobody's mute of it is kept. */
export async function forgetThreadMutes(pageId: string, threadId: string) {
  await db.delete(threadMute).where(and(eq(threadMute.pageId, pageId), eq(threadMute.threadId, threadId)));
}
