// Client-safe: shared by the agents' server side (src/server/agents), the settings and the
// automation editor.

import type { ChatStepRecord } from "@/db/schema/ai";

/**
 * Agents: named AI helpers with instructions of their own that run without anyone asking, when
 * something happens in the workspace (in this version: an automation's "Run an agent" action).
 *
 * An agent acts as a user of its own (a bot user, a guest of the workspace), so what it changes
 * shows its name, and it sees only the pages shared with it. Owners of the workspace create and
 * edit agents and choose what they may open.
 */

export const MAX_AGENTS = 50;
export const MAX_AGENT_NAME = 80;
export const MAX_AGENT_DESCRIPTION = 300;
export const MAX_AGENT_INSTRUCTIONS = 8_000;
/** The task an automation's "Run an agent" action gives the agent. */
export const MAX_AGENT_PROMPT = 2_000;

/** Model turns one run may take, writes it may make, and how long it may last. */
export const MAX_AGENT_ROUNDS = 8;
export const MAX_AGENT_WRITES = 5;
export const AGENT_RUN_TIMEOUT_MS = 2 * 60_000;
/** Finished runs are kept this long, as the agent's history. */
export const AGENT_RUN_HISTORY_DAYS = 30;

/**
 * What an agent may do with a page shared with it. Never full access: an agent doesn't share
 * pages, manage databases or receive access requests.
 */
export const AGENT_ACCESS_LEVELS = ["view", "comment", "edit"] as const;
export type AgentAccessLevel = (typeof AGENT_ACCESS_LEVELS)[number];

export const isAgentAccessLevel = (value: unknown): value is AgentAccessLevel =>
  typeof value === "string" && (AGENT_ACCESS_LEVELS as readonly string[]).includes(value);

/** What started a run. More kinds (a schedule, a mention, a connection's event) come later. */
export type AgentRunSource = {
  kind: "automation";
  automationId: string;
  automationRunId: string;
  databaseId: string;
  rowId: string;
};

/** What happened that the run responds to, for its prompt and its history. */
export type AgentRunContext = {
  /** The row was added (rather than changed). */
  created: boolean;
  /** Ids of the properties the change touched. */
  changed: string[];
  /** Who made the change; null for anonymous form answers and lost accounts. */
  actorId: string | null;
};

export const AGENT_RUN_STATUSES = ["pending", "running", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** A comment the agent wrote on a page. */
export type AgentCommentRecord = { kind: "comment"; pageId: string; text: string; outcome: "done" | "failed" };

/** One thing a run did: searched, read, queried, changed, thought aloud or commented. */
export type AgentStepRecord = ChatStepRecord | AgentCommentRecord;

/**
 * Why a run ended without doing its work: the workspace turned AI off, the agent was paused or
 * archived, it can't open the row, the model failed, or the run took too long.
 */
export const AGENT_RUN_CODES = ["aiOff", "agentDisabled", "noAccess", "rowGone", "provider", "timeout", "tooManyAttempts", "error"] as const;
export type AgentRunCode = (typeof AGENT_RUN_CODES)[number];

export type AgentRunUsage = { inputTokens: number; outputTokens: number; costUsd: number; rounds: number };

/** An agent as the settings show it. */
export type AgentView = {
  id: string;
  workspaceId: string;
  /** The agent's own user: its edits and comments show this id. */
  userId: string;
  name: string;
  icon: string | null;
  description: string;
  instructions: string;
  enabled: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A page shared with an agent, as its settings list it. */
export type AgentAccessView = {
  pageId: string;
  title: string;
  icon: string | null;
  kind: "page" | "database";
  level: AgentAccessLevel;
};

/** A run as the agent's history shows it. */
export type AgentRunView = {
  id: string;
  status: AgentRunStatus;
  code: AgentRunCode | null;
  error: string | null;
  source: AgentRunSource;
  /** The row's title, when the viewer can open it. */
  rowTitle: string | null;
  steps: AgentStepRecord[];
  answer: string;
  usage: AgentRunUsage | null;
  createdAt: string;
  finishedAt: string | null;
};
