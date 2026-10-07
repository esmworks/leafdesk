"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ApprovalDecision } from "@/lib/agents";
import type { AgentGrantView, ConnectionEventView, ConnectionTriggerView, ConnectionView, ToolKind } from "@/lib/connections";
import { AccessError } from "@/server/access";
import { ApprovalError, decideApproval } from "@/server/connections/approvals";
import {
  beginConnectionOAuth,
  ConnectionError,
  createConnection,
  createTrigger,
  deleteConnection,
  deleteTrigger,
  listAgentGrants,
  listConnectionEvents,
  listTriggers,
  refreshConnection,
  revealEventSecret,
  setAgentGrant,
  setEventSecret,
  setToolKind,
  signOutConnection,
  updateConnection,
  updateTrigger,
  type ConnectionInput,
  type TriggerInput,
} from "@/server/connections/manage";
import { requireUserId } from "@/server/session";

// Connections (see server/connections/manage.ts): owners add and sign in to them, class their
// tools, allow agents tools and set triggers; owners answer agents' calls that wait for approval.
// Expected failures come back translated: Next.js hides thrown messages in production.

async function fail(error: unknown): Promise<{ ok: false; error: string } | null> {
  const t = await getTranslations("settings.connections.errors");
  if (error instanceof ConnectionError) return { ok: false, error: t(error.code, error.params) };
  if (error instanceof ApprovalError) return { ok: false, error: t(`approval.${error.code}`) };
  if (error instanceof AccessError) return { ok: false, error: t("accessDenied") };
  return null;
}

async function run<T>(workspaceId: string, fn: (userId: string) => Promise<T>, { refresh = false } = {}): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    const data = await fn(userId);
    if (refresh) revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true, data };
  } catch (error) {
    const failed = await fail(error);
    if (failed) return failed;
    console.error("[connection action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

const input = (value: ConnectionInput): ConnectionInput => ({
  name: value?.name,
  icon: value?.icon,
  url: value?.url,
  authType: value?.authType,
  token: value?.token,
  eventPreset: value?.eventPreset,
});

export async function createConnectionAction(workspaceId: string, value: ConnectionInput): Promise<ActionResult<ConnectionView>> {
  return run(workspaceId, (userId) => createConnection(userId, workspaceId, input(value)), { refresh: true });
}

export async function updateConnectionAction(workspaceId: string, connectionId: string, value: ConnectionInput): Promise<ActionResult<ConnectionView>> {
  return run(workspaceId, (userId) => updateConnection(userId, String(connectionId), input(value)), { refresh: true });
}

export async function refreshConnectionAction(workspaceId: string, connectionId: string): Promise<ActionResult<ConnectionView>> {
  return run(workspaceId, (userId) => refreshConnection(userId, String(connectionId)), { refresh: true });
}

export async function deleteConnectionAction(workspaceId: string, connectionId: string): Promise<ActionResult<null>> {
  return run(workspaceId, async (userId) => {
    await deleteConnection(userId, String(connectionId));
    return null;
  }, { refresh: true });
}

export async function setToolKindAction(workspaceId: string, connectionId: string, tool: string, kind: ToolKind | null): Promise<ActionResult<ConnectionView>> {
  const valid = kind === "read" || kind === "write" ? kind : null;
  return run(workspaceId, (userId) => setToolKind(userId, String(connectionId), String(tool), valid));
}

/** Begins signing in to the service: the address to open (null: already signed in). */
export async function beginConnectionOAuthAction(workspaceId: string, connectionId: string): Promise<ActionResult<{ url: string } | null>> {
  return run(workspaceId, (userId) => beginConnectionOAuth(userId, String(connectionId)), { refresh: true });
}

export async function signOutConnectionAction(workspaceId: string, connectionId: string): Promise<ActionResult<ConnectionView>> {
  return run(workspaceId, (userId) => signOutConnection(userId, String(connectionId)), { refresh: true });
}

export async function revealEventSecretAction(workspaceId: string, connectionId: string): Promise<ActionResult<string>> {
  return run(workspaceId, (userId) => revealEventSecret(userId, String(connectionId)));
}

/** A new event secret (none given), or the service's own (Slack's signing secret). */
export async function setEventSecretAction(workspaceId: string, connectionId: string, secret?: string): Promise<ActionResult<string>> {
  return run(workspaceId, (userId) => setEventSecret(userId, String(connectionId), typeof secret === "string" ? secret : undefined));
}

export async function listConnectionEventsAction(workspaceId: string, connectionId: string): Promise<ActionResult<ConnectionEventView[]>> {
  return run(workspaceId, (userId) => listConnectionEvents(userId, String(connectionId)));
}

const triggerInput = (value: TriggerInput): TriggerInput => ({
  agentId: value?.agentId,
  eventType: value?.eventType,
  prompt: value?.prompt,
  enabled: value?.enabled,
});

export async function listTriggersAction(workspaceId: string, connectionId: string): Promise<ActionResult<ConnectionTriggerView[]>> {
  return run(workspaceId, (userId) => listTriggers(userId, String(connectionId)));
}

export async function createTriggerAction(workspaceId: string, connectionId: string, value: TriggerInput): Promise<ActionResult<ConnectionTriggerView>> {
  return run(workspaceId, (userId) => createTrigger(userId, String(connectionId), triggerInput(value)));
}

export async function updateTriggerAction(workspaceId: string, triggerId: string, value: TriggerInput): Promise<ActionResult<ConnectionTriggerView>> {
  return run(workspaceId, (userId) => updateTrigger(userId, String(triggerId), triggerInput(value)));
}

export async function deleteTriggerAction(workspaceId: string, triggerId: string): Promise<ActionResult<null>> {
  return run(workspaceId, async (userId) => {
    await deleteTrigger(userId, String(triggerId));
    return null;
  });
}

export async function listAgentGrantsAction(workspaceId: string, agentId: string): Promise<ActionResult<AgentGrantView[]>> {
  return run(workspaceId, (userId) => listAgentGrants(userId, String(agentId)));
}

export async function setAgentGrantAction(workspaceId: string, agentId: string, connectionId: string, tools: string[]): Promise<ActionResult<AgentGrantView[]>> {
  const list = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [];
  return run(workspaceId, (userId) => setAgentGrant(userId, String(agentId), String(connectionId), list));
}

/** An owner's answer to an agent's call that waits for approval. */
export async function decideApprovalAction(
  workspaceId: string,
  value: { runId: string; callId: string; decision: ApprovalDecision; note?: string },
): Promise<ActionResult<{ runId: string }>> {
  const decision: ApprovalDecision | null = value?.decision === "approve" || value?.decision === "decline" || value?.decision === "redo" ? value.decision : null;
  return run(workspaceId, (userId) => {
    if (!decision) throw new ApprovalError("invalid", "Unknown answer");
    return decideApproval(userId, { runId: String(value.runId), callId: String(value.callId), decision, note: typeof value.note === "string" ? value.note : undefined });
  });
}
