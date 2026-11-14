/**
 * Agent chains (server/agents/chains.ts): agents that run one after another, each with its own
 * task, each handed the answer of the one before. A chain is a schedule of kind "agent_chain" (its
 * name and steps in the schedule's settings): it runs when someone clicks Run now, and on its
 * repeat rule when it repeats. Pure: no server imports, so the sidebar can use the types.
 */
import type { RepeatRule, ScheduleError } from "./schedule";

/** The most steps a chain has, and the fewest (one step is an agent's own schedule). */
export const MAX_CHAIN_STEPS = 8;
export const MIN_CHAIN_STEPS = 2;
export const MAX_CHAIN_NAME = 80;
/** Chains a workspace may have (each is also one of its schedules). */
export const MAX_CHAINS_PER_WORKSPACE = 50;
/** The most of a step's answer the next step reads. */
export const CHAIN_ANSWER_CHARS = 8_000;

/** One step: the agent that runs, its task, and the database it may change (none: it only reads). */
export type AgentChainStep = { agentId: string; task: string; databaseId: string | null };

/** How a chain's run went: under way, every step done, ended early on purpose (nothing new, private reads), or a step failed. */
export const CHAIN_RUN_STATUSES = ["running", "done", "stopped", "failed"] as const;
export type AgentChainRunStatus = (typeof CHAIN_RUN_STATUSES)[number];

/**
 * Why a chain's run ended before its last step: a step's run code (lib/agents AgentRunCode), or one
 * of the chain's own: `nothingNew` (a step ended itself with nothing new), `privateRead` (a step
 * read email or files on a person's computer, which another agent may not be handed), `agentGone`
 * (a step's agent was removed or archived), `lost` (the step's run is gone, or ended where the chain
 * couldn't hear it).
 */
export type AgentChainStopCode = string;

/** What started a chain's run. */
export type AgentChainTrigger = "click" | "schedule";

/** A chain's run as the sidebar shows it. */
export type AgentChainRunView = {
  id: string;
  status: AgentChainRunStatus;
  /** The step under way, or the one it ended at (0-based). */
  step: number;
  trigger: AgentChainTrigger;
  code: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentChainStepView = {
  agentId: string;
  /** Empty when the agent was removed. */
  agentName: string;
  agentIcon: string | null;
  task: string;
  databaseId: string | null;
  databaseTitle: string | null;
};

/**
 * A chain as someone who may run it sees it: those who can edit every agent it runs and open every
 * database its steps look after (each step runs held to their access), so nothing in it is hidden.
 */
export type AgentChainView = {
  id: string;
  name: string;
  steps: AgentChainStepView[];
  /** Whether it also runs on its rule; otherwise only on a click. */
  repeats: boolean;
  rule: RepeatRule;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastError: ScheduleError | null;
  setBy: { id: string; name: string } | null;
  /** The latest run, under way or ended. */
  run: AgentChainRunView | null;
};

export type AgentChainInputError = "name" | "nameLength" | "steps" | "task" | "taskLength";

/**
 * A chain's name and steps as given, checked and trimmed (agents and databases are checked against
 * the workspace on the server), or what is wrong with them.
 */
export function checkChainInput(
  input: { name: unknown; steps: unknown },
  maxTask: number,
): { ok: true; name: string; steps: AgentChainStep[] } | { ok: false; reason: AgentChainInputError } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, reason: "name" };
  if (name.length > MAX_CHAIN_NAME) return { ok: false, reason: "nameLength" };
  if (!Array.isArray(input.steps) || input.steps.length < MIN_CHAIN_STEPS || input.steps.length > MAX_CHAIN_STEPS) return { ok: false, reason: "steps" };
  const steps: AgentChainStep[] = [];
  for (const raw of input.steps as unknown[]) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "steps" };
    const { agentId, task, databaseId } = raw as Record<string, unknown>;
    if (typeof agentId !== "string" || !agentId) return { ok: false, reason: "steps" };
    if (databaseId !== null && databaseId !== undefined && (typeof databaseId !== "string" || !databaseId)) return { ok: false, reason: "steps" };
    const text = typeof task === "string" ? task.trim() : "";
    if (!text) return { ok: false, reason: "task" };
    if (text.length > maxTask) return { ok: false, reason: "taskLength" };
    steps.push({ agentId, task: text, databaseId: typeof databaseId === "string" ? databaseId : null });
  }
  return { ok: true, name, steps };
}

/** Whether a chain's run is still going. */
export const chainRunning = (run: AgentChainRunView | null): boolean => run?.status === "running";
