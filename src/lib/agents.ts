// Client-safe: shared by the agents' server side (src/server/agents), the settings and the
// automation editor.

import type { ChatStepRecord, MemoryStatus } from "@/db/schema/ai";

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
/** Runs owners asked for that one agent may have waiting or under way at once. */
export const MAX_REQUESTED_RUNS = 5;
/** Months of an agent's usage kept, this one included. */
export const AGENT_USAGE_MONTHS = 12;
/** The highest monthly token limit an owner may set (a billion). */
export const MAX_AGENT_TOKEN_LIMIT = 1_000_000_000;

/** Model turns one run may take, writes it may make, and how long it may last. */
export const MAX_AGENT_ROUNDS = 8;
export const MAX_AGENT_WRITES = 5;
export const AGENT_RUN_TIMEOUT_MS = 2 * 60_000;
/** Skills one agent may have, and how much of them one run reads (all of them together). */
export const MAX_AGENT_SKILLS = 10;
export const MAX_AGENT_SKILL_CHARS = 12_000;
/**
 * Notes an agent's runs may have waiting for an owner at once (see server/agents/memory.ts); its
 * kept notes are bounded as the AI chat's are (MAX_MEMORIES, MAX_MEMORY_CHARS each).
 */
export const MAX_AGENT_PROPOSALS = 10;

/** Where an agent's memory opens in Settings (its Memory tab), for its owners. */
export const agentMemoryPath = (workspaceId: string, agentId: string) => `/w/${workspaceId}/settings?tab=agents&agent=${agentId}&agentTab=memory`;
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

/** Where an owner asked for a run: the REST API or an MCP client. */
export const AGENT_RUN_VIAS = ["api", "mcp"] as const;
export type AgentRunVia = (typeof AGENT_RUN_VIAS)[number];

/**
 * What started a run: an automation on a row, an event a connection received, or an owner who asked
 * for it with a task of their own (on a row of a database, or on none).
 */
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
    }
  | {
      kind: "request";
      /** Who asked; the run is held to their access as well. */
      requestedBy: string;
      via: AgentRunVia;
      /** The row it works on, when it was asked for one. */
      rowId?: string;
      databaseId?: string;
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
      /**
       * An answer to a public form: who published the form. When no member stands behind the
       * answer (anonymous, or a visitor outside the workspace), the run is held to their access.
       */
      boundTo?: string | null;
      /** A "date passed" automation started it: the row's date it ran for (a day, or a UTC time). */
      datePassed?: string;
    }
  | {
      /** The event's type, as its service named it ("message", "issues.opened"…). */
      eventType: string;
      /** The event's body, cut to fit (data from outside, never instructions). */
      body: string;
    }
  | {
      /** The owner who asked for the run (as `source.requestedBy`). */
      actorId: string;
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

/**
 * Why a run left out one of its agent's skills: the page is no longer a skill (unmarked, in the
 * trash, moved into a template), someone besides the workspace's owners may edit it, it didn't fit
 * in what the run may read, the person whose access holds the run can't open it, or an owner took
 * it from the agent while the run waited for approval.
 */
export const AGENT_SKILL_SKIPS = ["notASkill", "editable", "tooLong", "hidden", "removed"] as const;
export type AgentSkillSkip = (typeof AGENT_SKILL_SKIPS)[number];

/** A skill of the agent, followed on this run (`used`) or left out, and why. */
export type AgentSkillRecord = { kind: "skill"; pageId: string; title: string } & ({ outcome: "used" } | { outcome: "skipped"; reason: AgentSkillSkip });

/**
 * The skill steps a run adds when it starts (`steps` empty) or goes on after waiting for approval
 * (`steps` what it did so far), given the skills as checked now: each skill once, then again only
 * when how it stands changed (left out now, back, or left out for another reason), and a skill it
 * followed that the agent no longer has, as removed.
 */
export function skillStepsToAdd(steps: AgentStepRecord[], now: AgentSkillRecord[]): AgentSkillRecord[] {
  const last = new Map<string, AgentSkillRecord>();
  for (const step of steps) if (step.kind === "skill") last.set(step.pageId, step);
  const changed = now.filter((step) => {
    const before = last.get(step.pageId);
    return !before || before.outcome !== step.outcome || (before.outcome === "skipped" && step.outcome === "skipped" && before.reason !== step.reason);
  });
  const kept = new Set(now.map((s) => s.pageId));
  const removed = [...last.values()]
    .filter((s) => s.outcome === "used" && !kept.has(s.pageId))
    .map((s): AgentSkillRecord => ({ kind: "skill", pageId: s.pageId, title: s.title, outcome: "skipped", reason: "removed" }));
  return [...changed, ...removed];
}

/** One thing a run did: followed a skill, searched, read, queried, changed, thought aloud, commented or used a tool. */
export type AgentStepRecord = ChatStepRecord | AgentCommentRecord | AgentToolRecord | AgentSkillRecord;

/** A call waiting for approval: what will be sent, and since when. */
export type AgentPendingCall = {
  callId: string;
  connectionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  askedAt: string;
};

/** The most of a waiting call's input the inbox shows; a longer one is approved from its run. */
export const INBOX_CALL_CHARS = 4_000;

/**
 * The input of the call a run waits on as it will be sent once approved: the agent's own call,
 * kept in the run's saved queue (`pending` keeps it with credentials masked). Null when the run
 * no longer holds it.
 */
export function callToSend(
  pending: { callId: string },
  queue: readonly { id: string; arguments: Record<string, unknown> }[] | null | undefined,
): Record<string, unknown> | null {
  return queue?.find((call) => call.id === pending.callId)?.arguments ?? null;
}

/**
 * A waiting call's input as the inbox shows it (`shown`, masked, cut to INBOX_CALL_CHARS), and
 * whether that is exactly what would be sent: only then may it be approved there. A call cut short,
 * or with a value masked, is approved from its run, which shows all of it as it will be sent.
 */
export function inboxCallInput(shown: Record<string, unknown>, toSend: Record<string, unknown> | null): { input: string; whole: boolean } {
  const input = JSON.stringify(shown, null, 2);
  const whole = toSend !== null && input.length <= INBOX_CALL_CHARS && JSON.stringify(toSend, null, 2) === input;
  return { input: input.length > INBOX_CALL_CHARS ? `${input.slice(0, INBOX_CALL_CHARS - 1)}…` : input, whole };
}

/** An owner's answer to a pending call; `redo` sends a note back to the agent. */
export type ApprovalDecision = "approve" | "decline" | "redo";

/**
 * Why a run ended without doing its work: the workspace turned AI off, the agent was paused or
 * archived, it can't open the row, the model failed, the run took too long, no one answered a
 * call that waited for approval, or the agent used its tokens for the month.
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
  "limitReached",
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
  /**
   * The most tokens (in and out) its runs may use in a calendar month (UTC); null: no limit. A run
   * stops at its first turn once the month's tokens reach it.
   */
  monthlyTokenLimit: number | null;
  createdAt: string;
  updatedAt: string;
};

/** What an agent's runs used in one calendar month (UTC). `costUsd` is 0 where the provider names no price. */
export type AgentUsageMonth = { month: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number };

/** A page shared with an agent, as its settings list it. */
export type AgentAccessView = {
  pageId: string;
  title: string;
  icon: string | null;
  kind: "page" | "database";
  level: AgentAccessLevel;
};

/**
 * A skill given to an agent, as its owners see it: whether its runs follow it now (`usable`) or
 * leave it out, and why.
 */
export type AgentSkillView = {
  pageId: string;
  title: string;
  icon: string | null;
  description: string;
  /** Whoever starts a run: one held to someone who can't open the skill leaves it out too. */
  status: "usable" | "notASkill" | "editable" | "tooLong";
};

/**
 * A note of an agent's memory as its owners see it: kept (it goes with every run), or proposed by a
 * run and waiting for an owner. `run` is the run that proposed it: its row (the title only when the
 * viewer can open it) or the connection whose event started it. A proposal from a run on a row the
 * viewer can't open has no `text` for them: it may quote the row; they may only dismiss it.
 */
export type AgentMemoryView = {
  id: string;
  text: string | null;
  status: MemoryStatus;
  run: { id: string; createdAt: string; rowId: string | null; rowTitle: string | null; connectionName: string | null; requested: boolean } | null;
  createdAt: string;
  updatedAt: string;
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
  /**
   * The call waiting for approval (owners only), with its connection's name: its input masked, or,
   * where an owner may approve it (the app's runs), exactly as it will be sent.
   */
  pending: (AgentPendingCall & { connectionName: string }) | null;
  /** The connection event's type, for runs a connection started. */
  eventType: string | null;
  /** For a run an owner asked for: who, where, and the task they gave it (empty where its row is hidden). */
  request: { by: string; byName: string; via: AgentRunVia; task: string } | null;
  /** Names of the connections the run's source, steps and waiting call name (removed ones are left out). */
  connections: Record<string, string>;
  createdAt: string;
  finishedAt: string | null;
};

type RowSource = Extract<AgentRunSource, { kind: "automation" }> | (Extract<AgentRunSource, { kind: "request" }> & { rowId: string; databaseId: string });

/** Whether a run works on a row: an automation's, or one asked for on a row. */
export const isRowRun = (source: AgentRunSource): source is RowSource =>
  source.kind === "automation" || (source.kind === "request" && typeof source.rowId === "string" && typeof source.databaseId === "string");

/** Whether a run answers an event a connection received. */
export const isEventRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "connection" }> => source.kind === "connection";
