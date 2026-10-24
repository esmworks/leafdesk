"use server";

import { getTranslations } from "next-intl/server";
import { markAssignedDone } from "@/server/assigned";
import { updateRowProperties } from "@/server/databases";
import { requireUserId } from "@/server/session";

export type AssignedActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Marks a row assigned to the user done from their list (server/assigned.ts). Returns the status
 * it had, for undoing it. Any failure reads the same: the row may be gone, or no longer theirs.
 */
export async function markAssignedDoneAction(rowId: string): Promise<AssignedActionResult<{ propertyId: string; previous: string | null }>> {
  const userId = await requireUserId();
  if (typeof rowId !== "string") throw new Error("Invalid row");
  try {
    return { ok: true, data: await markAssignedDone(userId, rowId) };
  } catch (error) {
    console.error("[assigned] marking a row done failed", error);
    const t = await getTranslations("home.myTasks");
    return { ok: false, error: t("markFailed") };
  }
}

/** Puts back the status a row had before it was marked done from the list. */
export async function undoAssignedDoneAction(rowId: string, propertyId: string, previous: string | null): Promise<AssignedActionResult<null>> {
  const userId = await requireUserId();
  if (typeof rowId !== "string" || typeof propertyId !== "string" || (previous !== null && typeof previous !== "string")) {
    throw new Error("Invalid row");
  }
  try {
    await updateRowProperties(userId, rowId, { [propertyId]: previous });
    return { ok: true, data: null };
  } catch (error) {
    console.error("[assigned] undoing a row marked done failed", error);
    const t = await getTranslations("home.myTasks");
    return { ok: false, error: t("undoFailed") };
  }
}
