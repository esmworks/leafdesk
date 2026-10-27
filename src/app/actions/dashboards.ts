"use server";

import { readDashboardPeriod } from "@/lib/dashboard-period";
import { checkLinkedView } from "@/lib/embed-blocks";
import * as dashboards from "@/server/dashboards";
import { requireUserId } from "@/server/session";

/**
 * Dashboard widgets' data (see server/dashboards). The widget comes from the browser, so it is
 * checked like a linked view; what it shows is what the signed-in user may see of the database,
 * whichever page holds the dashboard. The period comes as it is stored (lib/dashboard-period); one
 * that names none counts as all time.
 */

type Source = { databaseId: string; view: unknown };

function source(input: Source): dashboards.WidgetSource | null {
  if (!input || typeof input.databaseId !== "string" || !input.databaseId) return null;
  return { databaseId: input.databaseId, view: checkLinkedView(input.view) };
}

const periodOf = (value: unknown) => readDashboardPeriod(value) ?? undefined;

export async function widgetDataAction(input: Source, timeZone?: string, period?: string): Promise<dashboards.WidgetData> {
  const userId = await requireUserId();
  const checked = source(input);
  if (!checked) return { state: "unavailable" };
  return dashboards.widgetData({ userId }, checked, { timeZone, period: periodOf(period) });
}

export async function widgetRowsAction(input: Source, target: dashboards.WidgetTarget, timeZone?: string, period?: string) {
  const userId = await requireUserId();
  const checked = source(input);
  if (!checked) return null;
  const clean: dashboards.WidgetTarget = {
    ...(typeof target?.groupKey === "string" ? { groupKey: target.groupKey } : {}),
    ...(typeof target?.seriesKey === "string" ? { seriesKey: target.seriesKey } : {}),
  };
  return dashboards.widgetRows({ userId }, checked, clean, { timeZone, period: periodOf(period) });
}

/** Stamps of the databases a dashboard shows (server/dashboards widgetStamps), asked after the page tree changed. */
export async function widgetStampsAction(databaseIds: string[]): Promise<Record<string, string>> {
  const userId = await requireUserId();
  if (!Array.isArray(databaseIds)) return {};
  return dashboards.widgetStamps({ userId }, databaseIds.filter((id): id is string => typeof id === "string"));
}
