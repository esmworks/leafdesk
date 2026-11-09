"use server";

import { getLocale, getTimeZone } from "next-intl/server";
import { parseDateValue } from "@/lib/date-value";
import { WORK_BLOCK_MAX_MINUTES, WORK_BLOCK_MIN_MINUTES, type TaskToPlan, type WorkTaskRef } from "@/lib/work-blocks";
import { createWorkBlock, deleteWorkBlock, tasksToPlan, WorkBlockError } from "@/server/work-blocks";
import { requireUserId } from "@/server/session";

// Time planned for tasks on the Calendar (server/work-blocks.ts): the To plan list is a read, also
// served through /api/read; planning and removing a block are writes. Moving a block and changing
// its length go through the Calendar's moveCalendarItemAction, as every item's move does.

export type WorkBlockActionError = WorkBlockError["code"] | "failed";
export type WorkBlockResult<T> = { ok: true; data: T } | { ok: false; error: WorkBlockActionError };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

function checkRef(task: unknown): WorkTaskRef {
  const raw = (task && typeof task === "object" ? task : {}) as Record<string, unknown>;
  if (raw.type === "row" && isText(raw.rowId)) return { type: "row", rowId: raw.rowId };
  if (raw.type === "pageTask" && isText(raw.pageId) && isText(raw.blockId)) return { type: "pageTask", pageId: raw.pageId, blockId: raw.blockId };
  throw new Error("Invalid task");
}

function failed(error: unknown): { ok: false; error: WorkBlockActionError } {
  if (error instanceof WorkBlockError) return { ok: false, error: error.code };
  console.error("[work blocks]", error);
  return { ok: false, error: "failed" };
}

/** The person's open tasks to plan time for, each with the time planned so far; null when they can't be read. */
export async function tasksToPlanAction(workspaceId: string): Promise<TaskToPlan[] | null> {
  const userId = await requireUserId();
  if (!isText(workspaceId)) throw new Error("Invalid workspace");
  const [timeZone, locale] = await Promise.all([getTimeZone(), getLocale()]);
  try {
    return await tasksToPlan(userId, workspaceId, timeZone, locale);
  } catch (error) {
    console.error("[work blocks] reading the tasks to plan failed", error);
    return null;
  }
}

/** Plans `minutes` from `startsAt` (an instant) for one of the person's tasks. */
export async function planWorkBlockAction(workspaceId: string, task: WorkTaskRef, startsAt: string, minutes: number): Promise<WorkBlockResult<{ id: string }>> {
  const userId = await requireUserId();
  const ref = checkRef(task);
  const parts = parseDateValue(startsAt);
  if (!isText(workspaceId) || !parts?.time || parts.end !== null) throw new Error("Invalid time");
  if (!Number.isInteger(minutes) || minutes < WORK_BLOCK_MIN_MINUTES || minutes > WORK_BLOCK_MAX_MINUTES) {
    return { ok: false, error: minutes < WORK_BLOCK_MIN_MINUTES ? "tooShort" : "tooLong" };
  }
  const start = new Date(parts.start);
  try {
    const id = await createWorkBlock(userId, workspaceId, ref, start, new Date(start.getTime() + minutes * 60_000));
    return { ok: true, data: { id } };
  } catch (error) {
    return failed(error);
  }
}

/** Removes one of the person's planned blocks (its id, without the item's `block:`). */
export async function removeWorkBlockAction(workspaceId: string, id: string): Promise<WorkBlockResult<null>> {
  const userId = await requireUserId();
  if (!isText(workspaceId) || !isText(id)) throw new Error("Invalid block");
  try {
    await deleteWorkBlock(userId, workspaceId, id);
    return { ok: true, data: null };
  } catch (error) {
    return failed(error);
  }
}
