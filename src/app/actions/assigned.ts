"use server";

import { getTranslations } from "next-intl/server";
import { markAssignedDone } from "@/server/assigned";
import { updateRowProperties } from "@/server/databases";
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
