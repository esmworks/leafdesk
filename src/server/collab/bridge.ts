/**
 * The collab service lives in the custom server's module graph (server.ts), next to the
 * Hocuspocus instance. Next.js bundles route handlers separately, so they reach it through
 * this global and exchange only plain data — never Yjs objects — which keeps a single Yjs
 * module instance in the process.
 */

import type { CommentOp, PlainComment, PlainThread } from "@/lib/comments";
import type { PageStyle } from "@/lib/page-style";

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

/**
 * A body write that checked or reported the body's version (see CollabService.pageVersion):
 * `conflict` when the body no longer had the version the writer expected, and nothing was written.
 * `version` is the body's version after the write, or the current one on a conflict.
 */
export type BodyWrite = { conflict: boolean; version: string };

/** `expectedVersion` writes only while the body still has that version; either reports a BodyWrite. */
export type VersionCheck = { expectedVersion?: string; reportVersion?: boolean };

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
   * A short hash of the body's Markdown as a write would find it (the live document when it is
   * open), so a writer can tell whether the body changed since it read it. Comments don't change it.
   */
  pageVersion(pageId: string): Promise<string>;
  /**
   * Replaces the body. Snapshots first when `snapshot` is set (MCP writes). This and the other
   * writes of the title or body below refuse a locked page (lib/page-lock).
   */
  /**
   * `wikilinks: false` leaves `[[Title]]` as written (imports, which resolve their own links);
   * otherwise it links to the page of that title the writer can open (lib/wikilinks).
   */
  replaceContent(
    pageId: string,
    markdown: string,
    actor: WriteActor,
    snapshot?: boolean,
    options?: { wikilinks?: boolean } & VersionCheck,
  ): Promise<BodyWrite | null>;
  appendContent(pageId: string, markdown: string, actor: WriteActor, snapshot?: boolean, options?: VersionCheck): Promise<BodyWrite | null>;
  /**
   * Writes the body `transform` makes of the current one (BlockNote blocks as plain JSON), or
   * nothing when it returns null. `snapshot: true` saves the page first as an AI write (offered for
   * review), `"before_restore"` as the way back from undoing one. Reports the body's version after,
   * and whether anything was written (`changed`).
   */
  transformBlocks(
    pageId: string,
    transform: (blocks: unknown[]) => unknown[] | null,
    actor: WriteActor,
    options?: { snapshot?: boolean | "before_restore" } & VersionCheck,
  ): Promise<BodyWrite & { changed: boolean }>;
  /** Adds BlockNote blocks (plain JSON, e.g. an image block) to the end of the body. */
  appendBlocks(pageId: string, blocks: unknown[], actor: WriteActor, snapshot?: boolean): Promise<void>;
  /**
   * Changes the props of the block `blockId`, wherever it sits (in columns or nested too): `update`
   * gets its current props and type and returns the new props, or null to leave the body as it is.
   * Resolves to whether the page has the block.
   */
  updateBlockProps(
    pageId: string,
    blockId: string,
    update: (props: Record<string, unknown>, type: string) => Record<string, unknown> | null,
    actor: WriteActor,
    snapshot?: boolean,
  ): Promise<boolean>;
  /**
   * Turns the first place the body writes `title` in plain text into a mention of `targetId` (see
   * lib/link-context linkTitle). Returns the new body's blocks, or null when the title isn't there.
   */
  linkPageMention(pageId: string, targetId: string, title: string, actor: WriteActor): Promise<unknown[] | null>;
  setTitle(pageId: string, title: string, actor: WriteActor): Promise<void>;
  /** Changes some of the page's style (lib/page-style), as the page menu does. */
  setPageStyle(pageId: string, change: Partial<PageStyle>, actor: WriteActor): Promise<void>;
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
  /** The pages and databases with a document open on this server. */
  openPageIds(): string[];
  /**
   * Drops every connection to a deleted workspace: its signals and these pages and databases (its
   * own open ones, listed before they were deleted, since the database can no longer say which
   * they were).
   */
  disconnectWorkspace(workspaceId: string, pageIds: string[]): Promise<void>;
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
