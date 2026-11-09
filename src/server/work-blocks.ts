/**
 * Time a person blocks out on their Calendar for their own tasks (table `work_block`): a row or a
 * to-do of a page, several blocks each, each at least WORK_BLOCK_MIN_MINUTES and at most
 * WORK_BLOCK_MAX_MINUTES long (lib/work-blocks.ts). Their own plan: every read and write is for the
 * person whose blocks they are, and only while they may still open the task's page. A block of a
 * page in the trash stops showing and comes back with it; the task's own date never changes.
 */
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageTask, workBlock } from "@/db/schema";
import { workBlockItem, type CalendarItem } from "@/lib/calendar-items";
import { blockPath, isBlockId } from "@/lib/mentions";
import { atLeast } from "@/lib/property-access";
import { firstDoneOption, isDoneStatus, optionOf } from "@/lib/properties";
import {
  MAX_BLOCKS_PER_TASK,
  sortTasksToPlan,
  workBlockLengthError,
  workTaskKey,
  workTaskRef,
  type TaskToPlan,
  type WorkTaskRef,
} from "@/lib/work-blocks";
import { AccessError, accessRank, hasLevel, levelFromRank, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { openAssignedRows } from "@/server/assigned";
import { loadProperties } from "@/server/derived";
import { openPageTasks } from "@/server/page-tasks";
import { propertyAccessFor } from "@/server/property-access";

/** The most tasks the To plan list offers: more than anyone plans in a week. */
export const TO_PLAN_LIMIT = 500;

/**
 * Why a block can't be planned, moved or removed: it isn't the person's (or is gone), they may no
 * longer open its task, its length is out of bounds, what was named isn't one of their tasks, or the
 * task has as many blocks as it may.
 */
export class WorkBlockError extends Error {
  constructor(readonly code: "notFound" | "noAccess" | "tooShort" | "tooLong" | "invalid" | "notTask" | "tooMany") {
    super(`The planned time can't be changed (${code})`);
    this.name = "WorkBlockError";
  }
}

function checkLength(startsAt: Date, endsAt: Date) {
  const error = workBlockLengthError(startsAt.getTime(), endsAt.getTime());
  if (error) throw new WorkBlockError(error);
}

/** The task's page, when the person may open it, it is in the workspace and outside the trash and templates. */
async function taskPage(userId: string, workspaceId: string, pageId: string) {
  let found;
  try {
    found = await requirePageAccess(userId, pageId, "view");
  } catch (error) {
    if (error instanceof AccessError) throw new WorkBlockError("noAccess");
    throw error;
  }
  if (found.workspaceId !== workspaceId || found.archivedAt || found.isTemplate || found.inTemplate) throw new WorkBlockError("notFound");
  return found;
}

/**
 * Plans time for one of the person's tasks: a row of a database (any they may open) or one of
 * their open to-dos (in `page_task` for them). Returns the new block's id.
 */
export async function createWorkBlock(userId: string, workspaceId: string, ref: WorkTaskRef, startsAt: Date, endsAt: Date): Promise<string> {
  await requireMembership(userId, workspaceId);
  checkLength(startsAt, endsAt);
  const pageId = ref.type === "row" ? ref.rowId : ref.pageId;
  const blockId = ref.type === "row" ? null : ref.blockId;
  const found = await taskPage(userId, workspaceId, pageId);
  let title = found.title;
  if (blockId === null) {
    const [parent] = found.parentId ? await db.select({ kind: page.kind }).from(page).where(eq(page.id, found.parentId)) : [];
    if (parent?.kind !== "database") throw new WorkBlockError("notTask");
  } else {
    if (!isBlockId(blockId)) throw new WorkBlockError("notTask");
    const [todo] = await db
      .select({ text: pageTask.text })
      .from(pageTask)
      .where(and(eq(pageTask.pageId, pageId), eq(pageTask.blockId, blockId), eq(pageTask.userId, userId)));
    if (!todo) throw new WorkBlockError("notTask");
    title = todo.text || found.title;
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workBlock)
    .where(and(eq(workBlock.userId, userId), eq(workBlock.pageId, pageId), blockId === null ? isNull(workBlock.blockId) : eq(workBlock.blockId, blockId)));
  if (count >= MAX_BLOCKS_PER_TASK) throw new WorkBlockError("tooMany");
  const [row] = await db.insert(workBlock).values({ userId, workspaceId, pageId, blockId, title, startsAt, endsAt }).returning({ id: workBlock.id });
  return row.id;
}

/** One of the person's own blocks in the workspace, while they may still open its task. */
async function ownBlock(userId: string, workspaceId: string, id: string) {
  await requireMembership(userId, workspaceId);
  const [found] = await db
    .select({ id: workBlock.id, pageId: workBlock.pageId })
    .from(workBlock)
    .where(and(eq(workBlock.id, id), eq(workBlock.userId, userId), eq(workBlock.workspaceId, workspaceId)));
  if (!found) throw new WorkBlockError("notFound");
  await taskPage(userId, workspaceId, found.pageId);
  return found;
}

/** Moves one of the person's blocks to new times, or changes its length (its end). */
export async function moveWorkBlock(userId: string, workspaceId: string, id: string, startsAt: Date, endsAt: Date): Promise<void> {
  checkLength(startsAt, endsAt);
  const found = await ownBlock(userId, workspaceId, id);
  await db.update(workBlock).set({ startsAt, endsAt }).where(eq(workBlock.id, found.id));
}

/** Removes one of the person's blocks; the task stays as it is. */
export async function deleteWorkBlock(userId: string, workspaceId: string, id: string): Promise<void> {
  const found = await ownBlock(userId, workspaceId, id);
  await db.delete(workBlock).where(eq(workBlock.id, found.id));
}

/**
 * The person's blocks between `from` and `to` (instants) as Calendar items, on pages they may still
 * open outside the trash: titled by their row or open to-do (a ticked to-do keeps the title it was
 * planned with and shows done), a row done when a status they may see is in its done group.
 */
export async function workBlockItems(userId: string, workspaceId: string, from: Date, to: Date): Promise<CalendarItem[]> {
  const rows = await db
    .select({
      id: workBlock.id,
      pageId: workBlock.pageId,
      blockId: workBlock.blockId,
      title: workBlock.title,
      startsAt: workBlock.startsAt,
      endsAt: workBlock.endsAt,
      pageTitle: page.title,
      icon: page.icon,
      parentId: page.parentId,
      properties: page.properties,
      createdBy: page.createdBy,
      lockedAt: page.lockedAt,
      todoText: pageTask.text,
      level: accessRank(userId, sql`${page.id}`),
    })
    .from(workBlock)
    .innerJoin(page, eq(page.id, workBlock.pageId))
    .leftJoin(pageTask, and(eq(pageTask.pageId, workBlock.pageId), eq(pageTask.blockId, workBlock.blockId), eq(pageTask.userId, workBlock.userId)))
    .where(
      and(
        eq(workBlock.userId, userId),
        eq(workBlock.workspaceId, workspaceId),
        lt(workBlock.startsAt, to),
        gt(workBlock.endsAt, from),
        eq(page.workspaceId, workspaceId),
        isNull(page.archivedAt),
      ),
    );
  const seen = rows.filter((r) => hasLevel(levelFromRank(r.level), "view"));
  if (!seen.length) return [];
  const databaseIds = [...new Set(seen.filter((r) => r.blockId === null && r.parentId).map((r) => r.parentId!))];
  const [properties, databases, accessList] = await Promise.all([
    loadProperties(databaseIds),
    databaseIds.length
      ? db
          .select({ id: page.id, title: page.title })
          .from(page)
          .where(and(inArray(page.id, databaseIds), pageVisibleTo(userId)))
      : [],
    Promise.all(databaseIds.map(async (id) => [id, await propertyAccessFor(userId, id)] as const)),
  ]);
  const titles = new Map(databases.map((d) => [d.id, d.title]));
  const access = new Map(accessList);
  return seen.map((r) => {
    const editable = hasLevel(levelFromRank(r.level), "content") && r.lockedAt === null;
    const ref = workTaskRef(r.pageId, r.blockId);
    if (r.blockId !== null) {
      const open = r.todoText !== null;
      return workBlockItem({
        id: r.id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        title: (open ? r.todoText : r.title) || r.pageTitle,
        icon: r.icon,
        href: blockPath(workspaceId, r.pageId, r.blockId),
        detail: r.pageTitle,
        done: !open,
        ref,
        markable: open && editable,
      });
    }
    const props = r.parentId ? (properties.get(r.parentId) ?? []) : [];
    const levels = r.parentId ? access.get(r.parentId) : undefined;
    const row = { properties: (r.properties ?? {}) as Record<string, unknown>, createdBy: r.createdBy };
    const statuses = levels ? props.filter((p) => p.type === "status" && atLeast(levels.levelOf(p.id, row), "view")) : [];
    const done = statuses.some((p) => isDoneStatus(p, row.properties[p.id]));
    const statusProp = statuses.find((p) => optionOf(p, row.properties[p.id])) ?? statuses[0];
    const markable = !!statusProp && !!firstDoneOption(statusProp) && !!levels && atLeast(levels.levelOf(statusProp.id, row), "edit") && editable;
    return workBlockItem({
      id: r.id,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      title: r.pageTitle,
      icon: r.icon,
      href: `/w/${workspaceId}/p/${r.pageId}`,
      detail: r.parentId ? (titles.get(r.parentId) ?? null) : null,
      done,
      ref,
      markable,
    });
  });
}

/** The minutes the person planned for each of their tasks (by workTaskKey), on pages outside the trash. */
export async function plannedMinutesByTask(userId: string, workspaceId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      pageId: workBlock.pageId,
      blockId: workBlock.blockId,
      minutes: sql<number>`round(sum(extract(epoch from ${workBlock.endsAt} - ${workBlock.startsAt})) / 60)::int`,
    })
    .from(workBlock)
    .innerJoin(page, eq(page.id, workBlock.pageId))
    .where(and(eq(workBlock.userId, userId), eq(workBlock.workspaceId, workspaceId), isNull(page.archivedAt)))
    .groupBy(workBlock.pageId, workBlock.blockId);
  return new Map(rows.map((r) => [workTaskKey(r.pageId, r.blockId), Number(r.minutes)]));
}

/**
 * The To plan list: the person's open rows and to-dos (as My tasks lists them), each with the time
 * planned for it, by due date then title, at most TO_PLAN_LIMIT.
 */
export async function tasksToPlan(userId: string, workspaceId: string, timeZone = "UTC", locale?: string): Promise<TaskToPlan[]> {
  const [rows, todos, planned] = await Promise.all([
    openAssignedRows(userId, workspaceId, timeZone),
    openPageTasks(userId, workspaceId, timeZone),
    plannedMinutesByTask(userId, workspaceId),
  ]);
  const tasks: TaskToPlan[] = [
    ...rows.map(
      (row): TaskToPlan => ({
        key: row.id,
        ref: { type: "row", rowId: row.id },
        title: row.title,
        icon: row.icon,
        detail: row.databaseTitle,
        date: row.date,
        href: `/w/${workspaceId}/p/${row.id}`,
        plannedMinutes: planned.get(row.id) ?? 0,
      }),
    ),
    ...todos.map(
      (todo): TaskToPlan => ({
        key: todo.id,
        ref: { type: "pageTask", pageId: todo.pageId, blockId: todo.blockId },
        title: todo.text || todo.pageTitle,
        icon: todo.pageIcon,
        detail: todo.pageTitle,
        date: todo.date,
        href: todo.path,
        plannedMinutes: planned.get(todo.id) ?? 0,
      }),
    ),
  ];
  return sortTasksToPlan(tasks, new Intl.Collator(locale)).slice(0, TO_PLAN_LIMIT);
}
