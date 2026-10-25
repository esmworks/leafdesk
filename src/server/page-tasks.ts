/**
 * To-dos written in pages that mention someone (lib/page-tasks): the `page_task` index, written
 * from the body on every save (collab/service.ts persistPage) like the Meetings page's rows, the
 * backfill of pages written before it, what My tasks and the home page list of them
 * (server/assigned.ts merges them with the rows assigned to the viewer), and ticking one from
 * there. The block stays the source of truth: ticking writes the block, and the save that follows
 * takes the to-do out of the index.
 */
import { and, desc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageTask, pageTaskBackfill, user, workspaceAgent, type PageKind } from "@/db/schema";
import { dateDays } from "@/lib/date-value";
import { blockPath, isBlockId } from "@/lib/mentions";
import { isTicked, pageTasksIn, TODO_BLOCK, type PageTaskEntry } from "@/lib/page-tasks";
import { dayString } from "@/lib/time-zone";
import { pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { startSweep } from "@/server/sweep";

/** How many of a person's to-dos are looked at, changed last first (as CANDIDATE_LIMIT for rows). */
export const PAGE_TASK_CANDIDATE_LIMIT = 1000;

/** A to-do in a page that mentions the viewer, as My tasks and the home page list it. */
export type AssignedPageTask = {
  type: "pageTask";
  /** `<pageId>:<blockId>`: unique among the items of a list. */
  id: string;
  pageId: string;
  blockId: string;
  /** The to-do's text without its mentions ("" when it holds nothing else). */
  text: string;
  pageTitle: string;
  pageIcon: string | null;
  pageKind: PageKind;
  /** The page, scrolled to the to-do. */
  path: string;
  /** The first day of the to-do's first date (`YYYY-MM-DD`), or null. */
  date: string | null;
  /** That date's last day when it is a range, else null. */
  endDate: string | null;
  /** That date as the mention stores it, or null. */
  dateValue: string | null;
  /** Whether the viewer may tick it from the list (edit access to the page's content; see assignedRows). */
  markable: boolean;
  /** When its text or date last changed. */
  updatedAt: Date;
};

const keyOf = (t: { blockId: string; userId: string }) => `${t.blockId}\n${t.userId}`;

/** Of these user ids, the people who have an account and aren't agents (agents are users too). */
async function peopleAmong(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        inArray(user.id, ids),
        notExists(
          db
            .select({ one: sql`1` })
            .from(workspaceAgent)
            .where(eq(workspaceAgent.userId, user.id)),
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * Brings the page's `page_task` rows in line with its body's unticked to-dos that mention people,
 * writing only what changed. Never throws: a save goes on.
 */
export async function syncPageTasks(pageId: string, blocks: unknown[]) {
  try {
    const found = pageTasksIn(blocks);
    const existing = await db
      .select({ blockId: pageTask.blockId, userId: pageTask.userId, text: pageTask.text, date: pageTask.date })
      .from(pageTask)
      .where(eq(pageTask.pageId, pageId));
    if (!existing.length && !found.length) return;
    const people = await peopleAmong([...new Set(found.map((t) => t.userId))]);
    const wanted = new Map<string, PageTaskEntry>(found.filter((t) => people.has(t.userId)).map((t) => [keyOf(t), t]));
    const gone = existing.filter((r) => !wanted.has(keyOf(r)));
    if (gone.length) {
      await db
        .delete(pageTask)
        .where(and(eq(pageTask.pageId, pageId), or(...gone.map((r) => and(eq(pageTask.blockId, r.blockId), eq(pageTask.userId, r.userId))))));
    }
    const had = new Map(existing.map((r) => [keyOf(r), r]));
    const changed = [...wanted.values()].filter((t) => {
      const before = had.get(keyOf(t));
      return !before || before.text !== t.text || before.date !== t.date;
    });
    if (changed.length) {
      await db
        .insert(pageTask)
        .values(changed.map((t) => ({ pageId, blockId: t.blockId, userId: t.userId, text: t.text, date: t.date })))
        .onConflictDoUpdate({
          target: [pageTask.pageId, pageTask.blockId, pageTask.userId],
          set: { text: sql`excluded.text`, date: sql`excluded.date`, updatedAt: sql`now()` },
        });
    }
  } catch (error) {
    console.error(`could not update the to-dos of page ${pageId}`, error);
  }
}

// ---------------------------------------------------------------------------------------------
// Backfill

/** Pages read in each run of the backfill. */
const BACKFILL_BATCH = 50;
/**
 * How often the backfill takes a batch. It keeps looking once the queue is empty (one query on an
 * empty table), since a restore can queue more at any time.
 */
const BACKFILL_SWEEP_MS = 15_000;

/**
 * SQL condition on a page (the `page` table, or `alias`) whose Markdown may hold someone's to-do:
 * an unticked to-do and an "@". Cheap, without reading documents; pageTasksIn decides.
 */
export function mayHoldPageTasks(alias?: string) {
  const markdown = alias ? sql.raw(`"${alias}"."content_markdown"`) : sql`${page.contentMarkdown}`;
  return sql`(${markdown} like '%[ ]%' and ${markdown} like '%@%')`;
}

/**
 * Indexes a batch of the pages waiting in `page_task_backfill` (filled by migration 0146 and by
 * restores of backups made before it). Each page is taken off once tried, read or not. Returns how
 * many pages it looked at.
 */
export async function backfillPageTasks(batch = BACKFILL_BATCH): Promise<number> {
  const queued = await db.select({ pageId: pageTaskBackfill.pageId }).from(pageTaskBackfill).limit(batch);
  for (const { pageId } of queued) {
    try {
      // As the page's saves read it: with the blocks of its synced blocks.
      const { blocks } = await getCollab().readBlocks(pageId, { synced: true });
      await syncPageTasks(pageId, blocks);
    } catch (error) {
      console.error(`could not index the to-dos of page ${pageId}`, error);
    }
    await db.delete(pageTaskBackfill).where(eq(pageTaskBackfill.pageId, pageId));
  }
  return queued.length;
}

/** Server only: indexes the to-dos of the pages waiting for it, a batch every BACKFILL_SWEEP_MS. */
export function startPageTasksBackfill() {
  return startSweep(BACKFILL_SWEEP_MS, () => backfillPageTasks(), "could not backfill page to-dos");
}

// ---------------------------------------------------------------------------------------------
// Listing and ticking

/**
 * The unticked to-dos in pages of the workspace that mention `userId`, on pages they may open,
 * outside the trash and templates, changed last first (at most PAGE_TASK_CANDIDATE_LIMIT). Dates
 * count on their day in `timeZone`. With `markable`, those on unlocked pages are marked as
 * candidates for ticking; assignedRows then checks edit access to the ones it shows.
 */
export async function openPageTasks(
  userId: string,
  workspaceId: string,
  timeZone = "UTC",
  { markable = false }: { markable?: boolean } = {},
): Promise<AssignedPageTask[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({
      pageId: pageTask.pageId,
      blockId: pageTask.blockId,
      text: pageTask.text,
      date: pageTask.date,
      updatedAt: pageTask.updatedAt,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      lockedAt: page.lockedAt,
    })
    .from(pageTask)
    .innerJoin(page, eq(page.id, pageTask.pageId))
    .where(
      and(
        eq(pageTask.userId, userId),
        eq(page.workspaceId, workspaceId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        eq(page.inTemplate, false),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(desc(pageTask.updatedAt))
    .limit(PAGE_TASK_CANDIDATE_LIMIT);
  return rows.map((r) => {
    const days = r.date ? dateDays(r.date, timeZone) : null;
    return {
      type: "pageTask",
      id: `${r.pageId}:${r.blockId}`,
      pageId: r.pageId,
      blockId: r.blockId,
      text: r.text,
      pageTitle: r.title,
      pageIcon: r.icon,
      pageKind: r.kind,
      path: blockPath(workspaceId, r.pageId, r.blockId),
      date: days ? dayString(days.start) : null,
      endDate: days && days.end > days.start ? dayString(days.end) : null,
      dateValue: days ? r.date : null,
      markable: markable && r.lockedAt === null,
      updatedAt: r.updatedAt,
    };
  });
}

/** A to-do that can't be ticked from the list: the page no longer has it. */
export class PageTaskError extends Error {
  constructor(readonly code: "notFound") {
    super("This to-do isn't on the page anymore");
    this.name = "PageTaskError";
  }
}

/**
 * Ticks (or unticks) a to-do from the list: the block's `checked` is set in place in the page, so
 * what others type meanwhile stays (CollabService.updateBlockAttributes). Only for people who may
 * edit the page's content; a locked page or one in the trash is refused like any write. The save
 * that follows brings the index in line.
 */
export async function setPageTaskChecked(userId: string, pageId: string, blockId: string, checked: boolean) {
  if (!isBlockId(blockId)) throw new PageTaskError("notFound");
  await requirePageAccess(userId, pageId, "content");
  const after = await getCollab().updateBlockAttributes(
    pageId,
    TODO_BLOCK,
    (_props, id) => id === blockId,
    (props) => (isTicked(props) === checked ? null : { checked }),
    { userId },
  );
  if (!after) throw new PageTaskError("notFound");
}
