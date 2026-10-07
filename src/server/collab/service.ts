import { createHash } from "node:crypto";
import { Hocuspocus, type Document, type Extension } from "@hocuspocus/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { db } from "@/db";
import { databaseProperty, page, pageSnapshot, type SnapshotReason } from "@/db/schema";
import { blocksToPlainText } from "@/lib/blocks";
import { BUILD_PARAM, isForeignBuild } from "@/lib/build-id";
import { AUTO_SNAPSHOT_INTERVAL_MS, COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { CommentError, isPageThread, PAGE_THREAD_METADATA, plainComment, plainThread, THREADS_MAP, type CommentOp, type PlainThread } from "@/lib/comments";
import { markdownImageHint, PG_MARKDOWN_IMAGE_PATTERN } from "@/lib/cover";
import { migrateDocTitle, readDocTitle, writeDocTitle } from "@/lib/collab-title";
import { requestLocale } from "@/i18n/config";
import { env } from "@/lib/env";
import { COLLAB_FORBIDDEN, COLLAB_SSO, COLLAB_STALE, COLLAB_TWO_STEP, COLLAB_UNAUTHORIZED } from "@/lib/offline";
import { AccessError, policyHoldFor, WorkspacePolicyError } from "@/server/access";
import { collabSessionFacts } from "@/server/account-security";
import { serverBuildId } from "@/server/build-id";
import { blocksToMarkdown, markdownToBlocks, serverEditor as editor } from "@/server/blocknote";
import { mentionablePeople, syncPageReferences } from "@/server/mentions";
import { pageChanged } from "@/server/page-events";
import { rowChanged } from "@/server/row-events";
import { authorizeCollab, parseDocName as parseName } from "./authorize";
import type { Channel, CollabService, CommentOpResult, PageContent, WriteActor } from "./bridge";
import { anchorThread, reanchor, threadQuotes } from "./comment-marks";
import { stampPresence } from "./presence";
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
    .map((t) => ({ ...plainThread(t), quote: quotes.get(t.id) ?? null, ...(isPageThread(t.metadata) ? { page: true as const } : {}) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Runs a write that may replace text carrying comment marks, then puts those marks back where the
 * same text still is, so threads stay anchored.
 */
function keepingComments(doc: Y.Doc, write: () => void) {
  const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
  const threads = threadsOf(doc);
  const quotes = threads.size ? threadQuotes(fragment) : new Map<string, string>();
  write();
  reanchor(fragment, quotes, new Set(threads.keys()));
}

/** BlockNote's thread store throws plain errors; comment callers get CommentErrors instead. */
function commentError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof CommentError) return error;
  if (error.message === "Not authorized") return new CommentError("You can't do that with this comment", "notAllowed");
  if (/not found|already deleted/i.test(error.message)) return new CommentError("That comment doesn't exist anymore", "notFound");
  return error;
}

/** A fresh page holds one empty paragraph; appending drops it instead of leaving a gap. */
function withoutTrailingEmpty<B extends { type: string; children: unknown[] }>(blocks: B[]): B[] {
  return blocks.filter(
    (b, i) => !(i === blocks.length - 1 && b.type === "paragraph" && !blocksToPlainText([b as never]) && !b.children.length),
  );
}

/** The body as blocks, Markdown and text. `workspaceId` is the page's: page mentions link into it. */
async function deriveContent(doc: Y.Doc, workspaceId?: string) {
  const blocks = editor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
  const markdown = (await blocksToMarkdown(blocks, { workspaceId })).trim();
  return { blocks, markdown, text: blocksToPlainText(blocks) };
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
) {
  const { markdown } = await deriveContent(doc, await workspaceOf(pageId));
  await db.insert(pageSnapshot).values({
    pageId,
    title: readTitle(doc) ?? fallbackTitle,
    ydoc: Y.encodeStateAsUpdate(doc),
    contentMarkdown: markdown,
    reason,
    createdBy: actor.userId ?? null,
    oauthClientId: actor.oauthClientId ?? null,
  });
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
      ),
    )
    .limit(1);
  return Boolean(found);
}

/** Applies one comment change through BlockNote's thread store, which checks what the actor may do. */
function runOp(store: YjsThreadStore, threads: Y.Map<unknown>, op: CommentOp): Promise<unknown> {
  const body = (value: unknown) => value as Parameters<YjsThreadStore["addComment"]>[0]["comment"]["body"];
  switch (op.type) {
    case "createThread":
      // A thread quoting nothing is about the whole page; it says so, not that its text was deleted.
      return store.createThread({ initialComment: { body: body(op.body) }, ...(op.anchor ? {} : { metadata: PAGE_THREAD_METADATA }) });
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

export function createCollab() {
  const broadcast = (channel: Channel, event: string) => {
    hocuspocus.documents.get(channel)?.broadcastStateless(event);
  };

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
    const { blocks, markdown, text } = await deriveContent(doc, row.workspaceId);
    const title = readTitle(doc) ?? row.title;
    // Comments and their marks change the document but not the page: they don't count as edits.
    const edited = title !== row.title || row.markdownHash !== createHash("md5").update(markdown).digest("hex");
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
    // Every save, not only edits: a reminder changes the document but not its Markdown.
    await syncPageReferences(pageId, row.workspaceId, blocks, userId ?? null, context?.locale ?? null);
    if (!edited) return;
    // Semantic search indexes the page again (debounced, in the background).
    pageChanged({ pageId });
    // A database row's title or content changed: AI autofill values that follow it may update.
    if (row.parentId) rowChanged({ rowId: pageId, databaseId: row.parentId, userId: userId ?? null });
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
        const facts = await collabSessionFacts(user.sessionId, user.userId);
        // People who may only read get the live document but their edits are dropped.
        const { readOnly } = await authorizeCollab(user.userId, target, facts);
        if (readOnly) connectionConfig.readOnly = true;
        return {
          userId: user.userId,
          userName: user.userName,
          userImage: user.userImage,
          sessionId: user.sessionId,
          locale: requestLocale(requestHeaders),
          strong: facts.strong,
          ssoProviderId: facts.ssoProviderId,
        } satisfies Context;
      } catch (error) {
        // Browsers drop their offline copy of a page only for "forbidden" (see components/collab/socket).
        if (error instanceof WorkspacePolicyError) throw refusal(error.hold === "sso" ? COLLAB_SSO : COLLAB_TWO_STEP);
        if (error instanceof AccessError) throw refusal(COLLAB_FORBIDDEN);
        throw error;
      }
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

    async beforeSync({ documentName, document, type, payload }) {
      // Sync step 2 (1) and updates (2) carry changes. Comment threads are the server's to write.
      if ((type === 1 || type === 2) && parseName(documentName)?.kind === "page" && touchesThreads(document, payload)) {
        console.warn(`[collab] refused a browser's change to the comments of ${documentName}`);
        throw Object.assign(new Error("Comment threads are written by the server"), { code: 4403, reason: "Forbidden" });
      }
    },

    async beforeHandleAwareness({ states, context }) {
      // Presence (who has the page open) names the person the connection signed in as, whatever
      // the browser claimed. Read-only connections send awareness too, so viewers are counted.
      stampPresence(states, context);
    },

    async onChange({ documentName, update }) {
      debug("change", documentName, update.byteLength);
    },

    async onStoreDocument({ documentName, document, lastContext }) {
      debug("store", documentName);
      const target = parseName(documentName);
      if (target?.kind !== "page") return;
      try {
        await persistPage(target.id, document, lastContext);
      } catch (error) {
        // Hocuspocus swallows hook errors; a failed save must be visible in the logs.
        console.error(`[collab] failed to persist ${documentName}`, error);
        throw error;
      }
    },
  };

  const hocuspocus = new Hocuspocus<Context>({
    name: "leafdesk",
    quiet: true,
    debounce: 2000,
    maxDebounce: 10000,
    extensions: [extension],
  });

  /** Runs a transaction against the page's shared doc (loading it if needed) and persists it. */
  const transactPage = async <T>(pageId: string, actor: WriteActor, fn: (doc: Document) => T | Promise<T>): Promise<T> => {
    const conn = await hocuspocus.openDirectConnection(pageDocName(pageId), {
      userId: actor.userId,
      oauthClientId: actor.oauthClientId,
    });
    try {
      // Async prep (markdown parsing) happens inside fn before its synchronous transact call.
      return await fn(conn.document!);
    } finally {
      await conn.disconnect();
    }
  };

  const snapshotBefore = async (pageId: string, doc: Y.Doc, reason: SnapshotReason, actor: WriteActor) => {
    const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, pageId)).limit(1);
    await insertSnapshot(pageId, doc, reason, actor, row?.title ?? "");
  };

  const writeBlocks = async (
    pageId: string,
    actor: WriteActor,
    build: (
      existing: Awaited<ReturnType<typeof deriveContent>>["blocks"],
      mentions: NonNullable<Parameters<typeof markdownToBlocks>[2]>,
    ) => Promise<typeof existing>,
    snapshot: boolean,
  ) => {
    await transactPage(pageId, actor, async (doc) => {
      if (snapshot) await snapshotBefore(pageId, doc, "before_mcp_write", actor);
      const existing = editor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
      const next = await build(existing, { people: await mentionablePeople(pageId), appUrl: env.appUrl });
      doc.transact(
        () =>
          keepingComments(doc, () => {
            // Diff-based: unchanged blocks keep their Yjs identity, so open editors keep cursors.
            editor.blocksToYXmlFragment(next, doc.getXmlFragment(COLLAB_FRAGMENT));
          }),
        { source: "local", context: actor },
      );
    });
  };

  const service: CollabService = {
    async readPage(pageId): Promise<PageContent> {
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) {
        const [row] = await db.select({ title: page.title, workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
        const { markdown, text } = await deriveContent(live, row?.workspaceId);
        return { title: readTitle(live) ?? row?.title ?? "", markdown, text };
      }
      const [row] = await db
        .select({ title: page.title, markdown: page.contentMarkdown, text: page.contentText })
        .from(page)
        .where(eq(page.id, pageId))
        .limit(1);
      return row ?? { title: "", markdown: "", text: "" };
    },

    async readBlocks(pageId) {
      const live = hocuspocus.documents.get(pageDocName(pageId));
      if (live) {
        const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, pageId)).limit(1);
        return { title: readTitle(live) ?? row?.title ?? "", blocks: editor.yXmlFragmentToBlocks(live.getXmlFragment(COLLAB_FRAGMENT)) };
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
        return { title: readTitle(doc) ?? row.title, blocks: editor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)) };
      } finally {
        doc.destroy();
      }
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

    async replaceContent(pageId, markdown, actor, snapshot = false) {
      // Database blocks the Markdown names keep their settings; inline databases it leaves out stay.
      await writeBlocks(pageId, actor, async (existing, mentions) => markdownToBlocks(markdown, existing, mentions), snapshot);
    },

    async appendContent(pageId, markdown, actor, snapshot = false) {
      await writeBlocks(
        pageId,
        actor,
        async (existing, mentions) => [
          ...withoutTrailingEmpty(existing),
          ...(await markdownToBlocks(markdown, existing, { ...mentions, keepMissingInline: false, carryOver: false })),
        ],
        snapshot,
      );
    },

    async appendBlocks(pageId, blocks, actor, snapshot = false) {
      await writeBlocks(pageId, actor, async (existing) => [...withoutTrailingEmpty(existing), ...(blocks as typeof existing)], snapshot);
    },

    async setTitle(pageId, title, actor) {
      await transactPage(pageId, actor, (doc) => {
        writeDocTitle(doc, title, { source: "local", context: actor });
      });
    },

    async restoreSnapshot(snapshotId, actor) {
      const [snap] = await db.select().from(pageSnapshot).where(eq(pageSnapshot.id, snapshotId)).limit(1);
      if (!snap) throw new AccessError();
      const old = new Y.Doc();
      Y.applyUpdate(old, snap.ydoc);
      const blocks = editor.yXmlFragmentToBlocks(old.getXmlFragment(COLLAB_FRAGMENT));
      await transactPage(snap.pageId, actor, async (doc) => {
        await snapshotBefore(snap.pageId, doc, "before_restore", actor);
        migrateDocTitle(doc, { source: "local", context: actor });
        doc.transact(
          () => {
            keepingComments(doc, () => editor.blocksToYXmlFragment(blocks, doc.getXmlFragment(COLLAB_FRAGMENT)));
            writeDocTitle(doc, snap.title, { source: "local", context: actor });
          },
          { source: "local", context: actor },
        );
      });
      old.destroy();
    },

    async snapshot(pageId, reason, actor) {
      await transactPage(pageId, actor, (doc) => snapshotBefore(pageId, doc, reason, actor));
    },

    broadcast,

    async disconnectUser(userId, workspaceId) {
      await closeConnections(workspaceId, (context) => context.userId === userId);
    },

    async disconnectHeldBack(workspaceId) {
      // Browser connections only (they carry a user); the server's own have no session. Each kind
      // of session (user, two-step, SSO provider) is asked about once.
      const verdicts = new Map<string, boolean>();
      const keyOf = (c: Context) => `${c.userId}|${c.strong === true}|${c.ssoProviderId ?? ""}`;
      for (const doc of hocuspocus.documents.values()) {
        for (const connection of doc.getConnections()) {
          const context = connection.context as Context;
          if (context.userId === undefined || verdicts.has(keyOf(context))) continue;
          verdicts.set(keyOf(context), false);
          const hold = await policyHoldFor(context.userId, workspaceId, {
            strong: context.strong === true,
            ssoProviderId: context.ssoProviderId ?? null,
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
      const open: { pageId: string; connections: ReturnType<Document["getConnections"]> }[] = [];
      for (const doc of hocuspocus.documents.values()) {
        const target = parseName(doc.name);
        if (!target || target.kind === "ws") continue;
        const connections = doc.getConnections().filter((c) => {
          const userId = (c.context as Context).userId;
          return userId !== undefined && (!who || who.has(userId));
        });
        if (connections.length) open.push({ pageId: target.id, connections });
      }
      if (!open.length) return;
      const pairs = open.flatMap(({ pageId, connections }) =>
        [...new Set(connections.map((c) => (c.context as Context).userId!))].map((userId) => ({ user_id: userId, page_id: pageId })),
      );
      const rows = await db.execute<{ user_id: string; page_id: string; level: number }>(sql`
        select x.user_id, x.page_id, page_access_level(x.user_id, x.page_id)::int as level
        from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as x(user_id text, page_id text)
        join ${page} p on p.id = x.page_id and p.workspace_id = ${workspaceId}
      `);
      const levels = new Map(rows.map((r) => [`${r.user_id}:${r.page_id}`, Number(r.level)]));
      for (const { pageId, connections } of open) {
        for (const connection of connections) {
          const level = levels.get(`${(connection.context as Context).userId}:${pageId}`);
          if (level === undefined) continue; // another workspace's page
          // 1 view, 2 comment, 3 edit (page_access_level): below edit, a writable connection is out of date.
          if (level < 1 || (!connection.readOnly && level < 3)) connection.close({ code: 4403, reason: "Forbidden" });
        }
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
