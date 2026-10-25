import { createHash } from "node:crypto";
import { Hocuspocus, type Document, type Extension } from "@hocuspocus/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { db } from "@/db";
import { databaseProperty, page, pageSnapshot, type PageKind, type SnapshotReason } from "@/db/schema";
import { applyBlockEdits, listedBlocks, stripBlockMarkers, type BlockEdit } from "@/lib/block-edits";
import { blocksToPlainText } from "@/lib/blocks";
import { linkTitle } from "@/lib/link-context";
import { linkWikilinks, titleKey, wikilinkTitles } from "@/lib/wikilinks";
import { BUILD_PARAM, isForeignBuild } from "@/lib/build-id";
import {
  AI_EDIT_EVENT,
  AUTO_SNAPSHOT_INTERVAL_MS,
  COLLAB_FRAGMENT,
  PAGE_SAVE_FAILED_EVENT,
  PAGE_SAVED_EVENT,
  PAGE_WRITABLE_EVENT,
  SUGGESTION_REFUSED_EVENT,
} from "@/lib/collab-constants";
import {
  CommentError,
  isPageThread,
  PAGE_THREAD_METADATA,
  plainComment,
  plainThread,
  suggestionOfThread,
  THREADS_MAP,
  type PlainThread,
} from "@/lib/comments";
import { markdownImageHint, PG_MARKDOWN_IMAGE_PATTERN } from "@/lib/cover";
import { migrateDocTitle, readDocTitle, writeDocTitle } from "@/lib/collab-title";
import { assertNotInTrash, assertPageUnlocked, isPageLocked } from "@/lib/page-lock";
import type { ReviewBlock } from "@/lib/page-review";
import { writePageStyle } from "@/lib/page-style";
import { syncedBlocksIn, syncedElementsIn, syncedFragmentName, syncedKey, syncedRegions, withoutBlockIds, withoutSyncedBlocks, type SyncedRef } from "@/lib/synced-blocks";
import { requestLocale } from "@/i18n/config";
import { env } from "@/lib/env";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { COLLAB_FORBIDDEN, COLLAB_IP, COLLAB_SSO, COLLAB_STALE, COLLAB_TWO_STEP, COLLAB_UNAUTHORIZED } from "@/lib/offline";
import { AccessError, policyHoldFor, WorkspacePolicyError } from "@/server/access";
import { collabSessionFacts } from "@/server/account-security";
import { serverBuildId } from "@/server/build-id";
import { blocksToMarkdown, markdownToBlocks, serverEditor as editor, type PageBlock } from "@/server/blocknote";
import { authorizeFileReferences, referencedFileIds, unauthorizedFileIds } from "@/server/files";
import { syncMeetingNotes } from "@/server/meeting-notes";
import { syncPageTasks } from "@/server/page-tasks";
import { labelPageLinks, mentionablePeople, pagesNamed, syncPageReferences } from "@/server/mentions";
import { announceSuggestions } from "@/server/suggested-edits";
import { bodyBlocks, fragmentBlocks, syncedBlocksOf } from "@/server/synced-body";
import { syncedSources } from "@/server/synced-blocks";
import { pageChanged } from "@/server/page-events";
import { rowChanged } from "@/server/row-events";
import { recordTitleChange } from "@/server/row-activity";
import { queuePageSave } from "@/server/page-watch";
import { queuePageUpdated } from "@/server/page-webhooks/queue";
import { queueRowSave } from "@/server/row-follow";
import { authorizeCollab, parseDocName as parseName, type DocTarget } from "./authorize";
import { isPageSaveFailed, pageSaveFailedError, type BodyWrite, type Channel, type CollabService, type CommentOpResult, type PageContent, type VersionCheck, type WriteActor } from "./bridge";
import { anchorThread, reanchor, threadQuotes } from "./comment-marks";
import { commentError, runOp } from "./comment-ops";
import { stampPresence } from "./presence";
import { saveOpenDocuments } from "./shutdown";
import { onlyOwnSuggestions } from "./suggest-guard";
import {
  resolveInFragment,
  resolveSuggestionThreads,
  suggestionsIn,
  syncSuggestionThreads,
  writeBlocksAsSuggestions,
  writeBlocksKeepingSuggestions,
  type SuggestionThreadChanges,
} from "./suggestion-doc";
import { touchesThreads } from "./thread-guard";
import { verifyCollabToken } from "./token";

/** `locale`: the interface language of the browser that connected, for emails about its changes. */
type Context = {
  userId?: string;
  userName?: string;
  /** The picture presence shows for them (`user.image`, see lib/avatar). */
  userImage?: string | null;
  /** The browser session the connection's token was issued to. */
  sessionId?: string | null;
  oauthClientId?: string | null;
  locale?: string;
  /** The session passes a "require two-step verification" policy (see authorizeCollab). */
  strong?: boolean;
  /** The SSO provider the session came through, for "SSO only" workspaces. */
  ssoProviderId?: string | null;
  /** The address the websocket came from (set by server.ts on the upgrade), for approved networks. */
  ip?: string | null;
  /**
   * The person may comment on the page but not edit it: the connection takes their own suggested
   * edits and nothing else (suggest-guard.ts).
   */
  suggestOnly?: boolean;
};

const debug = process.env.COLLAB_DEBUG ? (...args: unknown[]) => console.log("[collab]", ...args) : () => {};

const pageDocName = (pageId: string) => `page:${pageId}`;

/** A refused connection; Hocuspocus sends `reason` to the browser with the "permission denied" answer. */
const refusal = (reason: string) => Object.assign(new Error(reason), { reason });

const readTitle = readDocTitle;

const threadsOf = (doc: Y.Doc) => doc.getMap(THREADS_MAP);

function readThreadsOf(doc: Y.Doc): PlainThread[] {
  const threads = threadsOf(doc);
  if (!threads.size) return [];
  const store = new YjsThreadStore("", threads, new DefaultThreadStoreAuth("", "comment"));
  const quotes = threadQuotes(doc.getXmlFragment(COLLAB_FRAGMENT));
  return [...store.getThreads().values()]
    .map((t) => {
      const suggestion = suggestionOfThread(t.metadata);
      return {
        ...plainThread(t),
        quote: quotes.get(t.id) ?? null,
        ...(isPageThread(t.metadata) ? { page: true as const } : {}),
        ...(suggestion ? { suggestion } : {}),
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Runs a write that may replace text carrying comment marks (in the body, or in `fragment`: a
 * synced block's blocks), then puts those marks back where the same text still is, so threads stay
 * anchored.
 */
function keepingComments(doc: Y.Doc, write: () => void, fragment = doc.getXmlFragment(COLLAB_FRAGMENT)) {
  const threads = threadsOf(doc);
  const quotes = threads.size ? threadQuotes(fragment) : new Map<string, string>();
  write();
  reanchor(fragment, quotes, new Set(threads.keys()));
}

/** Blocks with ids of their own (children too), to put a copy of them into another page. */
function withFreshIds<B extends { id?: string; children?: unknown[] }>(blocks: B[]): B[] {
  return blocks.map((block) => ({
    ...block,
    id: crypto.randomUUID(),
    ...(Array.isArray(block.children) ? { children: withFreshIds(block.children as B[]) } : {}),
  }));
}

/** Whether a body holds anything: a block that isn't an empty paragraph. */
function holdsContent(blocks: { type: string; children: unknown[] }[]) {
  return blocks.some((b) => b.type !== "paragraph" || b.children.length > 0 || blocksToPlainText([b as never]).trim() !== "");
}

/** A fresh page holds one empty paragraph; appending drops it instead of leaving a gap. */
function withoutTrailingEmpty<B extends { type: string; children: unknown[] }>(blocks: B[]): B[] {
  return blocks.filter(
    (b, i) => !(i === blocks.length - 1 && b.type === "paragraph" && !blocksToPlainText([b as never]) && !b.children.length),
  );
}

/**
 * The body as blocks, Markdown and text (with its synced blocks' blocks, see bodyBlocks).
 * `workspaceId` is the page's: page mentions link into it.
 */
async function deriveContent(doc: Y.Doc, workspaceId: string | undefined, pageId: string) {
  const blocks = bodyBlocks(doc, pageId);
  const markdown = (await blocksToMarkdown(blocks, { workspaceId })).trim();
  return { blocks, markdown, text: blocksToPlainText(blocks) };
}

/** CollabService.pageVersion of a body read as these blocks: its Markdown as deriveContent writes it, hashed. */
async function versionOf(blocks: Parameters<typeof blocksToMarkdown>[0], workspaceId?: string) {
  const markdown = (await blocksToMarkdown(blocks, { workspaceId })).trim();
  return createHash("sha256").update(markdown).digest("hex").slice(0, 16);
}

/**
 * The server's own writes of a title or body (MCP, the REST API, AI and agents, restoring a version)
 * refuse a locked page or one in the trash, like its browser connections do. Comments and history
 * snapshots go on.
 */
async function assertWritable(pageId: string) {
  const [row] = await db
    .select({ kind: page.kind, lockedAt: page.lockedAt, archivedAt: page.archivedAt })
    .from(page)
    .where(eq(page.id, pageId))
    .limit(1);
  if (!row) return;
  assertNotInTrash(row);
  assertPageUnlocked(row);
}

async function workspaceOf(pageId: string) {
  const [row] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
  return row?.workspaceId;
}

async function insertSnapshot(
  pageId: string,
  doc: Y.Doc,
  reason: SnapshotReason,
  actor: { userId?: string | null; oauthClientId?: string | null },
  fallbackTitle: string,
  name: string | null = null,
) {
  const { markdown } = await deriveContent(doc, await workspaceOf(pageId), pageId);
  const [row] = await db.insert(pageSnapshot).values({
    pageId,
    title: readTitle(doc) ?? fallbackTitle,
    ydoc: Y.encodeStateAsUpdate(doc),
    contentMarkdown: markdown,
    reason,
    name,
    createdBy: actor.userId ?? null,
    oauthClientId: actor.oauthClientId ?? null,
  }).returning({ id: pageSnapshot.id });
  return row.id;
}

async function maybeAutoSnapshot(pageId: string, doc: Y.Doc, markdown: string, title: string, userId?: string) {
  const [last] = await db
    .select({ createdAt: pageSnapshot.createdAt, contentMarkdown: pageSnapshot.contentMarkdown, title: pageSnapshot.title })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.pageId, pageId))
    .orderBy(desc(pageSnapshot.createdAt))
    .limit(1);
  if (last && Date.now() - last.createdAt.getTime() < AUTO_SNAPSHOT_INTERVAL_MS) return;
  if (last && last.contentMarkdown === markdown && last.title === title) return;
  if (!last && !markdown && !title) return;
  await insertSnapshot(pageId, doc, "auto", { userId }, title);
}

/** Whether a database has a property showing when or by whom its rows were last edited. */
async function showsLastEdited(databaseId: string) {
  const [found] = await db
    .select({ id: databaseProperty.id })
    .from(databaseProperty)
    .where(
      and(
        eq(databaseProperty.databaseId, databaseId),
        inArray(databaseProperty.type, ["last_edited_time", "last_edited_by"]),
        isNull(databaseProperty.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(found);
}

export function createCollab() {
  const broadcast = (channel: Channel, event: string) => {
    hocuspocus.documents.get(channel)?.broadcastStateless(event);
  };

  /** Sends `event` to one person's connections to `channel` only; how many got it. */
  const sendTo = (channel: Channel, userId: string, event: string) => {
    const connections = hocuspocus.documents.get(channel)?.getConnections().filter((c) => (c.context as Context).userId === userId) ?? [];
    for (const connection of connections) connection.sendStateless(event);
    return connections.length;
  };

  /** Browser connections only: the server's own writes check the page themselves (assertWritable). */
  const browsersOf = (pageId: string) =>
    hocuspocus.documents.get(pageDocName(pageId))?.getConnections().filter((c) => (c.context as Context).userId !== undefined) ?? [];

  /**
   * The page was locked or trashed. In place, without a reconnect: its browsers' edits are refused
   * from now on (Hocuspocus answers them "not applied"), and the browsers keep them until it can be
   * edited again.
   */
  const closeForWrites = (pageId: string) => {
    for (const connection of browsersOf(pageId)) connection.readOnly = true;
  };

  /**
   * Lets a read-only browser connection write again, in place, and tells that browser: it syncs
   * again (components/collab/socket), sending the edits the server turned down meanwhile. Only for
   * a page's own document: database signal documents stay read-only.
   */
  const reopen = (connection: ReturnType<Document["getConnections"]>[number]) => {
    connection.readOnly = false;
    connection.sendStateless(PAGE_WRITABLE_EVENT);
  };

  /** The page was unlocked or restored: browsers of people who may edit it write again, if it may change at all. */
  const reopenForEditors = async (pageId: string) => {
    const waiting = browsersOf(pageId).filter((c) => c.readOnly);
    if (!waiting.length) return;
    const [current] = await db
      .select({ kind: page.kind, lockedAt: page.lockedAt, archivedAt: page.archivedAt })
      .from(page)
      .where(eq(page.id, pageId))
      .limit(1);
    if (!current || isPageLocked(current) || current.archivedAt) return;
    const userIds = [...new Set(waiting.map((c) => (c.context as Context).userId!))];
    const rows = await db.execute<{ user_id: string; level: number }>(sql`
      select x.user_id, page_access_level(x.user_id, ${pageId})::int as level
      from jsonb_array_elements_text(${JSON.stringify(userIds)}::jsonb) as x(user_id)
    `);
    // 3 and up write the body (content, edit, full), 2 comments (page_access_level): people who may
    // comment suggest again, viewers stay read-only.
    const levels = new Map(rows.map((r) => [r.user_id, Number(r.level)]));
    for (const connection of waiting) {
      const level = levels.get((connection.context as Context).userId!) ?? 0;
      if (level >= 3 || (level === 2 && current.kind === "page")) {
        (connection.context as Context).suggestOnly = level < 3;
        reopen(connection);
      }
    }
  };

  /**
   * Who changed each open document since it was last saved: browsers' connections and the server's
   * own writes (MCP, the REST API, imports, restores) alike, each with the user it acts for. A save
   * can cover changes of several people (saves wait for a pause in typing), so the last of them
   * alone (`lastContext`) wouldn't do for authorizing the files the save adds (see persistPage).
   */
  const writers = new WeakMap<Y.Doc, Set<string>>();
  const takeWriters = (doc: Y.Doc, last?: string) => {
    const found = writers.get(doc) ?? new Set<string>();
    writers.delete(doc);
    if (last) found.add(last);
    return found;
  };

  /**
   * Documents the database refused to save last time (pageSaveFailedError). Hocuspocus only logs a
   * failed save, so the server's own writes look here once theirs is done (see transactPage), and
   * open editors are told (see onStoreDocument). By document rather than name: a name can belong to
   * a newer document already.
   */
  const failedSaves = new WeakMap<Document, Error>();

  const persistPage = async (pageId: string, doc: Document, context?: Context) => {
    const userId = context?.userId;
    const [row] = await db
      .select({
        title: page.title,
        workspaceId: page.workspaceId,
        parentId: page.parentId,
        // Same match as markdownImageHint, without reading the whole old body.
        imageHint: sql<string | null>`substring(${page.contentMarkdown} from ${PG_MARKDOWN_IMAGE_PATTERN})`,
        markdownHash: sql<string | null>`md5(${page.contentMarkdown})`,
      })
      .from(page)
      .where(eq(page.id, pageId))
      .limit(1);
    if (!row) return; // deleted while open
    // Taken in the same synchronous run as the body is read (deriveContent reads it before it
    // awaits anything), so whoever changed what this save writes is among them, and nobody whose
    // change only the next save holds.
    const wrote = takeWriters(doc, userId);
    // Each suggested edit gets its thread in the comments, opened in its author's name (they are
    // among the writers), and the thread of one that is gone is resolved. Before the save, so it
    // holds them; threads and comment marks change nothing the page reads.
    let suggestionThreads: SuggestionThreadChanges = { opened: [], closed: [] };
    try {
      suggestionThreads = syncSuggestionThreads(doc, wrote, { source: "local", context: {} });
    } catch (error) {
      console.error(`[collab] could not update the suggestion threads of page:${pageId}`, error);
    }
    const { blocks, markdown, text } = await deriveContent(doc, row.workspaceId, pageId);
    const title = readTitle(doc) ?? row.title;
    // Comments and their marks change the document but not the page: they don't count as edits.
    const bodyChanged = row.markdownHash !== createHash("md5").update(markdown).digest("hex");
    const edited = title !== row.title || bodyChanged;
    const shownBefore = bodyChanged ? new Set(await referencedFileIds(pageId)) : null;
    try {
      await db
        .update(page)
        .set({
          ydoc: Y.encodeStateAsUpdate(doc),
          contentMarkdown: markdown,
          contentText: text,
          title,
          ...(!edited ? { updatedAt: sql`${page.updatedAt}` } : userId ? { updatedBy: userId } : {}),
        })
        .where(eq(page.id, pageId));
    } catch (error) {
      // Nothing of these changes was saved: the save that retries them counts their writers again.
      const later = writers.get(doc);
      if (later) for (const id of wrote) later.add(id);
      else writers.set(doc, wrote);
      throw pageSaveFailedError(error);
    }
    // Saved: steps after this one failing doesn't make the page unsaved.
    if (failedSaves.delete(doc)) doc.broadcastStateless(PAGE_SAVED_EVENT);
    if (shownBefore) {
      // Files this save put into the body (the trigger recorded them, unauthorized) count for the
      // page's viewers when one of the people who changed it since the last save could read them
      // already; a URL nobody of them could read stays without effect (see server/files.ts).
      const added = (await unauthorizedFileIds(pageId)).filter((id) => !shownBefore.has(id));
      await authorizeFileReferences(wrote, pageId, added);
    }
    // Every save, not only edits: a reminder changes the document but not its Markdown.
    await syncPageReferences(pageId, row.workspaceId, blocks, userId ?? null, context?.locale ?? null);
    // The Meetings page's rows follow the body's meeting blocks (catches its own errors).
    await syncMeetingNotes(pageId, blocks);
    // My tasks lists the page's unticked to-dos that mention people (catches its own errors).
    await syncPageTasks(pageId, blocks);
    // New suggestions reach the page's watchers like new threads do (catches its own errors).
    if (suggestionThreads.opened.length) await announceSuggestions(row.workspaceId, pageId, suggestionThreads.opened);
    if (!edited) return;
    // Semantic search indexes the page again (debounced, in the background), and the pages under
    // it after a new title, which their chunks name.
    pageChanged({ pageId, subtree: title !== row.title });
    // A database row's title or content changed: AI autofill values that follow it may update.
    if (row.parentId) rowChanged({ rowId: pageId, databaseId: row.parentId, userId: userId ?? null });
    if (row.parentId && title !== row.title) await recordTitleChange(pageId, row.title, title, userId ?? null);
    // The row's followers hear about it once its writers leave it alone (server/row-follow).
    // Watchers of other pages hear about it the same way, and its writers watch it (server/page-watch).
    const editors = wrote.size ? [...wrote] : userId ? [userId] : [];
    if (row.parentId) await queueRowSave(editors, pageId, { before: row.title, after: title, body: bodyChanged }, context?.locale ?? null);
    await queuePageSave(editors, pageId, context?.locale ?? null);
    // Page webhooks hear about it once the page is left alone for a while (server/page-webhooks).
    await queuePageUpdated(pageId, userId ?? editors.at(-1) ?? null, { title: title !== row.title, body: bodyChanged });
    if (title !== row.title) {
      broadcast(`ws:${row.workspaceId}`, "tree");
      if (row.parentId) broadcast(`db:${row.parentId}`, "rows");
    } else if (row.parentId && (row.imageHint ?? null) !== markdownImageHint(markdown)) {
      // Gallery cards show the first image of the body as their cover.
      broadcast(`db:${row.parentId}`, "rows");
    } else if (row.parentId && (await showsLastEdited(row.parentId))) {
      // A body edit moves the row's "last edited" values, which open views of its database show.
      broadcast(`db:${row.parentId}`, "rows");
    }
    await maybeAutoSnapshot(pageId, doc, markdown, title, userId);
  };

  const extension: Extension<Context> = {
    extensionName: "leafdesk",

    async onAuthenticate({ token, documentName, connectionConfig, requestHeaders, requestParameters }) {
      // Before anything of the document is sent: a foreign bundle would delete the blocks it can't
      // render (lib/build-id). Refused here rather than at the upgrade, so the tab learns why. A
      // production server refuses a tab that names no build too: only a tab opened before this
      // check existed does that (it then shows its "access lost" message until reloaded).
      const build = serverBuildId();
      const claimed = requestParameters.get(BUILD_PARAM);
      if (build && (!claimed || isForeignBuild(claimed, build))) throw refusal(COLLAB_STALE);
      const user = verifyCollabToken(token);
      const target = parseName(documentName);
      if (!user) throw refusal(COLLAB_UNAUTHORIZED);
      if (!target) throw refusal(COLLAB_FORBIDDEN);
      try {
        const session = await collabSessionFacts(user.sessionId, user.userId);
        if (!session) throw refusal(COLLAB_UNAUTHORIZED);
        const facts = { ...session, ip: requestHeaders.get(CLIENT_IP_HEADER) };
        // People who may only read get the live document but their edits are dropped.
        // People who may only comment write nothing but their own suggestions (see beforeSync).
        const { readOnly, suggestOnly } = await authorizeCollab(user.userId, target, facts);
        if (readOnly) connectionConfig.readOnly = true;
        return {
          userId: user.userId,
          userName: user.userName,
          userImage: user.userImage,
          sessionId: user.sessionId,
          locale: requestLocale(requestHeaders),
          strong: facts.strong,
          ssoProviderId: facts.ssoProviderId,
          ip: facts.ip,
          suggestOnly,
        } satisfies Context;
      } catch (error) {
        // Browsers drop their offline copy of a page only for "forbidden" (see components/collab/socket).
        if (error instanceof WorkspacePolicyError) {
          throw refusal(error.hold === "ip" ? COLLAB_IP : error.hold === "sso" ? COLLAB_SSO : COLLAB_TWO_STEP);
        }
        if (error instanceof AccessError) throw refusal(COLLAB_FORBIDDEN);
        throw error;
      }
    },

    async beforeUnloadDocument({ instance, documentName, document }) {
      // After a save, Hocuspocus unloads the saved document by name a moment later. When the page
      // was closed and opened again in between, that name belongs to the new document: unloading it
      // would leave its editors on a document nobody else reaches, whose next save overwrites
      // changes made since. Throwing (without a message, so nothing is logged) keeps it loaded.
      if (instance.documents.get(documentName) !== document) throw new Error();
    },

    async onLoadDocument({ documentName, document }) {
      const target = parseName(documentName);
      if (target?.kind !== "page") return document; // ws:/db: docs are signal-only
      const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, target.id)).limit(1);
      if (row?.ydoc) Y.applyUpdate(document, row.ydoc);
      // Never write here (e.g. seeding meta.title): after a server restart, clients resync
      // their local state and a server-side write would race it as a concurrent CRDT edit.
      // An absent title falls back to page.title everywhere.
      return document;
    },

    async beforeSync({ documentName, document, connection, type, payload }) {
      // Sync step 2 (1) and updates (2) carry changes. Comment threads are the server's to write.
      // Hocuspocus asks before it drops a read-only connection's changes: those need no check.
      if ((type !== 1 && type !== 2) || connection.readOnly || parseName(documentName)?.kind !== "page") return;
      const context = connection.context as Context;
      // Someone who may only comment changes nothing but their own suggestions (suggest-guard.ts).
      if (context.suggestOnly) {
        if (onlyOwnSuggestions(document, payload, context.userId!)) return;
        console.warn(`[collab] refused a change of ${documentName} that was more than suggestions`);
        connection.sendStateless(SUGGESTION_REFUSED_EVENT);
        throw Object.assign(new Error("Only suggestions may be made here"), { code: 4403, reason: "Forbidden" });
      }
      if (touchesThreads(document, payload)) {
        console.warn(`[collab] refused a browser's change to the comments of ${documentName}`);
        throw Object.assign(new Error("Comment threads are written by the server"), { code: 4403, reason: "Forbidden" });
      }
    },

    async beforeHandleAwareness({ states, context }) {
      // Presence (who has the page open) names the person the connection signed in as, whatever
      // the browser claimed. Read-only connections send awareness too, so viewers are counted.
      stampPresence(states, context);
    },

    async onChange({ documentName, document, update, context }) {
      debug("change", documentName, update.byteLength);
      // Read-only connections never get here: Hocuspocus drops their changes first.
      const userId = (context as Context | undefined)?.userId;
      if (userId && parseName(documentName)?.kind === "page") {
        const known = writers.get(document);
        if (known) known.add(userId);
        else writers.set(document, new Set([userId]));
      }
    },

    async onStoreDocument({ documentName, document, lastContext }) {
      debug("store", documentName);
      const target = parseName(documentName);
      if (target?.kind !== "page") return;
      try {
        await persistPage(target.id, document, lastContext);
      } catch (error) {
        // Hocuspocus swallows hook errors; a failed save must be visible in the logs, and to the
        // writers: open editors stop showing their changes as saved (the next change saves again).
        console.error(`[collab] failed to persist ${documentName}`, error);
        if (isPageSaveFailed(error)) {
          failedSaves.set(document, error as Error);
          document.broadcastStateless(PAGE_SAVE_FAILED_EVENT);
        }
        // Thrown on, so Hocuspocus keeps the document in memory rather than unloading it.
        throw error;
      }
    },

    async connected({ connection }) {
      // Someone opening a page whose last save failed learns it too.
      if (failedSaves.has(connection.document)) connection.sendStateless(PAGE_SAVE_FAILED_EVENT);
    },
  };

  const hocuspocus = new Hocuspocus<Context>({
    name: "leafdesk",
    quiet: true,
    debounce: 2000,
    maxDebounce: 10000,
    extensions: [extension],
  });

  /**
   * Runs a transaction against the page's shared doc (loading it if needed) and persists it.
   * Rejects (pageSaveFailedError) when the save failed: the change may then live on only in open
   * editors, or nowhere once the document is unloaded.
   */
  const transactPage = async <T>(pageId: string, actor: WriteActor, fn: (doc: Document) => T | Promise<T>): Promise<T> => {
    const conn = await hocuspocus.openDirectConnection(pageDocName(pageId), {
      userId: actor.userId,
      oauthClientId: actor.oauthClientId,
    });
    const doc = conn.document!;
    let result: T;
    try {
      // Async prep (markdown parsing) happens inside fn before its synchronous transact call.
      result = await fn(doc);
    } finally {
      // Saves the document before it resolves (Hocuspocus stores at once when a direct connection
      // closes); a failed save doesn't reject it but is in failedSaves by then.
      await conn.disconnect();
    }
    const failed = failedSaves.get(doc);
    if (failed) throw failed;
    return result;
  };

  const snapshotBefore = async (pageId: string, doc: Y.Doc, reason: SnapshotReason, actor: WriteActor, name: string | null = null) => {
    const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, pageId)).limit(1);
    return insertSnapshot(pageId, doc, reason, actor, row?.title ?? "", name);
  };

  const writeBlocks = async (
    pageId: string,
    actor: WriteActor,
    build: (
      existing: Awaited<ReturnType<typeof deriveContent>>["blocks"],
      mentions: NonNullable<Parameters<typeof markdownToBlocks>[2]>,
    ) => Promise<typeof existing | null>,
    /** `true`: an AI app's or the chat's write, saved as `before_mcp_write` and offered for review. */
    snapshot: boolean | "before_restore" | "before_markdown_edit" | "before_merge",
    check: VersionCheck = {},
  ) => {
    await assertWritable(pageId);
    const aiWrite = snapshot === true;
    const versioned = check.expectedVersion !== undefined || Boolean(check.reportVersion);
    // An AI write records the body's version after it (page_snapshot.afterVersion), as pageVersion hashes it.
    const workspaceId = versioned || aiWrite ? await workspaceOf(pageId) : undefined;
    let snapshotId: string | null = null;
    let afterVersion: string | null = null;
    const result = await transactPage(pageId, actor, async (doc) => {
      const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
      // Read in the same synchronous run as the write or the check it stands for; hashed afterwards.
      const version = () => versionOf(bodyBlocks(doc, pageId), workspaceId);
      // Open editors can change the body while this write awaits: the check holds only while none did.
      let touched = false;
      const touch = () => {
        touched = true;
      };
      const watching = check.expectedVersion !== undefined;
      if (watching) fragment.observeDeep(touch);
      try {
        if (check.expectedVersion !== undefined) {
          const current = await version();
          if (touched || current !== check.expectedVersion) {
            return { next: null, write: { conflict: true, version: touched ? await version() : current } satisfies BodyWrite };
          }
        }
        // The page as it reads: pending suggestions are not applied (they stay where the write leaves blocks as they were).
        const existing = fragmentBlocks(fragment);
        const next = await build(existing, { people: await mentionablePeople(pageId), appUrl: env.appUrl, pageId });
        if (touched) return { next: null, write: { conflict: true, version: await version() } satisfies BodyWrite };
        // Only a write that changes something is saved before.
        if (snapshot && next) snapshotId = await snapshotBefore(pageId, doc, aiWrite ? "before_mcp_write" : snapshot, actor);
        if (touched) return { next: null, write: { conflict: true, version: await version() } satisfies BodyWrite };
        // `next` null: nothing to write.
        if (next) {
          doc.transact(
            () =>
              keepingComments(doc, () => {
                // Diff-based: unchanged blocks keep their Yjs identity, so open editors keep cursors.
                // The AI chat of someone who asked for it suggests the change instead.
                if (actor.asSuggestions) writeBlocksAsSuggestions(fragment, next, actor.userId);
                else writeBlocksKeepingSuggestions(fragment, next);
              }),
            { source: "local", context: actor },
          );
        }
        const after = versioned || (aiWrite && next) ? await version() : null;
        if (aiWrite && next) afterVersion = after;
        return { next, write: versioned ? ({ conflict: false, version: after! } satisfies BodyWrite) : null };
      } finally {
        if (watching) fragment.unobserveDeep(touch);
      }
    });
    if (snapshotId && afterVersion) {
      // Open pages offer the write for review (server/page-review.ts) while nobody changed the body since.
      await db.update(pageSnapshot).set({ afterVersion }).where(eq(pageSnapshot.id, snapshotId));
      broadcast(`page:${pageId}`, AI_EDIT_EVENT);
    }
    return result;
  };

  /**
   * Writes what a rewrite's Markdown holds between the lines of the synced blocks the page shows
   * (`refs`) into those synced blocks, on the pages they come from: only where that Markdown says
   * something other than the blocks do now (read back the same way, so Markdown as a read gave it
   * writes nothing) and isn't empty, and only where the writer may edit the original page, as in the editor
   * (lib/synced-blocks syncedSourceState). Other pages are saved to their history first when the
   * write is (the page written was already). Suggestions stay on the page they are made on, so a
   * write made as suggestions leaves synced blocks alone. Returns whether the page's own synced
   * blocks changed.
   */
  const writeSyncedRegions = async (
    hostPageId: string,
    markdown: string,
    refs: SyncedRef[],
    actor: WriteActor,
    snapshot: boolean | "before_markdown_edit",
  ) => {
    if (actor.asSuggestions || !refs.length) return false;
    const shown = new Set(refs.map(syncedKey));
    const regions = new Map<string, { ref: SyncedRef; inner: string }>();
    for (const region of syncedRegions(markdown)) {
      const key = syncedKey(region.ref);
      // Nothing between the lines only places the synced block (as a reference is written): it
      // never empties one. Removing a synced block's blocks is done on its page.
      if (shown.has(key) && !regions.has(key) && region.inner.trim()) regions.set(key, region);
    }
    if (!regions.size) return false;
    const sources = await syncedSources(actor.userId, [...new Set([...regions.values()].map((r) => r.ref.pageId))]);
    let own = false;
    for (const [sourceId, source] of sources) {
      if (source.state !== "editable") continue;
      const mine = [...regions.values()].filter((r) => r.ref.pageId === sourceId);
      const context = { people: await mentionablePeople(sourceId), appUrl: env.appUrl, pageId: sourceId };
      const changed = await transactPage(sourceId, actor, async (doc) => {
        const held = new Set(syncedElementsIn(doc).flatMap((ref) => (ref.pageId === sourceId ? [ref.syncId] : [])));
        const writes: { syncId: string; blocks: PageBlock[] }[] = [];
        for (const { ref, inner } of mine) {
          if (!held.has(ref.syncId)) continue;
          const existing = syncedBlocksOf(doc, ref.syncId) as PageBlock[];
          const read = async (text: string) => JSON.stringify(withoutBlockIds(withoutSyncedBlocks(await markdownToBlocks(text, existing, context))));
          const next = withoutSyncedBlocks(await markdownToBlocks(inner, existing, context));
          const written = JSON.stringify(withoutBlockIds(next));
          // As the blocks read now: plain, or with page links labelled as get_page gives them.
          const plain = await blocksToMarkdown(existing, { workspaceId: source.workspaceId });
          if (written === (await read(plain)) || written === (await read(await labelPageLinks(actor.userId, plain)))) continue;
          writes.push({ syncId: ref.syncId, blocks: await linkWritten(sourceId, actor, next) });
        }
        if (!writes.length) return false;
        if (snapshot && sourceId !== hostPageId) await snapshotBefore(sourceId, doc, snapshot === true ? "before_mcp_write" : snapshot, actor);
        doc.transact(
          () => {
            for (const { syncId, blocks } of writes) {
              const fragment = doc.getXmlFragment(syncedFragmentName(syncId));
              keepingComments(doc, () => writeBlocksKeepingSuggestions(fragment, blocks), fragment);
            }
          },
          { source: "local", context: actor },
        );
        return true;
      });
      if (changed && sourceId === hostPageId) own = true;
    }
    return own;
  };

  /** Blocks written as Markdown, with `[[Title]]` linked to the pages the writer can see (lib/wikilinks). */
  const linkWritten = async <T extends unknown[]>(pageId: string, actor: WriteActor, blocks: T): Promise<T> => {
    const titles = wikilinkTitles(blocks);
    if (titles.length) {
      const pages = await pagesNamed(actor.userId, pageId, titles);
      linkWikilinks(blocks, (title) => pages.get(titleKey(title))?.id);
    }
    return blocks;
  };

  /** The edits' Markdown as blocks, made in order on `existing` (lib/block-edits). */
  const buildEdits = async (
    pageId: string,
    actor: WriteActor,
    existing: Awaited<ReturnType<typeof deriveContent>>["blocks"],
    mentions: NonNullable<Parameters<typeof markdownToBlocks>[2]>,
    edits: BlockEdit[],
  ) => {
    const parsed = [];
    for (const edit of edits) {
      const blocks =
        edit.op === "delete" || edit.markdown === undefined
          ? []
          : await linkWritten(
              pageId,
              actor,
              await markdownToBlocks(stripBlockMarkers(edit.markdown), existing, { ...mentions, keepMissingInline: false, carryOver: false }),
            );
      parsed.push({ op: edit.op, blockId: edit.blockId, blocks: blocks as ReviewBlock[] });
    }
    return applyBlockEdits(existing as ReviewBlock[], parsed);
  };

  const service: CollabService = {
    async readPage(pageId): Promise<PageContent> {
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) {
        const [row] = await db.select({ title: page.title, workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
        const { markdown, text } = await deriveContent(live, row?.workspaceId, pageId);
        return { title: readTitle(live) ?? row?.title ?? "", markdown, text };
      }
      const [row] = await db
        .select({ title: page.title, markdown: page.contentMarkdown, text: page.contentText })
        .from(page)
        .where(eq(page.id, pageId))
        .limit(1);
      return row ?? { title: "", markdown: "", text: "" };
    },

    async readBlocks(pageId, { synced = false } = {}) {
      const blocksOf = (doc: Y.Doc) => bodyBlocks(doc, synced ? pageId : undefined);
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) {
        const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, pageId)).limit(1);
        return { title: readTitle(live) ?? row?.title ?? "", blocks: blocksOf(live) };
      }
      const [row] = await db
        .select({ title: page.title, ydoc: page.ydoc, markdown: page.contentMarkdown })
        .from(page)
        .where(eq(page.id, pageId))
        .limit(1);
      if (!row) return { title: "", blocks: [] };
      if (!row.ydoc) return { title: row.title, blocks: row.markdown ? await markdownToBlocks(row.markdown) : [] };
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.ydoc);
        return { title: readTitle(doc) ?? row.title, blocks: blocksOf(doc) };
      } finally {
        doc.destroy();
      }
    },

    async pageVersion(pageId) {
      const workspaceId = await workspaceOf(pageId);
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) return versionOf(bodyBlocks(live, pageId), workspaceId);
      // As onLoadDocument would load it for a write.
      const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId)).limit(1);
      const doc = new Y.Doc();
      try {
        if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
        return await versionOf(bodyBlocks(doc, pageId), workspaceId);
      } finally {
        doc.destroy();
      }
    },

    async readSynced(pageId, syncIds) {
      // Only blocks the page body still holds the source of: a deleted one's blocks stay in the
      // document (Yjs keeps every fragment) but are nobody's to show.
      const read = (doc: Y.Doc) => {
        const held = new Set(syncedElementsIn(doc).flatMap((ref) => (ref.pageId === pageId ? [ref.syncId] : [])));
        return new Map(syncIds.filter((id) => held.has(id)).map((id) => [id, syncedBlocksOf(doc, id) as unknown[]]));
      };
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) return read(live);
      const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId)).limit(1);
      if (!row?.ydoc) return new Map();
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.ydoc);
        return read(doc);
      } finally {
        doc.destroy();
      }
    },

    async mergeInto(pageId, sources, actor) {
      // Each source as its document has it now: the open one, else the stored one.
      const read = [];
      for (const source of sources) {
        const live = hocuspocus.documents.get(pageDocName(source.pageId));
        const doc = live ?? new Y.Doc();
        try {
          if (!live) {
            const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, source.pageId)).limit(1);
            if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
          }
          const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
          const threads = threadsOf(doc);
          const quotes = threads.size ? threadQuotes(fragment) : new Map<string, string>();
          read.push({
            ...source,
            blocks: withoutTrailingEmpty(fragmentBlocks(fragment)),
            // Copies, taken before the source's document goes: the thread with its comments, replies and reactions.
            threads: [...threads.entries()].flatMap(([id, thread]) =>
              thread instanceof Y.Map ? [{ id, thread: thread.clone() as Y.Map<unknown>, quote: quotes.get(id) ?? null }] : [],
            ),
          });
        } finally {
          if (!live) doc.destroy();
        }
      }

      const bodies = read.filter((s) => holdsContent(s.blocks));
      if (bodies.length) {
        await writeBlocks(
          pageId,
          actor,
          async (existing) => [
            ...withoutTrailingEmpty(existing),
            ...bodies.flatMap((s) => [
              {
                id: crypto.randomUUID(),
                type: "heading",
                props: { level: 3, textColor: "default", backgroundColor: "default", textAlignment: "left", isToggleable: false },
                content: [{ type: "text", text: s.heading, styles: {} }],
                children: [],
              },
              ...withFreshIds(s.blocks),
            ]),
          ] as typeof existing,
          "before_merge",
        );
      }

      const moving = read.flatMap((s) => s.threads.map((t) => ({ ...t, from: s.title })));
      if (moving.length) {
        await transactPage(pageId, actor, (doc) => {
          const threads = threadsOf(doc);
          const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
          doc.transact(
            () => {
              const added: typeof moving = [];
              for (const t of moving) {
                if (threads.has(t.id)) continue;
                // Read and changed once in the document: a copy not in one yet holds nothing to read.
                threads.set(t.id, t.thread);
                const thread = threads.get(t.id) as Y.Map<unknown>;
                const metadata = thread.get("metadata");
                thread.set("metadata", { ...(metadata && typeof metadata === "object" ? metadata : {}), mergedFrom: t.from });
                added.push(t);
              }
              // On the same text where the page has it now (the merged body came along); about the whole page otherwise.
              const quotes = new Map(added.flatMap((t) => (t.quote ? [[t.id, t.quote] as const] : [])));
              if (quotes.size) reanchor(fragment, quotes, new Set(quotes.keys()));
              const anchored = threadQuotes(fragment);
              for (const t of added) {
                if (anchored.has(t.id)) continue;
                const thread = threads.get(t.id) as Y.Map<unknown>;
                const metadata = thread.get("metadata") as Record<string, unknown>;
                if (!isPageThread(metadata)) thread.set("metadata", { ...metadata, ...PAGE_THREAD_METADATA });
              }
            },
            { source: "local", context: actor },
          );
        });
      }
      return { bodies: bodies.length, threads: moving.length };
    },

    async readThreads(pageId) {
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) return readThreadsOf(live);
      const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId)).limit(1);
      if (!row?.ydoc) return [];
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.ydoc);
        return readThreadsOf(doc);
      } finally {
        doc.destroy();
      }
    },

    async readSuggestions(pageId) {
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) return suggestionsIn(live);
      const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId)).limit(1);
      if (!row?.ydoc) return [];
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.ydoc);
        return suggestionsIn(doc);
      } finally {
        doc.destroy();
      }
    },

    async resolveSuggestions(pageId, decision, ids, actor) {
      await assertWritable(pageId);
      return transactPage(pageId, actor, (doc) => {
        const before = suggestionsIn(doc);
        let found: string[] = [];
        let threads: { threadId: string; suggestionId: string }[] = [];
        doc.transact(() => {
          found = resolveInFragment(doc.getXmlFragment(COLLAB_FRAGMENT), decision, ids);
          if (found.length) threads = resolveSuggestionThreads(doc, found, actor.userId);
        }, { source: "local", context: actor });
        const answered = new Set(found);
        const threadOf = new Map(threads.map((t) => [t.suggestionId, t.threadId]));
        return before.filter((s) => answered.has(s.id)).map((s) => ({ ...s, threadId: threadOf.get(s.id) ?? null }));
      });
    },

    async commentOp(pageId, actor, op) {
      return transactPage(pageId, { userId: actor.userId }, async (doc) => {
        const threads = threadsOf(doc);
        const store = new YjsThreadStore(actor.userId, threads, new DefaultThreadStoreAuth(actor.userId, actor.role));
        const origin = { source: "local", context: { userId: actor.userId } };
        // The store's writes are synchronous transactions; running them inside ours tags their origin
        // and makes anchoring a new thread part of the same change: a quote the page doesn't have
        // leaves nothing behind.
        let pending: Promise<unknown> = Promise.resolve();
        let anchored: boolean | undefined;
        doc.transact(() => {
          const before = new Set(threads.keys());
          pending = runOp(store, threads, op);
          if (op.type !== "createThread" || !op.anchor) return;
          const created = [...threads.keys()].find((id) => !before.has(id));
          if (!created) return;
          anchored = anchorThread(doc.getXmlFragment(COLLAB_FRAGMENT), created, op.anchor);
          if (!anchored) threads.delete(created);
        }, origin);
        let done: unknown;
        try {
          done = await pending;
        } catch (error) {
          throw commentError(error);
        }
        if (anchored === false) throw new CommentError("The page doesn't have the quoted text", "notFound");
        const threadId = op.type === "createThread" ? (done as { id: string }).id : op.threadId;
        const thread = threads.get(threadId);
        const result: CommentOpResult = { anchored };
        if (thread) result.thread = plainThread(store.getThread(threadId));
        if (op.type === "createThread") result.comment = result.thread?.comments[0];
        if (op.type === "addComment") result.comment = plainComment(done as Parameters<typeof plainComment>[0]);
        return result;
      });
    },

    async replaceContent(pageId, markdown, actor, snapshot = false, { wikilinks = true, syncedBlocks = false, ...check } = {}) {
      // Database blocks the Markdown names keep their settings; inline databases it leaves out stay.
      let refs: SyncedRef[] = [];
      const { write } = await writeBlocks(
        pageId,
        actor,
        async (existing, mentions) => {
          const blocks = await markdownToBlocks(markdown, existing, mentions);
          refs = syncedBlocksIn(blocks as never);
          return wikilinks ? linkWritten(pageId, actor, blocks) : blocks;
        },
        snapshot,
        check,
      );
      if (write?.conflict || !syncedBlocks) return write;
      // Lines changed inside the page's synced blocks go to the synced blocks themselves.
      const own = await writeSyncedRegions(pageId, markdown, refs, actor, snapshot);
      // The page's own synced blocks are part of its version.
      return own && write ? { ...write, version: await service.pageVersion(pageId) } : write;
    },

    async appendContent(pageId, markdown, actor, snapshot = false, check = {}) {
      const { write } = await writeBlocks(
        pageId,
        actor,
        async (existing, mentions) => [
          ...withoutTrailingEmpty(existing),
          ...(await linkWritten(
            pageId,
            actor,
            await markdownToBlocks(markdown, existing, { ...mentions, keepMissingInline: false, carryOver: false }),
          )),
        ],
        snapshot,
        check,
      );
      return write;
    },

    async transformBlocks(pageId, transform, actor, { snapshot = false, ...check } = {}) {
      let changed = false;
      const { write } = await writeBlocks(
        pageId,
        actor,
        async (existing) => {
          const next = transform(existing);
          changed = next !== null;
          return next as typeof existing | null;
        },
        snapshot,
        { ...check, reportVersion: true },
      );
      return { ...write!, changed };
    },

    async editBlocks(pageId, edits, actor, { snapshot = false, dryRun = false, ...check } = {}) {
      if (dryRun) {
        const existing = (await service.readBlocks(pageId)).blocks as Awaited<ReturnType<typeof deriveContent>>["blocks"];
        const made = await buildEdits(pageId, actor, existing, { people: await mentionablePeople(pageId), appUrl: env.appUrl }, edits);
        const version = await service.pageVersion(pageId);
        if ("missing" in made) return { conflict: false, version, missing: made.missing };
        return { conflict: false, version, missing: null, before: existing, after: made.blocks };
      }
      let missing: string | null = null;
      const { write } = await writeBlocks(
        pageId,
        actor,
        async (existing, mentions) => {
          const made = await buildEdits(pageId, actor, existing, mentions, edits);
          if ("missing" in made) {
            missing = made.missing;
            return null;
          }
          return made.blocks as typeof existing;
        },
        snapshot,
        { ...check, reportVersion: true },
      );
      return { ...write!, missing };
    },

    async blockMarkdown(pageId) {
      // With the blocks of the page's synced blocks, as its Markdown has them (see bodyBlocks).
      const read = async () => {
        const live = hocuspocus.documents.get(pageDocName(pageId));
        if (live) return bodyBlocks(live, pageId);
        const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId)).limit(1);
        if (!row?.ydoc) return (await service.readBlocks(pageId)).blocks;
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, row.ydoc);
          return bodyBlocks(doc, pageId);
        } finally {
          doc.destroy();
        }
      };
      const [blocks, workspaceId] = await Promise.all([read(), workspaceOf(pageId)]);
      const out: { id: string; markdown: string }[] = [];
      for (const block of listedBlocks(blocks as ReviewBlock[])) {
        if (!block.id) continue;
        out.push({ id: block.id, markdown: (await blocksToMarkdown([block] as Parameters<typeof blocksToMarkdown>[0], { workspaceId })).trim() });
      }
      return out;
    },

    async appendBlocks(pageId, blocks, actor, snapshot = false) {
      await writeBlocks(pageId, actor, async (existing) => [...withoutTrailingEmpty(existing), ...(blocks as typeof existing)], snapshot);
    },

    async updateBlockProps(pageId, blockId, update, actor, snapshot = false) {
      let found = false;
      await writeBlocks(
        pageId,
        actor,
        async (existing) => {
          let changed = false;
          const visit = (blocks: typeof existing): typeof existing =>
            blocks.map((block) => {
              if (block.id === blockId) {
                found = true;
                const props = update(block.props as Record<string, unknown>, block.type);
                if (!props) return block;
                changed = true;
                return { ...block, props } as typeof block;
              }
              return block.children?.length ? { ...block, children: visit(block.children) } : block;
            });
          const next = visit(existing);
          return changed ? next : null;
        },
        snapshot,
      );
      return found;
    },

    async updateBlockAttributes(pageId, type, find, update, actor) {
      await assertWritable(pageId);
      return transactPage(pageId, actor, (doc) => {
        // Read and written in one synchronous run: nothing else changes the document in between.
        const search = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
          // A block's props sit on the element inside its blockContainer, which holds its id.
          const blockId = parent instanceof Y.XmlElement && parent.nodeName === "blockContainer" ? (parent.getAttribute("id") ?? null) : null;
          for (const child of parent.toArray()) {
            if (!(child instanceof Y.XmlElement)) continue;
            if (child.nodeName === type && find(child.getAttributes(), typeof blockId === "string" ? blockId : null)) return child;
            const inner = search(child);
            if (inner) return inner;
          }
          return null;
        };
        // The page's own blocks, then those of the synced blocks it is the source of.
        const syncedPrefix = syncedFragmentName("");
        const synced = [...doc.share.keys()].filter((name) => name.startsWith(syncedPrefix)).sort();
        let element = search(doc.getXmlFragment(COLLAB_FRAGMENT));
        for (const name of synced) element ??= search(doc.getXmlFragment(name));
        if (!element) return null;
        const next = update(element.getAttributes());
        if (next) {
          doc.transact(
            () => {
              for (const [key, value] of Object.entries(next)) {
                if (element.getAttribute(key) !== value) element.setAttribute(key, value as never);
              }
            },
            { source: "local", context: actor },
          );
        }
        return element.getAttributes() as Record<string, unknown>;
      });
    },

    async linkPageMention(pageId, targetId, title, actor) {
      const { next } = await writeBlocks(pageId, actor, async (existing) => (linkTitle(existing, title, targetId) ? existing : null), false);
      return next;
    },

    async setTitle(pageId, title, actor) {
      await assertWritable(pageId);
      await transactPage(pageId, actor, (doc) => {
        writeDocTitle(doc, title, { source: "local", context: actor });
      });
    },

    async setPageStyle(pageId, change, actor) {
      await assertWritable(pageId);
      await transactPage(pageId, actor, (doc) => writePageStyle(doc, change, { source: "local", context: actor }));
    },

    async restoreSnapshot(snapshotId, actor) {
      const [snap] = await db.select().from(pageSnapshot).where(eq(pageSnapshot.id, snapshotId)).limit(1);
      if (!snap) throw new AccessError();
      await assertWritable(snap.pageId);
      const old = new Y.Doc();
      Y.applyUpdate(old, snap.ydoc);
      // The version as it read: suggestions pending then are not brought back.
      const blocks = fragmentBlocks(old.getXmlFragment(COLLAB_FRAGMENT));
      // The blocks of the page's synced blocks come back as they were too (they are the page's).
      const synced = syncedElementsIn(old)
        .filter((ref) => ref.pageId === snap.pageId)
        .map((ref) => ({ name: syncedFragmentName(ref.syncId), blocks: editor.yXmlFragmentToBlocks(old.getXmlFragment(syncedFragmentName(ref.syncId))) }));
      await transactPage(snap.pageId, actor, async (doc) => {
        await snapshotBefore(snap.pageId, doc, "before_restore", actor);
        migrateDocTitle(doc, { source: "local", context: actor });
        doc.transact(
          () => {
            keepingComments(doc, () => writeBlocksKeepingSuggestions(doc.getXmlFragment(COLLAB_FRAGMENT), blocks));
            for (const fragment of synced) if (fragment.blocks.length) editor.blocksToYXmlFragment(fragment.blocks, doc.getXmlFragment(fragment.name));
            writeDocTitle(doc, snap.title, { source: "local", context: actor });
          },
          { source: "local", context: actor },
        );
      });
      old.destroy();
    },

    async snapshot(pageId, reason, actor, name = null) {
      return transactPage(pageId, actor, (doc) => snapshotBefore(pageId, doc, reason, actor, name));
    },

    broadcast,
    sendTo,

    async pageLockChanged(pageId, locked) {
      if (locked) closeForWrites(pageId);
      else await reopenForEditors(pageId);
    },

    async pagesTrashed(pageIds, trashed) {
      for (const pageId of pageIds) {
        if (trashed) closeForWrites(pageId);
        else await reopenForEditors(pageId);
      }
    },

    async disconnectUser(userId, workspaceId) {
      await closeConnections(workspaceId, (context) => context.userId === userId);
    },

    async disconnectHeldBack(workspaceId) {
      // Browser connections only (they carry a user); the server's own have no session. Each kind
      // of session (user, two-step, SSO provider, address) is asked about once.
      const verdicts = new Map<string, boolean>();
      const keyOf = (c: Context) => `${c.userId}|${c.strong === true}|${c.ssoProviderId ?? ""}|${c.ip ?? ""}`;
      for (const doc of hocuspocus.documents.values()) {
        for (const connection of doc.getConnections()) {
          const context = connection.context as Context;
          if (context.userId === undefined || verdicts.has(keyOf(context))) continue;
          verdicts.set(keyOf(context), false);
          const hold = await policyHoldFor(context.userId, workspaceId, {
            strong: context.strong === true,
            ssoProviderId: context.ssoProviderId ?? null,
            ip: context.ip ?? null,
          });
          verdicts.set(keyOf(context), hold !== null);
        }
      }
      await closeConnections(workspaceId, (context) => context.userId !== undefined && verdicts.get(keyOf(context)) === true);
    },

    async disconnectSessions(userId, keep) {
      const kept = new Set(keep);
      const ended = (context: Context) =>
        context.userId === userId && (keep.length === 0 || (!!context.sessionId && !kept.has(context.sessionId)));
      for (const doc of hocuspocus.documents.values()) {
        for (const connection of doc.getConnections()) {
          if (ended(connection.context as Context)) connection.close({ code: 4403, reason: "Forbidden" });
        }
      }
    },

    async disconnectTeamspace(teamspaceId, userIds) {
      const who = userIds && new Set(userIds);
      const matches = (context: Context) => context.userId !== undefined && (!who || who.has(context.userId));
      const open = [...hocuspocus.documents.values()].filter((doc) => doc.getConnections().some((c) => matches(c.context as Context)));
      const pageIds = open.flatMap((doc) => {
        const target = parseName(doc.name);
        return target && target.kind !== "ws" ? [target.id] : [];
      });
      if (!pageIds.length) return;
      const inTeamspace = new Set(
        (
          await db
            .select({ id: page.id })
            .from(page)
            .where(and(eq(page.teamspaceId, teamspaceId), inArray(page.id, pageIds)))
        ).map((r) => r.id),
      );
      for (const doc of open) {
        const target = parseName(doc.name);
        if (!target || target.kind === "ws" || !inTeamspace.has(target.id)) continue;
        for (const connection of doc.getConnections()) {
          if (matches(connection.context as Context)) connection.close({ code: 4403, reason: "Forbidden" });
        }
      }
    },

    async disconnectLostAccess(workspaceId, userIds) {
      const who = userIds && new Set(userIds);
      if (who && !who.size) return;
      const open: { target: DocTarget; connections: ReturnType<Document["getConnections"]> }[] = [];
      for (const doc of hocuspocus.documents.values()) {
        const target = parseName(doc.name);
        if (!target || target.kind === "ws") continue;
        const connections = doc.getConnections().filter((c) => {
          const userId = (c.context as Context).userId;
          return userId !== undefined && (!who || who.has(userId));
        });
        if (connections.length) open.push({ target, connections });
      }
      if (!open.length) return;
      const pairs = open.flatMap(({ target, connections }) =>
        [...new Set(connections.map((c) => (c.context as Context).userId!))].map((userId) => ({ user_id: userId, page_id: target.id })),
      );
      const rows = await db.execute<{
        user_id: string;
        page_id: string;
        level: number;
        kind: PageKind;
        locked_at: string | null;
        archived_at: string | null;
      }>(sql`
        select x.user_id, x.page_id, page_access_level(x.user_id, x.page_id)::int as level, p.kind, p.locked_at, p.archived_at
        from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as x(user_id text, page_id text)
        join ${page} p on p.id = x.page_id and p.workspace_id = ${workspaceId}
      `);
      const found = new Map(rows.map((r) => [`${r.user_id}:${r.page_id}`, r]));
      for (const { target, connections } of open) {
        for (const connection of connections) {
          const row = found.get(`${(connection.context as Context).userId}:${target.id}`);
          if (!row) continue; // another workspace's page
          const level = Number(row.level);
          // 1 view, 2 comment, 3 content and up (page_access_level): a writable connection of someone who may
          // no longer edit is out of date (one that takes only suggestions stays while they may
          // comment); a read-only or suggesting one of someone who may edit now takes their edits
          // from here on, and a read-only one of someone who may comment their suggestions, unless
          // the page is locked or in the trash (see authorizeCollab).
          const context = connection.context as Context;
          const suggesting = !connection.readOnly && Boolean(context.suggestOnly);
          if (level < 1 || (!connection.readOnly && level < (suggesting ? 2 : 3))) {
            connection.close({ code: 4403, reason: "Forbidden" });
            continue;
          }
          const writable = target.kind === "page" && !isPageLocked({ kind: row.kind, lockedAt: row.locked_at }) && !row.archived_at;
          if (!writable) continue;
          if (level >= 3 && (connection.readOnly || suggesting)) {
            context.suggestOnly = false;
            if (connection.readOnly) reopen(connection);
            else connection.sendStateless(PAGE_WRITABLE_EVENT);
          } else if (level === 2 && connection.readOnly && row.kind === "page") {
            context.suggestOnly = true;
            reopen(connection);
          }
        }
      }
    },

    openPageIds() {
      return [...hocuspocus.documents.values()].flatMap((doc) => {
        const target = parseName(doc.name);
        return target && target.kind !== "ws" ? [target.id] : [];
      });
    },

    openUserIds(pageId) {
      return [...new Set(browsersOf(pageId).map((c) => (c.context as Context).userId!))];
    },

    saveOpen: () => saveOpenDocuments(hocuspocus),
    async disconnectWorkspace(workspaceId, pageIds) {
      const gone = new Set(pageIds);
      for (const doc of hocuspocus.documents.values()) {
        const target = parseName(doc.name);
        const affected = target?.kind === "ws" ? target.id === workspaceId : !!target && gone.has(target.id);
        if (!affected) continue;
        // Browsers that reconnect are refused, which drops their offline copy (components/collab/socket).
        for (const connection of doc.getConnections()) connection.close({ code: 4403, reason: "Forbidden" });
      }
    },
  };

  /** Closes the connections to the workspace's documents (signals, pages, databases) that match. */
  async function closeConnections(workspaceId: string, matches: (context: Context) => boolean) {
    const open = [...hocuspocus.documents.values()].filter((doc) =>
      doc.getConnections().some((c) => matches(c.context as Context)),
    );
    const pageIds = open.flatMap((doc) => {
      const target = parseName(doc.name);
      return target && target.kind !== "ws" ? [target.id] : [];
    });
    const inWorkspace = new Set(
      pageIds.length
        ? (
            await db
              .select({ id: page.id })
              .from(page)
              .where(and(eq(page.workspaceId, workspaceId), inArray(page.id, pageIds)))
          ).map((r) => r.id)
        : [],
    );
    for (const doc of open) {
      const target = parseName(doc.name);
      const affected = target?.kind === "ws" ? target.id === workspaceId : !!target && inWorkspace.has(target.id);
      if (!affected) continue;
      for (const connection of doc.getConnections()) {
        if (matches(connection.context as Context)) connection.close({ code: 4403, reason: "Forbidden" });
      }
    }
  }

  return { hocuspocus, service };
}
