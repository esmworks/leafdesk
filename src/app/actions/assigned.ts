"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";
import { dayString, localDay } from "@/lib/time-zone";
import { dueAssignedCount, markAssignedDone, taskCounts, type TaskCounts } from "@/server/assigned";
import { updateRowProperties } from "@/server/databases";
import { addOwnTodo, MAX_OWN_TODO, OwnTodoError } from "@/server/own-todos";
import { setPageTaskChecked } from "@/server/page-tasks";
import { requireUserId } from "@/server/session";

export type AssignedActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** An item of the list: a database row, or a to-do in a page (server/page-tasks.ts). */
export type AssignedItemRef = { type: "row"; rowId: string } | { type: "pageTask"; pageId: string; blockId: string };

/** What marking an item done changed, to put it back: a row's status, or a to-do's tick. */
export type AssignedMarked = { type: "row"; propertyId: string; previous: string | null } | { type: "pageTask" };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

function checkRef(item: unknown): AssignedItemRef {
  const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  if (raw.type === "row" && isText(raw.rowId)) return { type: "row", rowId: raw.rowId };
  if (raw.type === "pageTask" && isText(raw.pageId) && isText(raw.blockId)) return { type: "pageTask", pageId: raw.pageId, blockId: raw.blockId };
  throw new Error("Invalid item");
}

/**
 * How many of the user's open rows and to-dos are overdue and due today on their calendar day
 * (the sidebar's My tasks, read through `/api/read`). Nothing for someone the workspace doesn't
 * list rows for (a guest) or when the count fails: it is only a mark.
 */
export async function dueTasksAction(workspaceId: string): Promise<{ overdue: number; today: number }> {
  const userId = await requireUserId();
  if (!isText(workspaceId)) throw new Error("Invalid workspace");
  const timeZone = await getTimeZone();
  try {
    return await dueAssignedCount(userId, workspaceId, dayString(localDay(Date.now(), timeZone)), timeZone);
  } catch {
    return { overdue: 0, today: 0 };
  }
}

/**
 * Marks an item of the user's list done (server/assigned.ts): a row's status goes to its first
 * "done" option, a to-do in a page is ticked. Returns what it changed, for undoing it. Any failure
 * reads the same: the row or to-do may be gone, or no longer theirs.
 */
export async function markAssignedDoneAction(item: AssignedItemRef): Promise<AssignedActionResult<AssignedMarked>> {
  const userId = await requireUserId();
  const ref = checkRef(item);
  try {
    if (ref.type === "pageTask") {
      await setPageTaskChecked(userId, ref.pageId, ref.blockId, true);
      return { ok: true, data: { type: "pageTask" } };
    }
    return { ok: true, data: { type: "row", ...(await markAssignedDone(userId, ref.rowId)) } };
  } catch (error) {
    console.error("[assigned] marking an item done failed", error);
    const t = await getTranslations("home.myTasks");
    return { ok: false, error: t(ref.type === "pageTask" ? "tickFailed" : "markFailed") };
  }
}

/** Puts back what marking an item done changed: the row's status it had, or the to-do unticked. */
export async function undoAssignedDoneAction(item: AssignedItemRef, marked: AssignedMarked): Promise<AssignedActionResult<null>> {
  const userId = await requireUserId();
  const ref = checkRef(item);
  const raw = (marked && typeof marked === "object" ? marked : {}) as Record<string, unknown>;
  if (ref.type === "row" && (raw.type !== "row" || !isText(raw.propertyId) || (raw.previous !== null && typeof raw.previous !== "string"))) {
    throw new Error("Invalid row");
  }
  try {
    if (ref.type === "pageTask") await setPageTaskChecked(userId, ref.pageId, ref.blockId, false);
    else await updateRowProperties(userId, ref.rowId, { [raw.propertyId as string]: raw.previous as string | null });
    return { ok: true, data: null };
  } catch (error) {
    console.error("[assigned] undoing an item marked done failed", error);
    const t = await getTranslations("home.myTasks");
    return { ok: false, error: t(ref.type === "pageTask" ? "untickFailed" : "undoFailed") };
  }
}

/**
 * How many of the user's open rows and to-dos each of the sidebar's tasks views holds, and the
 * databases and pages they are in (read through `/api/read` as the tasks tab shows). Null when
 * the count fails: the tab then shows its views without numbers.
 */
export async function taskCountsAction(workspaceId: string): Promise<TaskCounts | null> {
  const userId = await requireUserId();
  if (!isText(workspaceId)) throw new Error("Invalid workspace");
  const [timeZone, locale] = await Promise.all([getTimeZone(), getLocale()]);
  try {
    return await taskCounts(userId, workspaceId, dayString(localDay(Date.now(), timeZone)), timeZone, locale);
  } catch {
    return null;
  }
}

/** Adds a to-do the user wrote in the tasks tab to today's daily note, mentioning them (server/own-todos.ts). */
export async function addOwnTodoAction(workspaceId: string, text: string): Promise<AssignedActionResult<{ pageId: string }>> {
  const userId = await requireUserId();
  if (!isText(workspaceId) || typeof text !== "string") throw new Error("Invalid to-do");
  const [timeZone, locale, t] = await Promise.all([getTimeZone(), getLocale(), getTranslations("home.myTasks")]);
  try {
    const { pageId } = await addOwnTodo(userId, workspaceId, text, dayString(localDay(Date.now(), timeZone)), { locale });
    revalidatePath(`/w/${workspaceId}/tasks`);
    return { ok: true, data: { pageId } };
  } catch (error) {
    if (error instanceof OwnTodoError) return { ok: false, error: t(error.code === "empty" ? "addEmpty" : "addTooLong", { max: MAX_OWN_TODO }) };
    console.error("[assigned] adding a to-do failed", error);
    return { ok: false, error: t("addFailed") };
  }
}
