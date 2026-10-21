"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { AgentAccessLevel, AgentCommentRecord, AgentRunView, AgentSkillRecord, AgentToolRecord } from "@/lib/agents";
import type { ChatStepView } from "@/lib/ai-chat";
import type { RepeatRule } from "@/lib/schedule";
import { ANSWER_PROPERTY_TYPES, FLAG_PROPERTY_TYPES, LOG_PROPERTY_TYPES, ROUTER_PROPERTY_TYPES, type BuiltinAgentSetup } from "@/lib/builtin-agents";
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
import { addAgentMemory, deleteAgentMemory, keepAgentMemory, listAgentMemory, updateAgentMemory } from "@/server/agents/memory";
import { listAgentSchedules, removeAgentSchedule, setAgentSchedule } from "@/server/agents/schedules";
import { addAgentSkill, listAgentSkills, removeAgentSkill } from "@/server/agents/skills";
import { agentUsageMonths } from "@/server/agents/usage";
import { viewStep } from "@/server/ai-chat";
import { getProperties, requireDatabase } from "@/server/databases";
import { requireUserId } from "@/server/session";

// Agents (see server/agents/manage.ts): owners create, change, pause and archive them, choose what
// they may open and read their runs. Expected failures come back translated: Next.js hides thrown
// messages in production.

/** Reasons an `invalid` error names, each with its own message. */
const INVALID_REASONS = ["name", "icon", "level", "template", "database", "property", "option", "rules", "pages", "limit", "task", "taskLength", "repeat"] as const;
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
  webAccess: value?.webAccess,
  monthlyTokenLimit: value?.monthlyTokenLimit,
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

export async function listAgentSkillsAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => listAgentSkills(userId, agentId));
}

export async function addAgentSkillAction(workspaceId: string, agentId: string, pageId: string) {
  return run(workspaceId, async (userId) => {
    await addAgentSkill(userId, agentId, String(pageId));
    return listAgentSkills(userId, agentId);
  });
}

export async function removeAgentSkillAction(workspaceId: string, agentId: string, pageId: string) {
  return run(workspaceId, async (userId) => {
    await removeAgentSkill(userId, agentId, String(pageId));
    return listAgentSkills(userId, agentId);
  });
}

// Each of these answers with the agent's notes as they are now; keeping or dismissing a proposal
// also refreshes the list of agents, which counts the proposals waiting.

export async function listAgentMemoryAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => listAgentMemory(userId, agentId));
}

export async function addAgentMemoryAction(workspaceId: string, agentId: string, text: string) {
  return run(
    workspaceId,
    async (userId) => {
      await addAgentMemory(userId, agentId, String(text));
      return listAgentMemory(userId, agentId);
    },
    { refresh: true },
  );
}

export async function updateAgentMemoryAction(workspaceId: string, agentId: string, memoryId: string, text: string) {
  return run(workspaceId, async (userId) => {
    await updateAgentMemory(userId, agentId, String(memoryId), String(text));
    return listAgentMemory(userId, agentId);
  });
}

/** Keeps a proposal, with `text` changed first when given. */
export async function keepAgentMemoryAction(workspaceId: string, agentId: string, memoryId: string, text?: string) {
  return run(
    workspaceId,
    async (userId) => {
      await keepAgentMemory(userId, agentId, String(memoryId), typeof text === "string" ? text : undefined);
      return listAgentMemory(userId, agentId);
    },
    { refresh: true },
  );
}

/** Deletes notes (dismisses proposals): some by id, every kept note, or every proposal. */
export async function deleteAgentMemoryAction(workspaceId: string, agentId: string, which: string[] | "kept" | "proposed") {
  const target = which === "kept" || which === "proposed" ? which : Array.isArray(which) ? which.map(String) : [];
  return run(
    workspaceId,
    async (userId) => {
      await deleteAgentMemory(userId, agentId, target);
      return listAgentMemory(userId, agentId);
    },
    { refresh: true },
  );
}

/** A comment the agent wrote; its text only when the viewer can open the row it's on. */
export type AgentCommentView = Omit<AgentCommentRecord, "text"> & { text: string | null };
export type AgentStepView = ChatStepView | AgentCommentView | AgentToolRecord | AgentSkillRecord;
export type AgentRunDetails = Omit<AgentRunView, "steps"> & { steps: AgentStepView[] };

/** An agent's schedules (server/agents/schedules.ts), for its owners. */
export async function listAgentSchedulesAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => listAgentSchedules(userId, agentId));
}

/** Adds a schedule (`scheduleId` null) or changes one; returns the agent's schedules as they are now. */
export async function setAgentScheduleAction(
  workspaceId: string,
  agentId: string,
  scheduleId: string | null,
  /** `task` null keeps the one it has (one the owner can't read). */
  value: { rule: RepeatRule; timeZone: string; task: string | null; databaseId: string | null },
) {
  return run(workspaceId, async (userId) => {
    await setAgentSchedule(userId, agentId, scheduleId, { rule: value?.rule, timeZone: value?.timeZone, task: value?.task, databaseId: value?.databaseId ?? null });
    return listAgentSchedules(userId, agentId);
  });
}

export async function removeAgentScheduleAction(workspaceId: string, agentId: string, scheduleId: string) {
  return run(workspaceId, async (userId) => {
    await removeAgentSchedule(userId, agentId, scheduleId);
    return listAgentSchedules(userId, agentId);
  });
}

/** What the agent's runs used by month, this month first. */
export async function agentUsageAction(workspaceId: string, agentId: string) {
  return run(workspaceId, (userId) => agentUsageMonths(userId, agentId));
}

/** An agent's latest runs, with the pages their steps name as the viewer may see them now. */
export async function listAgentRunsAction(workspaceId: string, agentId: string): Promise<ActionResult<AgentRunDetails[]>> {
  return run(workspaceId, async (userId) => {
    // An owner approves a waiting call here: they see it exactly as it will be sent.
    const runs = await listAgentRuns(userId, agentId, undefined, { exact: true });
    return Promise.all(
      runs.map(async (r) => ({
        ...r,
        steps: await Promise.all(
          r.steps.map(async (step): Promise<AgentStepView> =>
            step.kind === "comment"
              ? { ...step, text: r.rowTitle === null ? null : step.text }
              : step.kind === "tool" || step.kind === "skill"
                ? step
                : viewStep(userId, step),
          ),
        ),
      })),
    );
  });
}

/** Property types a built-in agent may use. */
const TEMPLATE_TYPES: readonly string[] = [...new Set([...ROUTER_PROPERTY_TYPES, ...ANSWER_PROPERTY_TYPES, ...FLAG_PROPERTY_TYPES, ...LOG_PROPERTY_TYPES])];

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
