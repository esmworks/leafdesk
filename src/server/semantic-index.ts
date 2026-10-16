/**
 * Semantic search's index (#43): each page's text in chunks with their embeddings (`page_chunk`,
 * see semantic-text.ts for what text and how it's cut). Pages are indexed in the background:
 *
 * - a few seconds after their document is saved with an edit, they are created or restored, or a
 *   row's values change (page-events.ts, row-events.ts), debounced per page;
 * - by a sweep of a workspace that picks up pages changed since they were last indexed (or never
 *   indexed, or indexed with another model or CHUNKER_VERSION): started lazily by searches in the workspace, at most
 *   every SWEEP_INTERVAL_MS, and by `pnpm search:index` for a full backfill.
 *
 * The text of PDFs and Word documents the page shows goes in too (file-text.ts), read once per file.
 * Only chunks whose text changed are embedded again. Jobs run at most AI_CONCURRENCY at a time,
 * each workspace within its own allowance of AI_WORKSPACE_RATE_LIMIT embedding requests a minute
 * (jobs wait for their turn). Nothing is embedded while the server has no embeddings model or the
 * workspace has AI turned off (its index is dropped then). The index holds no access rules: search
 * checks the reader's access to every page when it runs (semantic-search.ts). Trashed pages keep
 * their chunks for when they come back, but never show in results.
 */
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageChunk, pageIndexState, propertyPermission } from "@/db/schema";
import { sharedLimiter } from "@/lib/rate-limit";
import { aiConfig, embed, embeddingModel, embeddingsEnabled, isAiError } from "@/server/ai";
import { getCollab } from "@/server/collab/bridge";
import * as databases from "@/server/databases";
import { pageDocuments } from "@/server/file-text";
import { onPageChanged } from "@/server/page-events";
import { onRowChanged } from "@/server/row-events";
import { blockTexts, CHUNKER_VERSION, chunkPage, rowPropertyLines, sourceHash, type ChunkDraft } from "@/server/semantic-text";
import { workspaceSettings } from "@/server/workspaces";

/** How long a page must stay unchanged before it is indexed again. */
export const SETTLE_MS = 5_000;
/** How often a workspace's pages are checked for ones the index missed (per process). */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Pages one sweep queues at most; the next sweep takes the rest. */
const SWEEP_BATCH = 2_000;
/** Chunks per embeddings request. */
const EMBED_BATCH = 32;

/** Whether semantic search runs in a workspace: the server has an embeddings model and owners left AI on. */
export async function semanticAvailable(workspaceId: string): Promise<boolean> {
  if (!embeddingsEnabled()) return false;
  return (await workspaceSettings(workspaceId)).ai !== false;
}

// ---------------------------------------------------------------------------------- queue

type IndexQueue = {
  waiting: string[];
  /** Waiting, waiting for their workspace's allowance, or running. */
  active: Set<string>;
  running: Set<string>;
  /** Changed while being indexed: indexed once more afterwards. */
  again: Set<string>;
  debounce: Map<string, ReturnType<typeof setTimeout>>;
  sweptAt: Map<string, number>;
  idle: (() => void)[];
};

const KEY = "__leafdeskSemanticIndex";
const queue = ((globalThis as Record<string, unknown>)[KEY] ??= {
  waiting: [],
  active: new Set(),
  running: new Set(),
  again: new Set(),
  debounce: new Map(),
  sweptAt: new Map(),
  idle: [],
} satisfies IndexQueue) as IndexQueue;

/** Indexes `pageId` once it has stayed unchanged for `delayMs`. Does nothing without embeddings. */
export function scheduleIndex(pageId: string, delayMs = SETTLE_MS) {
  if (!embeddingsEnabled()) return;
  const pending = queue.debounce.get(pageId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    queue.debounce.delete(pageId);
    enqueueIndex([pageId]);
  }, delayMs);
  timer.unref?.();
  queue.debounce.set(pageId, timer);
}

/** Queues pages for indexing right away (a page already queued is not queued twice). */
export function enqueueIndex(pageIds: string[]) {
  for (const id of pageIds) {
    if (queue.running.has(id)) queue.again.add(id);
    else if (!queue.active.has(id)) {
      queue.active.add(id);
      queue.waiting.push(id);
    }
  }
  pump();
}

/** Whether anything is waiting, debounced or being indexed in this process. */
export const indexBusy = () => queue.active.size > 0 || queue.debounce.size > 0;

/** Settles when nothing is queued or running (debounced pages not counted). For scripts and tests. */
export function whenIndexIdle(): Promise<void> {
  if (!queue.active.size) return Promise.resolve();
  return new Promise((resolve) => queue.idle.push(resolve));
}

function settleIdle() {
  if (queue.active.size) return;
  for (const resolve of queue.idle.splice(0)) resolve();
}

function pump() {
  const limit = aiConfig().limits.concurrency;
  while (queue.running.size < limit && queue.waiting.length) {
    const id = queue.waiting.shift()!;
    queue.running.add(id);
    void indexPage(id)
      .catch((error) => {
        if (!isAiError(error)) console.error("[semantic] indexing failed", error);
        return 0;
      })
      .then((result) => {
        queue.running.delete(id);
        const retryIn = typeof result === "number" ? result : 0;
        if (queue.again.delete(id)) {
          queue.waiting.push(id);
        } else if (retryIn > 0) {
          // The workspace used up its allowance: try again when it has room.
          setTimeout(() => {
            queue.waiting.push(id);
            pump();
          }, retryIn).unref?.();
        } else queue.active.delete(id);
        pump();
        settleIdle();
      });
  }
}

// ------------------------------------------------------------------------------- indexing

const indexLimiter = () => sharedLimiter("ai:index", aiConfig().limits.workspacePerMinute, 60_000);

export type IndexOutcome = "indexed" | "unchanged" | "skipped" | "removed";

/** Drops a page's chunks and index state. */
async function dropPage(pageId: string) {
  await db.delete(pageChunk).where(eq(pageChunk.pageId, pageId));
  await db.delete(pageIndexState).where(eq(pageIndexState.pageId, pageId));
}

/** Drops a workspace's whole index (AI turned off there). */
export async function dropWorkspaceIndex(workspaceId: string) {
  await db.delete(pageChunk).where(eq(pageChunk.workspaceId, workspaceId));
  await db.delete(pageIndexState).where(eq(pageIndexState.workspaceId, workspaceId));
}

/**
 * Properties of a database with access rules (see server/property-access). Their values stay out
 * of the index whatever the rules say: it is shared by every reader, and search can't tell who may
 * see what inside a chunk.
 */
async function restrictedProperties(databaseId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: propertyPermission.propertyId })
    .from(propertyPermission)
    .where(eq(propertyPermission.databaseId, databaseId));
  return new Set(rows.map((r) => r.id));
}

/**
 * A database's property access changed: its rows' values must leave the index (or may come back)
 * now. Chunks holding row values go at once: values come first in a row's text (chunkPage), so
 * every chunk with any of them starts with one and has no block. The rows' index state goes too,
 * so they are indexed again even when their text didn't change (the title chunk just dropped
 * comes back), by the queue now or by a later sweep. Only the dropped chunks are embedded again.
 */
export async function reindexDatabaseRows(databaseId: string) {
  const rows = sql`select id from ${page} where parent_id = ${databaseId}`;
  await db.delete(pageChunk).where(and(sql`${pageChunk.blockId} is null`, sql`${pageChunk.pageId} in (${rows})`));
  await db.delete(pageIndexState).where(sql`${pageIndexState.pageId} in (${rows})`);
  if (!embeddingsEnabled()) return;
  const ids = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.parentId, databaseId), isNull(page.archivedAt), eq(page.inTemplate, false)));
  enqueueIndex(ids.map((r) => r.id));
}

/** The chunks a page's current text makes (title, a row's values, the body's blocks, the documents it shows). */
export async function pageChunks(row: { id: string; workspaceId: string; parentId: string | null; kind: string; properties: Record<string, unknown> }) {
  const { title, blocks } = await getCollab().readBlocks(row.id);
  let properties: string[] = [];
  if (row.parentId) {
    const [parent] = await db.select({ kind: page.kind }).from(page).where(eq(page.id, row.parentId)).limit(1);
    if (parent?.kind === "database") {
      const [all, restricted] = await Promise.all([databases.getProperties(row.parentId), restrictedProperties(row.parentId)]);
      properties = rowPropertyLines(all, row.properties, restricted);
    }
  }
  if (row.kind === "database") return chunkPage({ title, properties, blocks: [] });
  const body = blocks as Parameters<typeof blockTexts>[0];
  return chunkPage({ title, properties, blocks: blockTexts(body), files: await pageDocuments(row, body) });
}

/**
 * Brings one page's chunks up to date. Returns what happened, or how many milliseconds to wait
 * for the workspace's allowance (nothing done yet). Throws AiError when the provider fails.
 */
export async function indexPage(pageId: string): Promise<IndexOutcome | number> {
  const [row] = await db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      parentId: page.parentId,
      kind: page.kind,
      properties: page.properties,
      archivedAt: page.archivedAt,
      inTemplate: page.inTemplate,
      // As Postgres wrote it (microseconds): a Date would round it down, and the page would look
      // changed since it was indexed forever after (see stalePages).
      updatedAt: sql<string>`${page.updatedAt}::text`,
    })
    .from(page)
    .where(eq(page.id, pageId))
    .limit(1);
  if (!row) return "skipped"; // deleted: its chunks went with it
  const model = embeddingModel();
  if (!model || !(await semanticAvailable(row.workspaceId)) || row.inTemplate) {
    await dropPage(pageId);
    return "removed";
  }
  if (row.archivedAt) return "skipped";

  const chunks = await pageChunks(row);
  const hash = sourceHash(model, chunks);
  const [state] = await db.select().from(pageIndexState).where(eq(pageIndexState.pageId, pageId)).limit(1);
  if (state?.model === model && state.sourceHash === hash) {
    await db
      .update(pageIndexState)
      .set({ chunkerVersion: CHUNKER_VERSION, sourceUpdatedAt: sql`${row.updatedAt}::timestamptz` })
      .where(eq(pageIndexState.pageId, pageId));
    return "unchanged";
  }

  const existing = new Set(
    (
      await db
        .select({ hash: pageChunk.contentHash })
        .from(pageChunk)
        .where(and(eq(pageChunk.pageId, pageId), eq(pageChunk.model, model)))
    ).map((c) => c.hash),
  );
  const missing = chunks.filter((c) => !existing.has(c.hash));
  const batches: ChunkDraft[][] = [];
  for (let i = 0; i < missing.length; i += EMBED_BATCH) batches.push(missing.slice(i, i + EMBED_BATCH));
  // All of the page's requests at once, or none: a page is never half indexed.
  if (batches.length) {
    const limiter = indexLimiter();
    const room = limiter.limit - limiter.count(row.workspaceId);
    if (room < Math.min(batches.length, limiter.limit)) return Math.min(Math.max(limiter.retryAfter(row.workspaceId), 2_000), 60_000);
    for (const _ of batches) limiter.hit(row.workspaceId);
  }

  const vectors: number[][] = [];
  for (const batch of batches) {
    vectors.push(...(await embed(batch.map((c) => c.text), { feature: "search.index", workspaceId: row.workspaceId, skipRateLimit: true })));
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== dimensions || !v.every(Number.isFinite))) {
    throw new Error("The embeddings model gave vectors of different sizes");
  }

  const hashes = chunks.map((c) => c.hash);
  try {
    await db.transaction(async (tx) => {
      // Workspace AI could have been turned off while the model worked.
      const [ws] = await tx.execute<{ ai: boolean | null }>(sql`select (settings->>'ai')::boolean as ai from workspace where id = ${row.workspaceId}`);
      if (ws?.ai === false) return;
      await tx
        .delete(pageChunk)
        .where(and(eq(pageChunk.pageId, pageId), hashes.length ? or(ne(pageChunk.model, model), notInArray(pageChunk.contentHash, hashes)) : undefined));
      if (missing.length) {
        await tx
          .insert(pageChunk)
          .values(
            missing.map((c, i) => ({
              pageId,
              workspaceId: row.workspaceId,
              contentHash: c.hash,
              position: c.position,
              blockId: c.blockId,
              text: c.text,
              model,
              dimensions,
              embedding: vectors[i],
            })),
          )
          .onConflictDoNothing();
      }
      for (const c of chunks) {
        if (!existing.has(c.hash)) continue;
        await tx
          .update(pageChunk)
          .set({ position: c.position, blockId: c.blockId })
          .where(and(eq(pageChunk.pageId, pageId), eq(pageChunk.contentHash, c.hash)));
      }
      const values = {
        pageId,
        workspaceId: row.workspaceId,
        model,
        sourceHash: hash,
        chunkerVersion: CHUNKER_VERSION,
        sourceUpdatedAt: sql`${row.updatedAt}::timestamptz`,
        indexedAt: new Date(),
      };
      await tx.insert(pageIndexState).values(values).onConflictDoUpdate({ target: pageIndexState.pageId, set: values });
    });
  } catch (error) {
    // Deleted while the model worked.
    if ((error as { code?: string }).code === "23503") return "skipped";
    throw error;
  }
  return "indexed";
}

// ---------------------------------------------------------------------------------- sweep

/** Pages of a workspace whose index is missing or out of date, most recently changed first. */
export async function stalePages(workspaceId: string, limit = SWEEP_BATCH): Promise<string[]> {
  const model = embeddingModel();
  if (!model) return [];
  const rows = await db.execute<{ id: string }>(sql`
    select p.id from ${page} p
    left join ${pageIndexState} s on s.page_id = p.id
    where p.workspace_id = ${workspaceId} and p.archived_at is null and not p.in_template
      and (s.page_id is null or s.model <> ${model} or s.chunker_version <> ${CHUNKER_VERSION} or p.updated_at > s.source_updated_at)
    order by p.updated_at desc
    limit ${limit}
  `);
  return rows.map((r) => r.id);
}

/** Queues a workspace's stale pages; returns how many. */
export async function sweepWorkspace(workspaceId: string): Promise<number> {
  queue.sweptAt.set(workspaceId, Date.now());
  if (!(await semanticAvailable(workspaceId))) return 0;
  const ids = await stalePages(workspaceId);
  enqueueIndex(ids);
  return ids.length;
}

/** Starts a sweep of the workspace unless one ran in the last SWEEP_INTERVAL_MS (lazy backfill). */
export function maybeSweep(workspaceId: string) {
  const last = queue.sweptAt.get(workspaceId);
  if (last !== undefined && Date.now() - last < SWEEP_INTERVAL_MS) return;
  queue.sweptAt.set(workspaceId, Date.now());
  void sweepWorkspace(workspaceId).catch((error) => console.error("[semantic] sweep failed", error));
}

/** Forgets when workspaces were swept (tests). */
export function resetSweeps() {
  queue.sweptAt.clear();
}

/** How much of a workspace is indexed, for scripts. */
export async function indexCounts(workspaceIds: string[]) {
  if (!workspaceIds.length) return { pages: 0, chunks: 0 };
  const [pages] = await db.select({ n: sql<number>`count(*)::int` }).from(pageIndexState).where(inArray(pageIndexState.workspaceId, workspaceIds));
  const [chunks] = await db.select({ n: sql<number>`count(*)::int` }).from(pageChunk).where(inArray(pageChunk.workspaceId, workspaceIds));
  return { pages: pages?.n ?? 0, chunks: chunks?.n ?? 0 };
}

onPageChanged("semantic-index", ({ pageId }) => scheduleIndex(pageId));
onRowChanged("semantic-index", ({ rowId }) => scheduleIndex(rowId));

/** Called once at startup (server.ts): importing this module starts listening for changes. */
export function startSemanticIndex() {
  const model = embeddingModel();
  console.log(model ? `Semantic search: on (${model})` : "Semantic search: off (no AI_EMBEDDINGS_MODEL)");
}
