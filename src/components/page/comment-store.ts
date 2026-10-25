import { DefaultThreadStoreAuth, ThreadStoreAuth, type CommentData, type ThreadData } from "@blocknote/core/comments";
import { YjsThreadStoreBase } from "@blocknote/core/yjs";
import type * as Y from "yjs";
import { changeCommentsAction, propertyThreadsAction } from "@/app/actions/comments";
import { loadedPageTitle } from "./mentions";
import { setPropertyThreadCounts } from "./property-threads";
import { mentionsAsText, type CommentAnchor, type CommentOp, type PlainComment, type PlainThread } from "@/lib/comments";

/**
 * Comments in the editor: read live from the page's document like BlockNote's Yjs store, written
 * through the server (see server/comments.ts), which checks each change and writes it into the
 * document for every open editor. A database row's threads on its property values aren't in the
 * document (server/property-comments.ts): the store loads those the viewer sees from the server and
 * lists them with the others.
 */

/** People who may only view a page read its comments but can't write any. */
class ReadOnlyThreadStoreAuth extends ThreadStoreAuth {
  canCreateThread = () => false;
  canAddComment = () => false;
  canUpdateComment = () => false;
  canDeleteComment = () => false;
  canDeleteThread = () => false;
  canResolveThread = () => false;
  canUnresolveThread = () => false;
  canAddReaction = () => false;
  canDeleteReaction = () => false;
}

/** What the viewer may do with comments: full access is BlockNote's "editor", edit access its "comment". */
function authFor(userId: string, level: "view" | "comment" | "content" | "edit" | "full"): ThreadStoreAuth {
  if (level === "view") return new ReadOnlyThreadStoreAuth();
  return new DefaultThreadStoreAuth(userId, level === "full" ? "editor" : "comment");
}

/**
 * The viewer's comment rights, changeable without making a new editor (a store's auth is fixed):
 * a page goes read-only while offline or once trashed, and back.
 */
export class CommentAuth extends ThreadStoreAuth {
  private current: ThreadStoreAuth = new ReadOnlyThreadStoreAuth();

  set(userId: string, level: "view" | "comment" | "content" | "edit" | "full") {
    this.current = authFor(userId, level);
  }

  canCreateThread = () => this.current.canCreateThread();
  canAddComment = (thread: ThreadData) => this.current.canAddComment(thread);
  canUpdateComment = (comment: CommentData) => this.current.canUpdateComment(comment);
  canDeleteComment = (comment: CommentData) => this.current.canDeleteComment(comment);
  canDeleteThread = (thread: ThreadData) => this.current.canDeleteThread(thread);
  canResolveThread = (thread: ThreadData) => this.current.canResolveThread(thread);
  canUnresolveThread = (thread: ThreadData) => this.current.canUnresolveThread(thread);
  canAddReaction = (comment: CommentData, emoji?: string) => this.current.canAddReaction(comment, emoji);
  canDeleteReaction = (comment: CommentData, emoji?: string) => this.current.canDeleteReaction(comment, emoji);
}

/** A failed comment change; `code` says why (see CommentFailure). */
export class CommentChangeError extends Error {
  constructor(readonly code: string) {
    super(`Comment change failed: ${code}`);
    this.name = "CommentChangeError";
  }
}

const date = (iso: string | null) => (iso ? new Date(iso) : undefined);

function toComment(c: PlainComment): CommentData {
  const base = {
    type: "comment" as const,
    id: c.id,
    userId: c.userId,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    reactions: c.reactions.map((r) => ({ emoji: r.emoji, createdAt: new Date(c.createdAt), userIds: r.userIds })),
    metadata: undefined,
  };
  return c.deletedAt ? { ...base, deletedAt: new Date(c.deletedAt), body: undefined } : { ...base, body: c.body };
}

function toThread(t: PlainThread): ThreadData {
  return {
    type: "thread",
    id: t.id,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    comments: t.comments.map(toComment),
    resolved: t.resolved,
    resolvedBy: t.resolvedBy ?? undefined,
    resolvedUpdatedAt: date(t.resolved ? t.updatedAt : null),
    // A thread on a property value says which, with the name to show (see propertyNameOf).
    metadata: t.property ? { property: t.property.id, propertyName: t.property.name } : undefined,
  };
}

/** The name of the property a thread is about, for threads on a row's property values. */
export const propertyNameOf = (metadata: unknown): string | null => {
  const name = typeof metadata === "object" && metadata !== null ? (metadata as { propertyName?: unknown }).propertyName : undefined;
  return typeof name === "string" ? name : null;
};

export class ServerThreadStore extends YjsThreadStoreBase {
  /** The row's threads on property values, as last loaded. */
  private onProperties = new Map<string, ThreadData>();
  private listeners = new Set<(threads: Map<string, ThreadData>) => void>();
  private loads = 0;

  constructor(
    private readonly pageId: string,
    threads: Y.Map<unknown>,
    auth: ThreadStoreAuth,
    /** The page is a database row, which may have threads on its property values. */
    private readonly row = false,
  ) {
    super(threads, auth);
  }

  /** The text a new thread is about: the editor's selection (set once the editor exists). */
  public anchor: () => CommentAnchor | undefined = () => undefined;

  /** Loads the row's threads on property values (again); nothing for other pages. */
  public loadPropertyThreads = async () => {
    if (!this.row) return;
    const load = ++this.loads;
    let threads: PlainThread[];
    try {
      threads = await propertyThreadsAction(this.pageId);
    } catch {
      return;
    }
    // Only the latest load counts: an earlier one may answer last.
    if (load !== this.loads) return;
    this.onProperties = new Map(threads.map((t) => [t.id, toThread(t)]));
    const open = new Map<string, number>();
    for (const t of threads) if (t.property && !t.resolved) open.set(t.property.id, (open.get(t.property.id) ?? 0) + 1);
    setPropertyThreadCounts(this.pageId, open);
    const all = this.getThreads();
    this.listeners.forEach((listener) => listener(all));
  };

  public getThread(threadId: string): ThreadData {
    return this.onProperties.get(threadId) ?? super.getThread(threadId);
  }

  public getThreads(): Map<string, ThreadData> {
    const threads = super.getThreads();
    if (!this.onProperties.size) return threads;
    return new Map([...threads, ...this.onProperties]);
  }

  public subscribe(cb: (threads: Map<string, ThreadData>) => void): () => void {
    const off = super.subscribe(() => cb(this.getThreads()));
    this.listeners.add(cb);
    return () => {
      off();
      this.listeners.delete(cb);
    };
  }

  private async change(op: CommentOp) {
    const result = await changeCommentsAction(this.pageId, op);
    if (!result.ok) {
      // A legal hold keeps the comment: the editor shows no failures of its own, so it is said here.
      if ("message" in result && result.message) window.alert(result.message);
      throw new CommentChangeError(result.code);
    }
    // Others hear of it through the row's document (PROPERTY_COMMENTS_EVENT); this browser at once.
    if (result.thread?.property || (op.type !== "createThread" && this.onProperties.has(op.threadId))) await this.loadPropertyThreads();
    return result;
  }

  /** Starts a thread on the row's property `propertyId`; `body` is plain text, a paragraph a line. */
  public createPropertyThread = async (propertyId: string, body: string) => {
    const { thread } = await this.change({ type: "createThread", body, propertyId });
    if (!thread) throw new CommentChangeError("notFound");
    return toThread(thread);
  };

  // The server marks the thread's text with the thread (see createThread), so people who may only
  // comment, whose editors can't write the page, comment the same way.
  public addThreadToDocument = async () => {};

  public createThread = async (options: { initialComment: { body: unknown } }) => {
    const { thread } = await this.change({ type: "createThread", body: sendable(options.initialComment.body), anchor: this.anchor() });
    if (!thread) throw new CommentChangeError("notFound");
    return toThread(thread);
  };

  public addComment = async (options: { comment: { body: unknown }; threadId: string }) => {
    const { comment } = await this.change({ type: "addComment", threadId: options.threadId, body: sendable(options.comment.body) });
    if (!comment) throw new CommentChangeError("notFound");
    return toComment(comment);
  };

  public updateComment = async (options: { comment: { body: unknown }; threadId: string; commentId: string }) => {
    await this.change({ type: "updateComment", threadId: options.threadId, commentId: options.commentId, body: sendable(options.comment.body) });
  };

  public deleteComment = async (options: { threadId: string; commentId: string }) => {
    await this.change({ type: "deleteComment", threadId: options.threadId, commentId: options.commentId });
  };

  public deleteThread = async (options: { threadId: string }) => {
    await this.change({ type: "deleteThread", threadId: options.threadId });
  };

  public resolveThread = async (options: { threadId: string }) => {
    await this.change({ type: "resolveThread", threadId: options.threadId });
  };

  public unresolveThread = async (options: { threadId: string }) => {
    await this.change({ type: "unresolveThread", threadId: options.threadId });
  };

  public addReaction = async (options: { threadId: string; commentId: string; emoji: string }) => {
    await this.change({ type: "addReaction", ...options });
  };

  public deleteReaction = async (options: { threadId: string; commentId: string; emoji: string }) => {
    await this.change({ type: "deleteReaction", ...options });
  };
}

/** What a comment box sends: page and date mentions as their text (lib/comments mentionsAsText). */
const sendable = (body: unknown) => mentionsAsText(body, loadedPageTitle);
