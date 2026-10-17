/**
 * Reviewing the AI changes to a page body on the page. Every write of an AI app (MCP), the chat or
 * an agent saves the page first (`before_mcp_write`) and records the body's version right after it
 * (page_snapshot.afterVersion). While the body still has that version, nobody changed it since, so
 * the page offers the changes for review: kept or undone one by one or all at once. Writes that
 * follow one another without other edits in between are reviewed together. Undoing goes through
 * the page's shared document, so open editors follow.
 */
import { createHash } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthClient, pageSnapshot, user, workspaceAgent } from "@/db/schema";
import { assertPageUnlocked } from "@/lib/page-lock";
import type { BlockChange, ChangeActor } from "@/lib/page-diff";
import { changeIds, reviewChanges, undoChange, withoutKept, type ReviewBlock } from "@/lib/page-review";
import { AccessError, requirePageAccess } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { getCollab } from "@/server/collab/bridge";
import { snapshotBlocks } from "@/server/page-history";

/** How far back writes reviewed together are looked for. */
const CHAIN_LIMIT = 50;

export type PageReview = {
  /** The body's version the review is of: a decision is made only while the body still has it. */
  version: string;
  /** The changes, unchanged blocks between them; kept changes show as they are now. */
  changes: BlockChange[];
  /** Each change's id (null for unchanged blocks), to keep or undo it by. */
  ids: (string | null)[];
  /** Who made the changes: the people and AI apps of the writes. */
  actors: ChangeActor[];
  /** When the first of the writes was made. */
  since: string;
};

/** What a decision found: the review after it (null: nothing left), or that the page changed first. */
export type ReviewResult = { stale: false; review: PageReview | null } | { stale: true; review: PageReview | null };

/** A body's version as CollabService.pageVersion gives it, from its Markdown as a snapshot keeps it. */
const versionOfMarkdown = (markdown: string) => createHash("sha256").update(markdown).digest("hex").slice(0, 16);

/**
 * The AI writes waiting for review on a page, newest first: the last version saved is such a write
 * with the body unchanged since, and each one before it whose body was the one the next write
 * started from. Null when there is none.
 */
async function pendingWrites(pageId: string) {
  const rows = await db
    .select({
      id: pageSnapshot.id,
      reason: pageSnapshot.reason,
      contentMarkdown: pageSnapshot.contentMarkdown,
      afterVersion: pageSnapshot.afterVersion,
      reviewedAt: pageSnapshot.reviewedAt,
      reviewKept: pageSnapshot.reviewKept,
      createdAt: pageSnapshot.createdAt,
      userName: user.name,
      clientName: oauthClient.name,
      isAgent: sql<boolean>`${workspaceAgent.id} is not null`,
    })
    .from(pageSnapshot)
    .leftJoin(user, eq(user.id, pageSnapshot.createdBy))
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, pageSnapshot.createdBy))
    .leftJoin(oauthClient, eq(oauthClient.clientId, pageSnapshot.oauthClientId))
    .where(eq(pageSnapshot.pageId, pageId))
    .orderBy(desc(pageSnapshot.createdAt), desc(pageSnapshot.id))
    .limit(CHAIN_LIMIT);
  const pending = (row: (typeof rows)[number] | undefined) => row?.reason === "before_mcp_write" && !row.reviewedAt && Boolean(row.afterVersion);
  if (!rows.some(pending)) return null;
  const version = await getCollab().pageVersion(pageId);
  // An automatic version saved since (after undoing a change, say) holds the body as it is: it is passed over.
  let start = 0;
  while (rows[start]?.reason === "auto" && versionOfMarkdown(rows[start].contentMarkdown) === version) start++;
  if (!pending(rows[start]) || version !== rows[start].afterVersion) return null;
  const chain = [rows[start]];
  for (const row of rows.slice(start + 1)) {
    if (!pending(row) || row.afterVersion !== versionOfMarkdown(chain.at(-1)!.contentMarkdown)) break;
    chain.push(row);
  }
  return { version, chain };
}

type Pending = NonNullable<Awaited<ReturnType<typeof pendingWrites>>>;

/** The body before the first write of the chain, and the changes from it to `live`. */
async function changesOf(pending: Pending, live: ReviewBlock[]) {
  const [first] = await db.select({ ydoc: pageSnapshot.ydoc }).from(pageSnapshot).where(eq(pageSnapshot.id, pending.chain.at(-1)!.id)).limit(1);
  const before = snapshotBlocks(first.ydoc) as ReviewBlock[];
  const changes = reviewChanges(before, live);
  return { before, changes, ids: changeIds(changes) };
}

const keptOf = (pending: Pending) => new Set(pending.chain[0].reviewKept ?? []);

/** The review as the page shows it; null when no change is left to decide (the writes count as reviewed then). */
async function reviewOf(pending: Pending, live: ReviewBlock[]): Promise<PageReview | null> {
  const { changes, ids } = await changesOf(pending, live);
  const shown = withoutKept(changes, ids, keptOf(pending));
  if (!shown.some((s) => s.id)) {
    await markReviewed(pending);
    return null;
  }
  const actors = new Map<string, ChangeActor>();
  for (const w of pending.chain) {
    if (!w.userName && !w.clientName) continue;
    const actor: ChangeActor = { name: w.userName, client: w.clientName, ...(w.isAgent ? { isAgent: true } : {}) };
    actors.set(`${actor.name}\u0000${actor.client}`, actor);
  }
  // Without the blocks' keys: the client only shows them, and a key holds the whole block.
  const bare = (change: BlockChange): BlockChange =>
    change.op === "changed" ? { ...change, block: { ...change.block, key: "" }, before: { ...change.before, key: "" } } : { ...change, block: { ...change.block, key: "" } };
  return {
    version: pending.version,
    changes: shown.map((s) => bare(s.change)),
    ids: shown.map((s) => s.id),
    actors: [...actors.values()].reverse(),
    since: pending.chain.at(-1)!.createdAt.toISOString(),
  };
}

async function markReviewed(pending: Pending) {
  await db
    .update(pageSnapshot)
    .set({ reviewedAt: new Date() })
    .where(inArray(pageSnapshot.id, pending.chain.map((w) => w.id)));
}

const liveBlocks = async (pageId: string) => (await getCollab().readBlocks(pageId)).blocks as ReviewBlock[];

/** The AI changes waiting for review on a page, for people who may edit it; null for anyone else. */
export async function getPageReview(userId: string, pageId: string): Promise<PageReview | null> {
  try {
    await requirePageAccess(userId, pageId, "edit");
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
  const pending = await pendingWrites(pageId);
  return pending ? reviewOf(pending, await liveBlocks(pageId)) : null;
}

/**
 * Keeps or undoes one change, or all of them (`changeId` null), made while the body has `version`.
 * Undoing all of them saves the page as it is first, as the way back.
 */
export async function decidePageReview(
  actor: WriteActor,
  pageId: string,
  version: string,
  changeId: string | null,
  decision: "keep" | "undo",
): Promise<ReviewResult> {
  assertPageUnlocked(await requirePageAccess(actor.userId, pageId, "edit"));
  const pending = await pendingWrites(pageId);
  if (!pending || pending.version !== version) {
    return { stale: true, review: pending ? await reviewOf(pending, await liveBlocks(pageId)) : null };
  }
  const stale = async (): Promise<ReviewResult> => {
    const now = await pendingWrites(pageId);
    return { stale: true, review: now ? await reviewOf(now, await liveBlocks(pageId)) : null };
  };

  if (decision === "keep") {
    if (changeId === null) {
      await markReviewed(pending);
      return { stale: false, review: null };
    }
    const live = await liveBlocks(pageId);
    const { ids } = await changesOf(pending, live);
    if (!ids.includes(changeId)) return stale();
    const kept = [...keptOf(pending), changeId];
    await db.update(pageSnapshot).set({ reviewKept: kept }).where(eq(pageSnapshot.id, pending.chain[0].id));
    pending.chain[0].reviewKept = kept;
    return { stale: false, review: await reviewOf(pending, live) };
  }

  // Undo: worked out on the body as the write finds it, only while it still has `version`.
  const [first] = await db.select({ ydoc: pageSnapshot.ydoc }).from(pageSnapshot).where(eq(pageSnapshot.id, pending.chain.at(-1)!.id)).limit(1);
  const before = snapshotBlocks(first.ydoc) as ReviewBlock[];
  const kept = keptOf(pending);
  const write = await getCollab().transformBlocks(
    pageId,
    (current) => {
      let live = current as ReviewBlock[];
      const targets = changeId === null ? null : [changeId];
      if (targets === null && !kept.size) return before;
      // One at a time: each undo is worked out again on the body the previous one left.
      for (let guard = 0; guard < 500; guard++) {
        const changes = reviewChanges(before, live);
        const ids = changeIds(changes);
        const index = ids.findIndex((id) => id !== null && (targets ? targets.includes(id) : !kept.has(id)));
        if (index < 0) break;
        const next = undoChange(live, changes, index);
        if (!next) return null;
        live = next;
        if (targets) return live;
      }
      return targets ? null : live;
    },
    actor,
    { expectedVersion: version, ...(changeId === null ? { snapshot: "before_restore" as const } : {}) },
  );
  if (write.conflict || !write.changed) return stale();
  if (changeId === null) {
    await markReviewed(pending);
    return { stale: false, review: null };
  }
  // The body's version after the undo is the one the review is of now.
  await db
    .update(pageSnapshot)
    .set({ afterVersion: write.version })
    .where(eq(pageSnapshot.id, pending.chain[0].id));
  const after = await pendingWrites(pageId);
  return { stale: false, review: after ? await reviewOf(after, await liveBlocks(pageId)) : null };
}
