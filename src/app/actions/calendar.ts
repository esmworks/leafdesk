"use server";

import { getTimeZone } from "next-intl/server";
import { isDay } from "@/lib/date-value";
import type { CalendarItem } from "@/lib/calendar-items";
import { calendarItems } from "@/server/calendar";
import { requireUserId } from "@/server/session";

// The Calendar place (server/calendar.ts): read only, so it is served through /api/read too.

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
