"use server";

import { getTranslations } from "next-intl/server";
import type { DashboardWidget } from "@/lib/dashboard";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { draftHomeDashboard, HomeDashboardError, saveHomeDashboard } from "@/server/home-dashboard";
import { requireUserId } from "@/server/session";

// The home page's dashboard (server/home-dashboard.ts). Expected failures come back translated:
// Next.js hides thrown messages in production.

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (isAiError(error)) {
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0;
      return { ok: false, error: t(`ai.errors.${error.code}`, { seconds }) };
    }
    if (error instanceof HomeDashboardError) return { ok: false, error: t(`home.dashboard.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("home.dashboard.errors.noAccess") };
    console.error("[home dashboard action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Lays out the home dashboard (owners): its widgets, checked as a dashboard block's, and its period. */
export async function saveHomeDashboardAction(workspaceId: string, widgets: DashboardWidget[], period: string): Promise<ActionResult<null>> {
  // No revalidation: the page holds what it laid out, and asking the server again on every move
  // would read the whole home page anew while an owner lays it out.
  return run(async (userId) => {
    await saveHomeDashboard(userId, String(workspaceId), { widgets, period });
    return null;
  });
}

/** Widgets drafted by the AI from the workspace's databases (owners); nothing is saved. */
export async function draftHomeDashboardAction(workspaceId: string): Promise<ActionResult<DashboardWidget[]>> {
  return run((userId) => draftHomeDashboard(userId, String(workspaceId)));
}
