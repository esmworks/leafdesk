"use server";

import { revalidatePath } from "next/cache";
import { getTimeZone } from "next-intl/server";
import { isDay, parseDateValue } from "@/lib/date-value";
import type { CalendarItem } from "@/lib/calendar-items";
import { CalendarMoveError, calendarItems, moveCalendarItem } from "@/server/calendar";
import { requireUserId } from "@/server/session";

// The Calendar place (server/calendar.ts): its items are a read, also served through /api/read;
// moving one is a write.

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** What the person has on the days from `from` to `to` (YYYY-MM-DD, both included), in their time zone; null when it can't be read. */
export async function calendarItemsAction(workspaceId: string, from: string, to: string): Promise<CalendarItem[] | null> {
  const userId = await requireUserId();
  if (!isText(workspaceId) || !isDay(from) || !isDay(to)) throw new Error("Invalid calendar range");
  const timeZone = await getTimeZone();
  try {
    return await calendarItems(userId, workspaceId, { from, to, timeZone });
  } catch (error) {
    console.error("[calendar action]", error);
    return null;
  }
}

export type MoveCalendarItemResult = { ok: true } | { ok: false; error: "notFound" | "fixed" | "noAccess" | "failed" };

/** Moves an item of the Calendar to the date value `date`, read on the person's days and clock. */
export async function moveCalendarItemAction(workspaceId: string, itemId: string, date: string): Promise<MoveCalendarItemResult> {
  const userId = await requireUserId();
  if (!isText(workspaceId) || !isText(itemId) || typeof date !== "string" || date.length > 80 || !parseDateValue(date)) {
    return { ok: false, error: "fixed" };
  }
  try {
    await moveCalendarItem(userId, workspaceId, itemId, date, await getTimeZone());
  } catch (error) {
    if (error instanceof CalendarMoveError) return { ok: false, error: error.code };
    console.error("[calendar move]", error);
    return { ok: false, error: "failed" };
  }
  revalidatePath(`/w/${workspaceId}/tasks`);
  return { ok: true };
}
