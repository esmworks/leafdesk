import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as Y from "yjs";
import { db } from "@/db";
import { page, propertyComment } from "@/db/schema";
import { PROPERTY_COMMENTS_EVENT } from "@/lib/collab-constants";
import { CommentError, plainComment, plainThread, propertyOf, propertyThreadMetadata, THREADS_MAP, type CommentOp, type PlainThread } from "@/lib/comments";
import { atLeast } from "@/lib/property-access";
import { getCollab, type CommentActor, type CommentOpResult } from "@/server/collab/bridge";
import { commentError, runOp } from "@/server/collab/comment-ops";
import { loadProperties } from "@/server/derived";
import { propertyAccessFor } from "@/server/property-access";

/**
 * Comment threads on a database row's property values. They are kept out of the row's document,
 * which every browser that opens the row receives in full, because not everyone who can open a row
 * may see each of its values (server/property-access.ts): a thread shows, is written and is heard
 * about only by those who see the value it is about. They live in `property_comment`, one Yjs
 * document of threads per row in BlockNote's format, so the same thread store checks each change.
 *
 * A thread on a deleted property is left alone and hidden; it shows again once the property is
 * restored. Merging rows leaves the merged rows' property threads with them, in the trash.
 */

const parent = alias(page, "parent");

type Row = {
  id: string;
  workspaceId: string;
  databaseId: string;
  properties: Record<string, unknown>;
  createdBy: string | null;
};

/** The page as a database row, or null when it isn't one. */
async function rowOf(pageId: string): Promise<Row | null> {
  const [row] = await db
    .select({ id: page.id, workspaceId: page.workspaceId, databaseId: parent.id, properties: page.properties, createdBy: page.createdBy })
    .from(page)
    .innerJoin(parent, and(eq(parent.id, page.parentId), eq(parent.kind, "database")))
    .where(eq(page.id, pageId))
    .limit(1);
  return row ?? null;
}

type Stored = { thread: PlainThread; propertyId: string };

function readStored(doc: Y.Doc): Stored[] {
  const threads = doc.getMap(THREADS_MAP);
  if (!threads.size) return [];
  const store = new YjsThreadStore("", threads, new DefaultThreadStoreAuth("", "comment"));
  return [...store.getThreads().values()].flatMap((t) => {
    const propertyId = propertyOf(t.metadata);
    return propertyId ? [{ thread: { ...plainThread(t), quote: null }, propertyId }] : [];
  });
}

async function loadStored(pageId: string): Promise<Stored[]> {
  const [row] = await db.select({ threads: propertyComment.threads }).from(propertyComment).where(eq(propertyComment.pageId, pageId));
  if (!row) return [];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, row.threads);
    return readStored(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Which of the row's live properties `userId` sees the values of, with their names. Works from the
 * row's values as they are now: rules naming people in the row decide per row.
 */
async function seenProperties(userId: string, row: Row): Promise<Map<string, string>> {
  const [properties, access] = await Promise.all([
    loadProperties([row.databaseId]).then((all) => all.get(row.databaseId) ?? []),
    propertyAccessFor(userId, row.databaseId),
  ]);
  const subject = { properties: row.properties, createdBy: row.createdBy };
  return new Map(properties.filter((p) => atLeast(access.levelOf(p.id, subject), "view")).map((p) => [p.id, p.name]));
}

/**
 * The row's threads on property values that `userId` may see, oldest first. No check of the row
 * itself: callers check that `userId` can open it (row access included, see server/row-access.ts).
 */
export async function propertyThreadsFor(userId: string, pageId: string): Promise<PlainThread[]> {
  const stored = await loadStored(pageId);
  if (!stored.length) return [];
  const row = await rowOf(pageId);
  if (!row) return [];
  const seen = await seenProperties(userId, row);
  return stored
    .flatMap(({ thread, propertyId }) => {
      const name = seen.get(propertyId);
      return name === undefined ? [] : [{ ...thread, property: { id: propertyId, name } }];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** All of the page's threads `userId` may see: those in its document and those on property values. */
export async function threadsVisibleTo(userId: string, pageId: string): Promise<PlainThread[]> {
  const [inDocument, onProperties] = await Promise.all([getCollab().readThreads(pageId), propertyThreadsFor(userId, pageId)]);
  if (!onProperties.length) return inDocument;
  return [...inDocument, ...onProperties].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every one of the row's threads on property values, whoever sees them (legal holds read who wrote what). */
export async function storedPropertyThreads(pageId: string): Promise<PlainThread[]> {
  return (await loadStored(pageId)).map((s) => s.thread);
}

/** The property a thread of the row is about, when it is one of the row's property threads. */
export async function propertyThreadOf(pageId: string, threadId: string): Promise<string | null> {
  return (await loadStored(pageId)).find((s) => s.thread.id === threadId)?.propertyId ?? null;
}

/** Those of `userIds` who see the values of property `propertyId` in the row (for notices about it). */
export async function seersOf(pageId: string, propertyId: string, userIds: string[]): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  const row = await rowOf(pageId);
  if (!row) return [];
  const sees = await Promise.all(ids.map(async (id) => (await seenProperties(id, row)).has(propertyId)));
  return ids.filter((_, i) => sees[i]);
}

/**
 * Applies one comment change to the row's threads on property `propertyId` for `actor`, who must
 * see its value (a property they don't see answers as if the thread didn't exist). Callers check
 * the row: comment access, not in the trash. Others who have the row open load its threads again.
 */
export async function propertyCommentOp(pageId: string, actor: CommentActor, op: CommentOp, propertyId: string): Promise<CommentOpResult> {
  const row = await rowOf(pageId);
  if (!row) throw new CommentError("Only database rows have comments on their properties", "notFound");
  const name = (await seenProperties(actor.userId, row)).get(propertyId);
  if (name === undefined) throw new CommentError("That comment doesn't exist anymore", "notFound");

  const result = await db.transaction(async (tx) => {
    if (op.type === "createThread") {
      await tx
        .insert(propertyComment)
        .values({ pageId, workspaceId: row.workspaceId, threads: Y.encodeStateAsUpdate(new Y.Doc()) })
        .onConflictDoNothing();
    }
    // Locked for the change: two people commenting on the row's values at once both keep theirs.
    const [stored] = await tx
      .select({ threads: propertyComment.threads })
      .from(propertyComment)
      .where(eq(propertyComment.pageId, pageId))
      .for("update");
    if (!stored) throw new CommentError("That comment doesn't exist anymore", "notFound");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, stored.threads);
      const threads = doc.getMap(THREADS_MAP);
      if (op.type !== "createThread") {
        const thread = threads.get(op.threadId);
        if (!(thread instanceof Y.Map) || propertyOf(thread.get("metadata")) !== propertyId) {
          throw new CommentError("That comment doesn't exist anymore", "notFound");
        }
      }
      const store = new YjsThreadStore(actor.userId, threads, new DefaultThreadStoreAuth(actor.userId, actor.role));
      let done: unknown;
      try {
        done = await runOp(store, threads, op, op.type === "createThread" ? propertyThreadMetadata(propertyId) : undefined);
      } catch (error) {
        throw commentError(error);
      }
      const threadId = op.type === "createThread" ? (done as { id: string }).id : op.threadId;
      const out: CommentOpResult = {};
      if (threads.get(threadId)) out.thread = { ...plainThread(store.getThread(threadId)), quote: null, property: { id: propertyId, name } };
      if (op.type === "createThread") out.comment = out.thread?.comments[0];
      if (op.type === "addComment") out.comment = plainComment(done as Parameters<typeof plainComment>[0]);
      await tx
        .update(propertyComment)
        .set({ threads: Y.encodeStateAsUpdate(doc), updatedAt: new Date() })
        .where(eq(propertyComment.pageId, pageId));
      return out;
    } finally {
      doc.destroy();
    }
  });
  announce(pageId);
  return result;
}

/** Tells the row's open pages to load its property threads again (nothing to tell without server.ts). */
function announce(pageId: string) {
  try {
    getCollab().broadcast(`page:${pageId}`, PROPERTY_COMMENTS_EVENT);
  } catch {
    // Scripts run without the collaboration server; nobody has the row open there.
  }
}
