import type { YjsThreadStore } from "@blocknote/core/yjs";
import type * as Y from "yjs";
import { CommentError, PAGE_THREAD_METADATA, type CommentOp } from "@/lib/comments";

/**
 * One comment change on a map of threads, for the threads in a page's document (collab/service.ts)
 * and those on a row's property values (server/property-comments.ts), which keep theirs apart.
 */

/** BlockNote's thread store throws plain errors; comment callers get CommentErrors instead. */
export function commentError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof CommentError) return error;
  if (error.message === "Not authorized") return new CommentError("You can't do that with this comment", "notAllowed");
  if (/not found|already deleted/i.test(error.message)) return new CommentError("That comment doesn't exist anymore", "notFound");
  return error;
}

/**
 * Applies one comment change through BlockNote's thread store, which checks what the actor may do.
 * A new thread gets `metadata`; without it, one quoting nothing is about the whole page.
 */
export function runOp(store: YjsThreadStore, threads: Y.Map<unknown>, op: CommentOp, metadata?: Record<string, unknown>): Promise<unknown> {
  const body = (value: unknown) => value as Parameters<YjsThreadStore["addComment"]>[0]["comment"]["body"];
  switch (op.type) {
    case "createThread":
      // A thread quoting nothing is about the whole page; it says so, not that its text was deleted.
      return store.createThread({
        initialComment: { body: body(op.body) },
        ...(metadata ? { metadata } : op.anchor ? {} : { metadata: PAGE_THREAD_METADATA }),
      });
    case "addComment":
      return store.addComment({ threadId: op.threadId, comment: { body: body(op.body) } });
    case "updateComment":
      return store.updateComment({ threadId: op.threadId, commentId: op.commentId, comment: { body: body(op.body) } });
    case "deleteComment":
      return store.deleteComment({ threadId: op.threadId, commentId: op.commentId });
    case "deleteThread":
      // The store reads the thread before checking it exists.
      if (!threads.has(op.threadId)) return Promise.reject(new CommentError("That thread doesn't exist anymore", "notFound"));
      return store.deleteThread({ threadId: op.threadId });
    case "resolveThread":
      return store.resolveThread({ threadId: op.threadId });
    case "unresolveThread":
      return store.unresolveThread({ threadId: op.threadId });
    case "addReaction":
      return store.addReaction({ threadId: op.threadId, commentId: op.commentId, emoji: op.emoji });
    case "deleteReaction":
      return store.deleteReaction({ threadId: op.threadId, commentId: op.commentId, emoji: op.emoji });
  }
}
