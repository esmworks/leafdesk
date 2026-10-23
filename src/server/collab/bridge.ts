/**
 * The collab service lives in the custom server's module graph (server.ts), next to the
 * Hocuspocus instance. Next.js bundles route handlers separately, so they reach it through
 * this global and exchange only plain data — never Yjs objects — which keeps a single Yjs
 * module instance in the process.
 */

import type { BlockEdit } from "@/lib/block-edits";
import type { CommentOp, PlainComment, PlainThread } from "@/lib/comments";
import type { PageStyle } from "@/lib/page-style";
import type { Decision, SuggestionSummary } from "@/lib/suggestions";

export type CommentOpResult = {
  /** The thread after the change; missing when it was deleted. */
  thread?: PlainThread;
  /** A comment the change added. */
  comment?: PlainComment;
  /** New threads with an anchor: whether its text was found and marked. */
  anchored?: boolean;
};

export type WriteActor = { userId: string; oauthClientId?: string | null };

/** A suggested edit that was accepted or rejected, with the thread it had (null when none). */
export type AnsweredSuggestion = SuggestionSummary & { threadId: string | null };

export type PageContent = { title: string; markdown: string; text: string };

/**
 * A write of the page's body or title that reached the live document but couldn't be saved to the
 * database (see collab/service.ts persistPage). Told apart by `code` rather than its class: route
 * handlers are bundled apart from the collab service and don't share its classes.
 */
export const PAGE_SAVE_FAILED = "pageSaveFailed";

export function pageSaveFailedError(cause: unknown) {
  return Object.assign(new Error("The page couldn't be saved", { cause }), { code: PAGE_SAVE_FAILED });
}

export const isPageSaveFailed = (error: unknown) => (error as { code?: unknown } | null)?.code === PAGE_SAVE_FAILED;

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
  /**
   * Current title and body as BlockNote blocks (plain JSON), from the live document when it is open.
   * With `synced`, each synced block the page is the source of holds its blocks as children, as
   * the page's Markdown has them (server/synced-body.ts); for reading only, never to write back.
   */
  readBlocks(pageId: string, options?: { synced?: boolean }): Promise<{ title: string; blocks: unknown[] }>;
  /**
   * The blocks of the page's synced blocks `syncIds` (lib/synced-blocks), from the live document
   * when it is open, by sync id; one the page body no longer holds the source of is left out.
   * Unchecked: callers decide who may read them (server/synced-blocks.ts).
   */
  readSynced(pageId: string, syncIds: string[]): Promise<Map<string, unknown[]>>;
  /**
   * A short hash of the body's Markdown as a write would find it (the live document when it is
   * open), so a writer can tell whether the body changed since it read it. Comments don't change it.
   */
  pageVersion(pageId: string): Promise<string>;
  /**
   * Replaces the body. Snapshots first when `snapshot` is set: `true` for MCP writes (offered for
   * review), `"before_markdown_edit"` for a save from the Markdown source view. This and the other
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
    snapshot?: boolean | "before_markdown_edit",
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
  /**
   * Edits the body block by block (lib/block-edits): each edit's Markdown parsed as appendContent
   * parses it, then the edits made in order. `missing` names a block id the body doesn't have:
   * nothing is written then. `dryRun` writes nothing and returns the body before and after.
   */
  editBlocks(
    pageId: string,
    edits: BlockEdit[],
    actor: WriteActor,
    options?: { snapshot?: boolean; dryRun?: boolean } & VersionCheck,
  ): Promise<BodyWrite & { missing: string | null; before?: unknown[]; after?: unknown[] }>;
  /** The body's blocks a read with block ids lists (lib/block-edits listedBlocks), each as Markdown. */
  blockMarkdown(pageId: string): Promise<{ id: string; markdown: string }[]>;
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
   * Changes some props of the first block of type `type` that `find` picks (by its current props),
   * wherever it sits, in place: only the props `update` returns are set, so edits people make to
   * the rest of the page (or to the block's other props) at the same time are never undone.
   * `update` gets the block's current props and returns the props to set, or null to set none.
   * Resolves to the block's props after the change, or null when the page has no such block.
   * Refuses a locked page or one in the trash, like the other writes.
   */
  updateBlockAttributes(
    pageId: string,
    type: string,
    find: (props: Record<string, unknown>) => boolean,
    update: (props: Record<string, unknown>) => Record<string, string | number> | null,
    actor: WriteActor,
  ): Promise<Record<string, unknown> | null>;
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
  /**
   * Brings what database rows merged into this one hold (server/merge-rows.ts): each source's body,
   * when it isn't empty, goes after the page's own under a heading (`heading`), its blocks with ids
   * of their own; and its comment threads come along as they are (who wrote what, and when), on
   * the same text where the page now has it, else about the whole page, saying which row they came
   * from (`title`). The page is saved to its history first. The sources stay as they are.
   */
  mergeInto(
    pageId: string,
    sources: { pageId: string; title: string; heading: string }[],
    actor: WriteActor,
  ): Promise<{ bodies: number; threads: number }>;
  /** The page's comment threads, from the live document when it is open. */
  readThreads(pageId: string): Promise<PlainThread[]>;
  /**
   * Applies a comment change to the page's live document (see server/comments.ts, which checks
   * access first). A new thread with an anchor is marked on that text, or not created when the page
   * doesn't have it. Throws CommentError when the thread or comment is missing or the actor may not
   * do it.
   */
  commentOp(pageId: string, actor: CommentActor, op: CommentOp): Promise<CommentOpResult>;
  /** The body's pending suggested edits (lib/suggestions), from the live document when it is open. */
  readSuggestions(pageId: string): Promise<SuggestionSummary[]>;
  /**
   * Accepts or rejects suggested edits in the page's live document, `ids` or every one (null), and
   * resolves their threads as `actor` (server/suggestions.ts checks access first). Returns the ones
   * it found: the others were answered or withdrawn already.
   */
  resolveSuggestions(pageId: string, decision: Decision, ids: string[] | null, actor: WriteActor): Promise<AnsweredSuggestion[]>;
  /**
   * The page was locked or unlocked (server/pages.ts setPageLocked). Locking makes its open browser
   * connections read-only at once; unlocking makes those of people who may edit it writable again.
   */
  pageLockChanged(pageId: string, locked: boolean): Promise<void>;
  /**
   * The pages went to the trash, or came back from it (server/pages.ts). Trashing makes their open
   * browser connections read-only at once; restoring makes those of people who may edit them
   * writable again, unless a page is locked.
   */
  pagesTrashed(pageIds: string[], trashed: boolean): Promise<void>;
  /** Tells subscribed clients to refetch (sidebar tree, database rows). */
  broadcast(channel: Channel, event: string): void;
  /**
   * Sends `event` to one person's open connections to `channel` only (their other tabs included),
   * for what concerns nobody else; returns how many connections got it.
   */
  sendTo(channel: Channel, userId: string, event: string): number;
  /** Drops a user's live connections to the workspace's documents (after removal from it). */
  disconnectUser(userId: string, workspaceId: string): Promise<void>;
  /**
   * Drops the connections to the workspace's documents that its sign-in policies now hold back
   * (after it started requiring two-step verification or single sign-on, or changed its approved
   * networks).
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
   * again, after their access changed (a share, a page moved, a group or teamspace, a role). Drops
   * those they may no longer open, or no longer edit through a connection that can; they reconnect
   * with whatever access they have left. A read-only connection to a page they may edit now takes
   * their edits from then on, without a reconnect, unless the page is locked or in the trash.
   */
  disconnectLostAccess(workspaceId: string, userIds?: string[]): Promise<void>;
  /** The pages and databases with a document open on this server. */
  openPageIds(): string[];
  /** The people with the page open in a browser on this server right now (to read or to edit). */
  openUserIds(pageId: string): string[];
  /**
   * Drops every connection to a deleted workspace: its signals and these pages and databases (its
   * own open ones, listed before they were deleted, since the database can no longer say which
   * they were).
   */
  disconnectWorkspace(workspaceId: string, pageIds: string[]): Promise<void>;
  /**
   * Saves every open document's pending edits now (collab/shutdown.ts saveOpenDocuments), so the
   * database holds them; false when that took too long. Connections stay open.
   */
  saveOpen(): Promise<boolean>;
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
