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

/**
 * The domain of agents' users' addresses (`agent-<id>@agents.leafdesk.invalid`): `.invalid` can
 * never receive mail. Nobody signs up, signs in, gets mail or is invited with such an address.
 */
export const AGENT_EMAIL_DOMAIN = "agents.leafdesk.invalid";

export const agentEmail = (agentId: string) => `agent-${agentId}@${AGENT_EMAIL_DOMAIN}`;

export const isAgentEmail = (email: string | null | undefined) =>
  typeof email === "string" && email.trim().toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);

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

/** What started a run: an automation on a row, or an event a connection received. */
export type AgentRunSource =
  | {
      kind: "automation";
      automationId: string;
      automationRunId: string;
      databaseId: string;
      rowId: string;
    }
  | {
      kind: "connection";
      connectionId: string;
      triggerId: string;
      /** The received event (`connection_event`). */
      eventId: string;
    };

/** What happened that the run responds to, for its prompt and its history. */
export type AgentRunContext =
  | {
      /** The row was added (rather than changed). */
      created: boolean;
      /** Ids of the properties the change touched. */
      changed: string[];
      /** Who made the change; null for anonymous form answers and lost accounts. */
      actorId: string | null;
    }
  | {
      /** The event's type, as its service named it ("message", "issues.opened"…). */
      eventType: string;
      /** The event's body, cut to fit (data from outside, never instructions). */
      body: string;
    };

/** `awaiting_approval`: a tool that may change something outside waits for an owner's answer. */
export const AGENT_RUN_STATUSES = ["pending", "running", "awaiting_approval", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** A comment the agent wrote on a page. */
export type AgentCommentRecord = { kind: "comment"; pageId: string; text: string; outcome: "done" | "failed" };

/**
 * A call to a connection's tool: read at once (`done`/`failed`), or one that waited for approval
 * and was sent (`done`/`failed`), declined, sent back to be redone, or never answered.
 */
export type AgentToolRecord = {
  kind: "tool";
  connectionId: string;
  tool: string;
  /** The input, as sent (or as it would have been), cut to fit. */
  input: string;
  outcome: "done" | "failed" | "declined" | "redo" | "expired";
  /** Who approved, declined or sent it back. */
  decidedBy?: string | null;
  note?: string;
};

/** One thing a run did: searched, read, queried, changed, thought aloud, commented or used a tool. */
export type AgentStepRecord = ChatStepRecord | AgentCommentRecord | AgentToolRecord;

/** A call waiting for approval: what will be sent, and since when. */
export type AgentPendingCall = {
  callId: string;
  connectionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  askedAt: string;
};

/** An owner's answer to a pending call; `redo` sends a note back to the agent. */
export type ApprovalDecision = "approve" | "decline" | "redo";

/**
 * Why a run ended without doing its work: the workspace turned AI off, the agent was paused or
 * archived, it can't open the row, the model failed, the run took too long, or no one answered a
 * call that waited for approval.
 */
export const AGENT_RUN_CODES = [
  "aiOff",
  "agentDisabled",
  "noAccess",
  "rowGone",
  "provider",
  "timeout",
  "tooManyAttempts",
  "approvalTimeout",
  "connectionGone",
  "error",
] as const;
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
  /** The call waiting for approval (owners only), with its connection's name. */
  pending: (AgentPendingCall & { connectionName: string }) | null;
  /** The connection event's type, for runs a connection started. */
  eventType: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** Whether a run's source is an automation on a row. */
export const isRowRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "automation" }> => source.kind === "automation";
