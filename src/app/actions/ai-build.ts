"use server";

import { getTranslations } from "next-intl/server";
import type { DatabasePlan } from "@/lib/database-plan";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { draftDatabasePlan } from "@/server/ai-build";
import { createFromPlan, PlanError, type PlanPlace, type PlanResult } from "@/server/database-plan";
import { requireUserId } from "@/server/session";

// Build with AI (server/ai-build.ts): a plan of databases drafted from a description, then created
// as the person left it (server/database-plan.ts). Expected failures come back translated:
// Next.js hides thrown messages in production.

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (isAiError(error)) {
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0;
      return { ok: false, error: t(`ai.errors.${error.code}`, { seconds }), code: error.code };
    }
    if (error instanceof PlanError) return { ok: false, error: t(`build.errors.${error.code}`), code: error.code };
    const { code, params } = error as { code?: unknown; params?: Record<string, string> };
    if (error instanceof Error && isDatabaseErrorCode(code)) return { ok: false, error: t(`database.errors.${code}`, params ?? {}) };
    if (error instanceof AccessError) return { ok: false, error: t("build.errors.noAccess") };
    // A value the plan sets that a database refused once it was made (and taken back).
    if (error instanceof PropertyValueError) return { ok: false, error: t("build.errors.failed") };
    console.error("[build action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** A plan of databases for what `request` describes; nothing is saved. */
export async function draftDatabasePlanAction(workspaceId: string, request: string) {
  return run((userId) => draftDatabasePlan(userId, String(workspaceId), String(request ?? "")));
}

/** Creates a plan the person reviewed: under `place.parentId`, or at the top of the workspace. */
export async function createFromPlanAction(workspaceId: string, plan: DatabasePlan, place: PlanPlace): Promise<ActionResult<PlanResult>> {
  const where: PlanPlace =
    place && "parentId" in place && typeof place.parentId === "string"
      ? { parentId: place.parentId }
      : { teamspaceId: place && "teamspaceId" in place && (typeof place.teamspaceId === "string" || place.teamspaceId === null) ? place.teamspaceId : undefined };
  // The plan's pages were drafted by the model: written as its writes are (lib/model-media).
  return run((userId) => createFromPlan({ userId, model: true }, String(workspaceId), plan, where));
}
