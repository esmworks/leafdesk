"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { AgentAccessLevel, AgentCommentRecord, AgentRunView, AgentToolRecord } from "@/lib/agents";
import type { ChatStepView } from "@/lib/ai-chat";
import { ANSWER_PROPERTY_TYPES, FLAG_PROPERTY_TYPES, ROUTER_PROPERTY_TYPES, type BuiltinAgentSetup } from "@/lib/builtin-agents";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { installBuiltinAgent } from "@/server/agents/builtin";
import {
  AgentError,
  archiveAgent,
  createAgent,
  listAgentAccess,
  listAgentRuns,
  removeAgentAccess,
  restoreAgent,
  setAgentAccess,
  updateAgent,
  type AgentInput,
} from "@/server/agents/manage";
import { viewStep } from "@/server/ai-chat";
import { getProperties, requireDatabase } from "@/server/databases";
import { requireUserId } from "@/server/session";

// Agents (see server/agents/manage.ts): owners create, change, pause and archive them, choose what
// they may open and read their runs. Expected failures come back translated: Next.js hides thrown
// messages in production.

/** Reasons an `invalid` error names, each with its own message. */
const INVALID_REASONS = ["name", "icon", "level", "template", "database", "property", "option", "rules", "pages"] as const;
type InvalidReason = (typeof INVALID_REASONS)[number];
const isInvalidReason = (value: unknown): value is InvalidReason => (INVALID_REASONS as readonly unknown[]).includes(value);

async function fail(error: unknown): Promise<{ ok: false; error: string } | null> {
  const t = await getTranslations();
  if (error instanceof AgentError) {
    const reason = error.params.reason;
    if (error.code === "invalid" && isInvalidReason(reason)) return { ok: false, error: t(`settings.agents.errors.reasons.${reason}`) };
    return { ok: false, error: t(`settings.agents.errors.${error.code}`, error.params) };
  }
  // Setting up a built-in agent adds properties and an automation: their errors are the database's.
  if (error instanceof PropertyValueError || (error instanceof Error && isDatabaseErrorCode((error as { code?: unknown }).code))) {
    const { code, params } = error as { code?: unknown; params?: Record<string, string> };
    if (isDatabaseErrorCode(code)) return { ok: false, error: t(`database.errors.${code}`, params ?? {}) };
  }
  if (error instanceof AccessError) return { ok: false, error: t("settings.agents.errors.accessDenied") };
  return null;
}

async function run<T>(workspaceId: string, fn: (userId: string) => Promise<T>, { refresh = false } = {}): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    const data = await fn(userId);
    // The Agents tab lists them from the server.
    if (refresh) revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true, data };
  } catch (error) {
    const failed = await fail(error);
    if (failed) return failed;
    console.error("[agent action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

const input = (value: AgentInput): AgentInput => ({
  name: value?.name,
  icon: value?.icon,
  description: value?.description,
  instructions: value?.instructions,
  enabled: value?.enabled,
});

export async function createAgentAction(workspaceId: string, value: AgentInput) {
  return run(workspaceId, (userId) => createAgent(userId, workspaceId, input(value)), { refresh: true });
}

/** Changes an agent; `{ enabled }` alone pauses or resumes it. */
export async function updateAgentAction(workspaceId: string, agentId: string, patch: AgentInput) {
  return run(workspaceId, (userId) => updateAgent(userId, agentId, input(patch)), { refresh: true });
}

export async function archiveAgentAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => archiveAgent(userId, agentId), { refresh: true });
}

export async function restoreAgentAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => restoreAgent(userId, agentId), { refresh: true });
}

export async function listAgentAccessAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => listAgentAccess(userId, agentId));
}

export async function setAgentAccessAction(workspaceId: string, agentId: string, pageId: string, level: AgentAccessLevel) {
  return run(workspaceId, async (userId) => {
    await setAgentAccess(userId, agentId, String(pageId), level);
    return listAgentAccess(userId, agentId);
  });
}

export async function removeAgentAccessAction(workspaceId: string, agentId: string, pageId: string) {
  return run(workspaceId, async (userId) => {
    await removeAgentAccess(userId, agentId, String(pageId));
    return listAgentAccess(userId, agentId);
  });
}

/** A comment the agent wrote; its text only when the viewer can open the row it's on. */
export type AgentCommentView = Omit<AgentCommentRecord, "text"> & { text: string | null };
export type AgentStepView = ChatStepView | AgentCommentView | AgentToolRecord;
export type AgentRunDetails = Omit<AgentRunView, "steps"> & { steps: AgentStepView[] };

/** An agent's latest runs, with the pages their steps name as the viewer may see them now. */
export async function listAgentRunsAction(workspaceId: string, agentId: string): Promise<ActionResult<AgentRunDetails[]>> {
  return run(workspaceId, async (userId) => {
    const runs = await listAgentRuns(userId, agentId);
    return Promise.all(
      runs.map(async (r) => ({
        ...r,
        steps: await Promise.all(
          r.steps.map(async (step): Promise<AgentStepView> =>
            step.kind === "comment" ? { ...step, text: r.rowTitle === null ? null : step.text } : step.kind === "tool" ? step : viewStep(userId, step),
          ),
        ),
      })),
    );
  });
}

/** Property types a built-in agent may use. */
const TEMPLATE_TYPES: readonly string[] = [...ROUTER_PROPERTY_TYPES, ...ANSWER_PROPERTY_TYPES, ...FLAG_PROPERTY_TYPES];

/** The properties of a database a built-in agent could use, for its setup (full access only). */
export async function builtinAgentPropertiesAction(workspaceId: string, databaseId: string) {
  return run(workspaceId, async (userId) => {
    const database = await requireDatabase(userId, String(databaseId), "full");
    if (database.workspaceId !== workspaceId) throw new AccessError();
    const properties = await getProperties(database.id);
    return properties
      .filter((p) => TEMPLATE_TYPES.includes(p.type))
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        options: (p.options.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
      }));
  });
}

/** Sets up a built-in agent on a database, in the owner's language. */
export async function installBuiltinAgentAction(workspaceId: string, setup: BuiltinAgentSetup) {
  const locale = await getLocale();
  return run(workspaceId, (userId) => installBuiltinAgent(userId, workspaceId, setup, { locale }), { refresh: true });
}
