"use server";

import { checkLinkedView } from "@/lib/embed-blocks";
import * as dashboards from "@/server/dashboards";
import { requireUserId } from "@/server/session";

/**
 * Dashboard widgets' data (see server/dashboards). The widget comes from the browser, so it is
 * checked like a linked view; what it shows is what the signed-in user may see of the database,
 * whichever page holds the dashboard.
 */

type Source = { databaseId: string; view: unknown };

function source(input: Source): dashboards.WidgetSource | null {
  if (!input || typeof input.databaseId !== "string" || !input.databaseId) return null;
  return { databaseId: input.databaseId, view: checkLinkedView(input.view) };
}

export async function widgetDataAction(input: Source, timeZone?: string): Promise<dashboards.WidgetData> {
  const userId = await requireUserId();
  const checked = source(input);
  if (!checked) return { state: "unavailable" };
  return dashboards.widgetData({ userId }, checked, { timeZone });
}

export async function widgetRowsAction(input: Source, target: dashboards.WidgetTarget, timeZone?: string) {
  const userId = await requireUserId();
  const checked = source(input);
  if (!checked) return null;
  const clean: dashboards.WidgetTarget = {
    ...(typeof target?.groupKey === "string" ? { groupKey: target.groupKey } : {}),
    ...(typeof target?.seriesKey === "string" ? { seriesKey: target.seriesKey } : {}),
  };
  return dashboards.widgetRows({ userId }, checked, clean, { timeZone });
}
