import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { page, syncedBlockReference, type PageKind } from "@/db/schema";
import { isPageLocked } from "@/lib/page-lock";
import {
  mapSyncedRegions,
  mapSyncedBlocks,
  showsSyncedContent,
  syncedBlocksIn,
  syncedKey,
  syncedRegionContent,
  syncedRegions,
  syncedSourceState,
  syncedState,
  type SyncedRef,
  type SyncedSourceFacts,
  type SyncedState,
} from "@/lib/synced-blocks";
import { accessRank, levelFromRank, pageVisibleTo, requirePageAccess, workspacesHeldBack } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab } from "@/server/collab/bridge";

/**
 * Synced blocks on the server (lib/synced-blocks): what a reader may see of a reference's source,
 * the blocks readers get in its place (MCP, exports, the print view, published pages), and the
 * index of the pages each synced block shows on.
 *
 * A reference's blocks are always read from the source page's own document, for one reader at a
 * time, with that reader's access to the source page; the referencing page's access says nothing
 * about them. The live editor gets the same answer from the collab server, which opens the source
 * page's document for the reader only as far as they may see it.
 *
 * A page with many references costs one access query for all their source pages together and one
 * read per source page (the live document, or the stored one decoded once), however many of its
 * synced blocks the page shows. Markdown readers read no document at all: the source page's stored
 * Markdown already holds its synced blocks' blocks between their markers.
 */

/** Source pages one read resolves; references to more show as if they were deleted. */
const MAX_SOURCES = 100;

/** A source page as one reader may know it. Pages they can't see say nothing, not even their title. */
export type SyncedSource =
  | { pageId: string; state: "noAccess" | "deleted" }
  | {
      pageId: string;
      state: "trashed" | "editable" | "readOnly";
      workspaceId: string;
      title: string;
      icon: string | null;
      kind: PageKind;
    };

/** A source page the reader may see the blocks of. */
export type ShownSource = Extract<SyncedSource, { workspaceId: string }> & { state: "editable" | "readOnly" };

type SourceRow = {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  archived: boolean;
  lockedAt: Date | null;
  level: number;
};

/**
 * The source as `userId` may know it, from its row (undefined: no such page) and whether the
 * reader's session is held back from its workspace. Pure: the access rules of synced blocks.
 */
export function syncedSourceOf(pageId: string, row: SourceRow | undefined, heldBack: boolean): SyncedSource {
  const facts: SyncedSourceFacts = row
    ? {
        level: levelFromRank(row.level),
        heldBack,
        archived: row.archived,
        locked: isPageLocked({ kind: row.kind, lockedAt: row.lockedAt }),
        kind: row.kind,
      }
    : null;
  const state = syncedSourceState(facts);
  if (state === "noAccess" || state === "deleted" || !row) return { pageId, state: state === "noAccess" ? "noAccess" : "deleted" };
  // A database has no synced blocks: its rows are pages of their own.
  if (row.kind !== "page") return { pageId, state: "deleted" };
  return { pageId, state, workspaceId: row.workspaceId, title: row.title, icon: row.icon, kind: row.kind };
}

/**
 * The source pages of synced blocks as `userId` may know them, by page id. `standing`: what the
 * user's access allows whoever is looking (a publisher's, for published pages); otherwise pages of
 * a workspace whose policy holds back this request's session read as no access, as everywhere.
 */
export async function syncedSources(
  userId: string,
  pageIds: string[],
  { standing = false }: { standing?: boolean } = {},
): Promise<Map<string, SyncedSource>> {
  const ids = [...new Set(pageIds.filter((id) => typeof id === "string" && id && id.length <= 128))];
  const looked = ids.slice(0, MAX_SOURCES);
  const rows = looked.length
    ? await db
        .select({
          id: page.id,
          workspaceId: page.workspaceId,
          title: page.title,
          icon: page.icon,
          kind: page.kind,
          archived: sql<boolean>`${page.archivedAt} is not null`,
          lockedAt: page.lockedAt,
          level: accessRank(userId, sql`${page.id}`),
        })
        .from(page)
        .where(inArray(page.id, looked))
    : [];
  const byId = new Map(rows.map((r) => [r.id, { ...r, level: Number(r.level) }]));
  const heldBack = standing
    ? new Set<string>()
    : await workspacesHeldBack(
        userId,
        rows.filter((r) => levelFromRank(r.level) !== "none").map((r) => r.workspaceId),
      );
  const out = new Map<string, SyncedSource>();
  for (const id of ids) {
    const row = byId.get(id);
    out.set(id, looked.includes(id) ? syncedSourceOf(id, row, row ? heldBack.has(row.workspaceId) : false) : { pageId: id, state: "deleted" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks for readers

/** A reference as one reader gets it: its state and, when they may see them, its blocks. */
export type SyncedOutcome = { state: SyncedState; blocks: PageBlock[] };

/** How a reader gets the state of source pages (without looking for the blocks in them). */
export type SourceStates = (pageIds: string[]) => Promise<Map<string, Exclude<SyncedState, "removed">>>;

/** Source states for a signed-in reader: their own access. */
export const readerStates =
  (userId: string): SourceStates =>
  async (pageIds) =>
    new Map([...(await syncedSources(userId, pageIds))].map(([id, source]) => [id, source.state]));

/**
 * The blocks of synced blocks for one reader, by syncedKey. The page being read (`hostPageId`)
 * is the reader's already: its own synced blocks need no check. Every other source page is read
 * once, and only when `states` lets the reader see it.
 */
export async function resolveSynced(refs: SyncedRef[], hostPageId: string, states: SourceStates): Promise<Map<string, SyncedOutcome>> {
  const out = new Map<string, SyncedOutcome>();
  const byPage = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!byPage.has(ref.pageId)) byPage.set(ref.pageId, new Set());
    byPage.get(ref.pageId)!.add(ref.syncId);
  }
  const others = [...byPage.keys()].filter((id) => id !== hostPageId);
  const known = others.length ? await states(others) : new Map<string, Exclude<SyncedState, "removed">>();
  await Promise.all(
    [...byPage].map(async ([pageId, syncIds]) => {
      const state = pageId === hostPageId ? "readOnly" : (known.get(pageId) ?? "noAccess");
      const shown = showsSyncedContent(state);
      const blocks = shown ? await getCollab().readSynced(pageId, [...syncIds]) : new Map<string, unknown[]>();
      for (const syncId of syncIds) {
        const found = blocks.get(syncId) as PageBlock[] | undefined;
        out.set(syncedKey({ pageId, syncId }), { state: shown ? syncedState(state, Boolean(found)) : state, blocks: found ?? [] });
      }
    }),
  );
  return out;
}

/**
 * The body with each synced block replaced by its blocks for this reader, or by `notice(state)`
 * when they may not see them (a source in the trash, gone, or out of their reach). For the print
 * view and published pages, which lay blocks out rather than Markdown.
 */
export async function expandSyncedBlocks(
  blocks: PageBlock[],
  hostPageId: string,
  states: SourceStates,
  notice: (state: SyncedState) => PageBlock[],
): Promise<PageBlock[]> {
  const refs = syncedBlocksIn(blocks);
  if (!refs.length) return blocks;
  const outcomes = await resolveSynced(refs, hostPageId, states);
  return mapSyncedBlocks(blocks, (block, ref) => {
    const outcome = outcomes.get(syncedKey(ref));
    const content = outcome && showsSyncedContent(outcome.state) ? outcome.blocks : notice(outcome?.state ?? "noAccess");
    return [...content, ...((block.children ?? []) as PageBlock[])];
  });
}

/** A note in place of a synced block whose blocks the reader may not see. */
export const syncedNotice = (text: string): PageBlock[] =>
  [{ type: "paragraph", content: [{ type: "text", text, styles: { italic: true } }], children: [] }] as unknown as PageBlock[];

/** How readers are told why a synced block shows nothing. */
export type SyncedLabels = Record<Exclude<SyncedState, "editable" | "readOnly">, string>;

export const ENGLISH_SYNCED_LABELS: SyncedLabels = {
  noAccess: "Synced block: no access",
  trashed: "Synced block: the original is in the trash",
  deleted: "Synced block: the original was deleted",
  removed: "Synced block: the original was removed",
};

/**
 * Stored Markdown of page `hostPageId` with the blocks of its references filled in for `userId`
 * (lib/synced-blocks): the source page's Markdown between the markers when they may see it, a note
 * that names nothing otherwise. For MCP reads and exports; page links inside are labelled after.
 */
export async function expandSyncedMarkdown(
  userId: string,
  hostPageId: string,
  markdown: string,
  labels: SyncedLabels = ENGLISH_SYNCED_LABELS,
): Promise<string> {
  const refs = syncedRegions(markdown)
    .map((r) => r.ref)
    .filter((ref) => ref.pageId !== hostPageId);
  if (!refs.length) return markdown;
  const sources = await syncedSources(userId, refs.map((ref) => ref.pageId));
  const bodies = new Map<string, string>();
  await Promise.all(
    [...sources.values()]
      .filter((source) => showsSyncedContent(source.state))
      .map(async (source) => bodies.set(source.pageId, (await getCollab().readPage(source.pageId)).markdown)),
  );
  return mapSyncedRegions(markdown, (ref) => {
    if (ref.pageId === hostPageId) return null;
    const state = sources.get(ref.pageId)?.state ?? "noAccess";
    const body = bodies.get(ref.pageId);
    const content = body === undefined ? null : syncedRegionContent(body, ref);
    if (content !== null) return content;
    const why: keyof SyncedLabels = state === "editable" || state === "readOnly" ? "removed" : state;
    return `*${labels[why]}*`;
  });
}

// ---------------------------------------------------------------------------------------------
// Where each synced block shows

/** Brings the index of the references `pageId`'s body holds in line with it (on every save). */
export async function syncSyncedReferences(pageId: string, blocks: unknown[]) {
  const wanted = new Map<string, SyncedRef>();
  for (const ref of syncedBlocksIn(blocks as Parameters<typeof syncedBlocksIn>[0])) if (ref.pageId !== pageId) wanted.set(syncedKey(ref), { pageId: ref.pageId, syncId: ref.syncId });
  const existing = await db
    .select({ sourceId: syncedBlockReference.sourceId, syncId: syncedBlockReference.syncId })
    .from(syncedBlockReference)
    .where(eq(syncedBlockReference.pageId, pageId));
  const have = new Set(existing.map((r) => syncedKey({ pageId: r.sourceId, syncId: r.syncId })));
  for (const row of existing) {
    if (wanted.has(syncedKey({ pageId: row.sourceId, syncId: row.syncId }))) continue;
    await db
      .delete(syncedBlockReference)
      .where(and(eq(syncedBlockReference.pageId, pageId), eq(syncedBlockReference.sourceId, row.sourceId), eq(syncedBlockReference.syncId, row.syncId)));
  }
  const added = [...wanted].filter(([key]) => !have.has(key)).map(([, ref]) => ref);
  if (!added.length) return;
  // References to pages that don't exist show as deleted but index nothing.
  const found = new Set(
    (await db.select({ id: page.id }).from(page).where(inArray(page.id, [...new Set(added.map((r) => r.pageId))]))).map((r) => r.id),
  );
  const rows = added.filter((ref) => found.has(ref.pageId)).map((ref) => ({ pageId, sourceId: ref.pageId, syncId: ref.syncId }));
  if (rows.length) await db.insert(syncedBlockReference).values(rows).onConflictDoNothing();
}

export type SyncedReferencePage = { id: string; workspaceId: string; title: string; icon: string | null; kind: PageKind };

const MAX_LISTED = 50;

/**
 * The pages showing synced block `syncId` of `sourceId` that `userId` can see, and how many others
 * do (pages out of their reach are counted, never named). For someone who may view the source.
 */
export async function syncedReferences(
  userId: string,
  sourceId: string,
  syncId: string,
): Promise<{ pages: SyncedReferencePage[]; hidden: number }> {
  await requirePageAccess(userId, sourceId, "view");
  const where = and(
    eq(syncedBlockReference.sourceId, sourceId),
    eq(syncedBlockReference.syncId, String(syncId).slice(0, 128)),
    isNull(page.archivedAt),
    eq(page.inTemplate, false),
  );
  const [pages, [all], [visible]] = await Promise.all([
    db
      .select({ id: page.id, workspaceId: page.workspaceId, title: page.title, icon: page.icon, kind: page.kind })
      .from(syncedBlockReference)
      .innerJoin(page, eq(page.id, syncedBlockReference.pageId))
      .where(and(where, pageVisibleTo(userId)))
      .orderBy(asc(page.title))
      .limit(MAX_LISTED),
    db.select({ n: count() }).from(syncedBlockReference).innerJoin(page, eq(page.id, syncedBlockReference.pageId)).where(where),
    db
      .select({ n: count() })
      .from(syncedBlockReference)
      .innerJoin(page, eq(page.id, syncedBlockReference.pageId))
      .where(and(where, pageVisibleTo(userId))),
  ]);
  return { pages, hidden: Math.max(0, Number(all?.n ?? 0) - Number(visible?.n ?? 0)) };
}
