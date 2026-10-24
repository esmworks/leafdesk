"use server";

import { getTranslations } from "next-intl/server";
import { parseAnalyticsPeriod } from "@/lib/analytics";
import type { PageAnalytics } from "@/lib/page-views";
import { AccessError, WorkspacePolicyError } from "@/server/access";
import { pageAnalytics, recordPageView, setOwnPageViews } from "@/server/page-views";
import { getSession, requireUserId } from "@/server/session";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function refused(): Promise<{ ok: false; error: string }> {
  return { ok: false, error: (await getTranslations("page.analytics"))("noAccess") };
}

/**
 * Records that the signed-in person opened the page (server/page-views.ts), sent by the browser
 * once the page has loaded. Nothing comes back and nothing is revalidated: the page that was just
 * opened stays as it is, whatever happens here.
 */
export async function recordPageViewAction(pageId: string): Promise<void> {
  const session = await getSession();
  if (!session || typeof pageId !== "string" || !pageId) return;
  try {
    await recordPageView(session.user.id, pageId);
  } catch (error) {
    if (error instanceof AccessError || error instanceof WorkspacePolicyError) return;
    throw error;
  }
}

/** The page's Analytics over the last 7, 30 or 90 days, for people who may edit it. */
export async function pageAnalyticsAction(pageId: string, days: number): Promise<ActionResult<PageAnalytics>> {
  const userId = await requireUserId();
  if (typeof pageId !== "string") return refused();
  try {
    return { ok: true, data: await pageAnalytics(userId, pageId, parseAnalyticsPeriod(days)) };
  } catch (error) {
    if (error instanceof AccessError) return refused();
    throw error;
  }
}

/** The person's own switch for recording the pages they open in the workspace (Settings > General). */
export async function setOwnPageViewsAction(workspaceId: string, on: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  if (typeof workspaceId !== "string" || typeof on !== "boolean") throw new Error("Invalid page views setting");
  try {
    await setOwnPageViews(userId, workspaceId, on);
    return { ok: true, data: undefined };
  } catch (error) {
    if (error instanceof AccessError) return refused();
    throw error;
  }
}
