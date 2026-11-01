"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { RepeatRule } from "@/lib/schedule";
import type { TriggerView } from "@/lib/triggers";
import { AccessError } from "@/server/access";
import { AgentError } from "@/server/agents/errors";
import { listOwnRequests, removeOwnRequest, setOwnRequest, type OwnRequestView } from "@/server/own-requests";
import { requireUserId } from "@/server/session";
import { listTriggers } from "@/server/triggers";

// The trigger layer (server/triggers.ts): what can start an agent's runs, or the person's own, in
// one list for the agent's page; and the person's own requests on a schedule (server/own-requests.ts).
// Expected failures come back translated, as the agents' actions return them.

const REASONS = ["task", "taskLength", "repeat"] as const;

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (error instanceof AgentError) {
      const reason = error.params.reason;
      if (error.code === "invalid" && (REASONS as readonly unknown[]).includes(reason)) return { ok: false, error: t(`settings.agents.errors.reasons.${reason as (typeof REASONS)[number]}`) };
      return { ok: false, error: t(`settings.agents.errors.${error.code}`, error.params) };
    }
    if (error instanceof AccessError) return { ok: false, error: t("settings.agents.errors.accessDenied") };
    console.error("[trigger action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Everything that can start the agent's runs (or, with `agentId` null, the viewer's own), as they may see it. */
export async function listTriggersAction(workspaceId: string, agentId: string | null): Promise<ActionResult<TriggerView[]>> {
  return run((userId) => listTriggers(userId, String(workspaceId), typeof agentId === "string" && agentId ? agentId : null));
}

/** The viewer's own requests on a schedule in the workspace. */
export async function listOwnRequestsAction(workspaceId: string): Promise<ActionResult<OwnRequestView[]>> {
  return run((userId) => listOwnRequests(userId, String(workspaceId)));
}

/** Adds an own request (`scheduleId` null) or changes one; returns the viewer's own requests as they are now. */
export async function setOwnRequestAction(
  workspaceId: string,
  scheduleId: string | null,
  value: { rule: RepeatRule; timeZone: string; task: string; mode?: "read" | "auto" },
): Promise<ActionResult<OwnRequestView[]>> {
  return run(async (userId) => {
    await setOwnRequest(userId, String(workspaceId), typeof scheduleId === "string" && scheduleId ? scheduleId : null, {
      rule: value?.rule,
      timeZone: value?.timeZone,
      task: value?.task,
      mode: value?.mode,
    });
    return listOwnRequests(userId, String(workspaceId));
  });
}

export async function removeOwnRequestAction(workspaceId: string, scheduleId: string): Promise<ActionResult<OwnRequestView[]>> {
  return run(async (userId) => {
    await removeOwnRequest(userId, String(workspaceId), String(scheduleId));
    return listOwnRequests(userId, String(workspaceId));
  });
}
