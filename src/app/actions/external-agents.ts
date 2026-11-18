"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { AgentView } from "@/lib/agents";
import { AccessError } from "@/server/access";
import { AgentError } from "@/server/agents/manage";
import { bindExternalAgent, createExternalAgent, externalAgentOverview, unbindExternalAgent, type ExternalAgentOverview } from "@/server/agents/external";
import { listConnectedApps } from "@/server/mcp/grants";
import { requireUserId } from "@/server/session";

// Outside agents (server/agents/external.ts): made and bound by those who may create agents and have
// full access to them. Expected failures come back translated, as in actions/agents.ts.

/** Reasons an `invalid` error names, each with its own message (the ones a name or icon can give). */
const REASONS = ["name", "icon", "level", "database", "property"] as const;
const isReason = (value: unknown): value is (typeof REASONS)[number] => (REASONS as readonly unknown[]).includes(value);

async function run<T>(workspaceId: string, fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    const data = await fn(userId);
    revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true, data };
  } catch (error) {
    const t = await getTranslations();
    if (error instanceof AgentError) {
      const reason = error.params.reason;
      if (error.code === "invalid" && isReason(reason)) return { ok: false, error: t(`settings.agents.errors.reasons.${reason}`) };
      return { ok: false, error: t(`settings.agents.errors.${error.code}`, error.params) };
    }
    if (error instanceof AccessError) return { ok: false, error: t("settings.agents.errors.accessDenied") };
    console.error("[external agent action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

const via = (value: { kind: "app"; clientId: string } | { kind: "token" }) =>
  value?.kind === "app" ? { kind: "app" as const, clientId: String(value.clientId) } : { kind: "token" as const };

/** The person's own connected apps an outside agent may be reached through. */
export async function ownConnectedAppsAction(): Promise<ActionResult<{ clientId: string; name: string }[]>> {
  const userId = await requireUserId();
  const apps = await listConnectedApps(userId);
  return { ok: true, data: apps.map((a) => ({ clientId: a.clientId, name: a.name })) };
}

/** Makes an outside agent; the token's secret comes back once when it is reached through a token. */
export async function createExternalAgentAction(
  workspaceId: string,
  value: { name: string; icon: string | null; description: string; via: { kind: "app"; clientId: string } | { kind: "token" } },
): Promise<ActionResult<{ agent: AgentView; secret: string | null }>> {
  return run(workspaceId, (userId) => createExternalAgent(userId, workspaceId, { name: value?.name, icon: value?.icon ?? null, description: value?.description, via: via(value?.via) }));
}

/** Binds the agent to one of the person's apps, or gives it a new token (the secret comes back once). */
export async function bindExternalAgentAction(workspaceId: string, agentId: string, target: { kind: "app"; clientId: string } | { kind: "token" }): Promise<ActionResult<{ secret: string | null }>> {
  return run(workspaceId, async (userId) => ({ secret: await bindExternalAgent(userId, String(agentId), via(target)) }));
}

export async function unbindExternalAgentAction(workspaceId: string, agentId: string): Promise<ActionResult<null>> {
  return run(workspaceId, async (userId) => {
    await unbindExternalAgent(userId, String(agentId));
    return null;
  });
}

/** Its work, mentions and last activity, again after something changed. */
export async function externalAgentOverviewAction(workspaceId: string, agentId: string): Promise<ActionResult<ExternalAgentOverview>> {
  return run(workspaceId, (userId) => externalAgentOverview(userId, String(agentId)));
}
