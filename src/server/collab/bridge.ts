/**
 * The collab service lives in the custom server's module graph (server.ts), next to the
 * Hocuspocus instance. Next.js bundles route handlers separately, so they reach it through
 * this global and exchange only plain data — never Yjs objects — which keeps a single Yjs
 * module instance in the process.
 */

import type { CommentOp, PlainComment, PlainThread } from "@/lib/comments";

export type CommentOpResult = {
  /** The thread after the change; missing when it was deleted. */
  thread?: PlainThread;
  /** A comment the change added. */
  comment?: PlainComment;
  /** New threads with an anchor: whether its text was found and marked. */
  anchored?: boolean;
};

export type WriteActor = { userId: string; oauthClientId?: string | null };

export type PageContent = { title: string; markdown: string; text: string };

/** Signal channels, and a page's own document (its open editors hear PAGE_HEADER_EVENT on it). */
export type Channel = `ws:${string}` | `db:${string}` | `page:${string}`;

/** Who writes a comment change: "editor" may also delete other people's comments and threads. */
export type CommentActor = { userId: string; role: "comment" | "editor" };

export interface CollabService {
  /** Current content, read from the live document when it is open. */
  readPage(pageId: string): Promise<PageContent>;
  /** Current title and body as BlockNote blocks (plain JSON), from the live document when it is open. */
  readBlocks(pageId: string): Promise<{ title: string; blocks: unknown[] }>;
  /**
   * Replaces the body. Snapshots first when `snapshot` is set (MCP writes). This and the other
   * writes of the title or body below refuse a locked page (lib/page-lock).
   */
  /**
   * `wikilinks: false` leaves `[[Title]]` as written (imports, which resolve their own links);
   * otherwise it links to the page of that title the writer can open (lib/wikilinks).
   */
  replaceContent(pageId: string, markdown: string, actor: WriteActor, snapshot?: boolean, options?: { wikilinks?: boolean }): Promise<void>;
  appendContent(pageId: string, markdown: string, actor: WriteActor, snapshot?: boolean): Promise<void>;
  /** Adds BlockNote blocks (plain JSON, e.g. an image block) to the end of the body. */
  appendBlocks(pageId: string, blocks: unknown[], actor: WriteActor, snapshot?: boolean): Promise<void>;
  /**
   * Turns the first place the body writes `title` in plain text into a mention of `targetId` (see
   * lib/link-context linkTitle). Returns the new body's blocks, or null when the title isn't there.
   */
  linkPageMention(pageId: string, targetId: string, title: string, actor: WriteActor): Promise<unknown[] | null>;
  setTitle(pageId: string, title: string, actor: WriteActor): Promise<void>;
  restoreSnapshot(snapshotId: string, actor: WriteActor): Promise<void>;
  /**
   * Saves the page as it is now (the live document when it is open) as a history version, e.g.
   * before the editor's AI assistant applies a suggestion in the browser.
   */
  snapshot(pageId: string, reason: "before_ai_edit" | "manual", actor: WriteActor): Promise<void>;
  /** The page's comment threads, from the live document when it is open. */
  readThreads(pageId: string): Promise<PlainThread[]>;
  /**
   * Applies a comment change to the page's live document (see server/comments.ts, which checks
   * access first). A new thread with an anchor is marked on that text, or not created when the page
   * doesn't have it. Throws CommentError when the thread or comment is missing or the actor may not
   * do it.
   */
  commentOp(pageId: string, actor: CommentActor, op: CommentOp): Promise<CommentOpResult>;
  /**
   * The page was locked or unlocked (server/pages.ts setPageLocked). Locking makes its open browser
   * connections read-only at once; unlocking makes those of people who may edit it writable again.
   */
  pageLockChanged(pageId: string, locked: boolean): Promise<void>;
  /** Tells subscribed clients to refetch (sidebar tree, database rows). */
  broadcast(channel: Channel, event: string): void;
  /** Drops a user's live connections to the workspace's documents (after removal from it). */
  disconnectUser(userId: string, workspaceId: string): Promise<void>;
  /**
   * Drops the connections to the workspace's documents whose session doesn't pass two-step
   * verification (after the workspace started requiring it).
   */
  disconnectHeldBack(workspaceId: string): Promise<void>;
  /**
   * Drops the user's browser connections, in every workspace, except those of the sessions in
   * `keep` (after signing out other sessions; an empty list drops them all, as for a deleted
   * account). Connections whose token names no session are dropped only when `keep` is empty.
   */
  disconnectSessions(userId: string, keep: string[]): Promise<void>;
  /**
   * Drops the connections to the teamspace's pages and databases (of these users, or everyone's),
   * after its access narrowed or they left it. They reconnect with whatever access they have left.
   */
  disconnectTeamspace(teamspaceId: string, userIds?: string[]): Promise<void>;
  /**
   * Checks the open page and database connections of these users (or everyone's) in the workspace
   * again and drops those they may no longer open, or no longer edit through a connection that can
   * (after a share was narrowed, a page moved, or a group lost a grant, a member, or a teamspace).
   * They reconnect with whatever access they have left.
   */
  disconnectLostAccess(workspaceId: string, userIds?: string[]): Promise<void>;
}

const KEY = "__leafdeskCollab";

export function registerCollab(service: CollabService) {
  (globalThis as Record<string, unknown>)[KEY] = service;
}

export function getCollab(): CollabService {
  const service = (globalThis as Record<string, unknown>)[KEY] as CollabService | undefined;
  if (!service) {
    throw new Error("Collab service unavailable: start the app with `pnpm dev` / `pnpm start` (server.ts).");
  }
  return service;
}
