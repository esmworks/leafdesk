// Client-safe: shared by the agents' server side (src/server/agents), the settings and the
// automation editor.

import type { AgentShareLevel } from "./agent-sharing";
import type { ChatStepRecord, MemoryStatus } from "@/db/schema/ai";
import type { RepeatRule, ScheduleError } from "./schedule";

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
/** The most of a thread a mention's run reads: its last comments before the one that mentioned the agent, oldest first. */
export const MENTION_THREAD_COMMENTS = 20;
export const MENTION_THREAD_CHARS = 8_000;
/** Schedules one agent may have. */
export const MAX_AGENT_SCHEDULES = 10;
/**
 * Changes a schedule's run on a database may make (rows changed and comments written, together): it
 * looks after the whole database, where a row's run looks after one row (MAX_AGENT_WRITES).
 */
export const MAX_SCHEDULED_WRITES = 30;
/** Months of an agent's usage kept, this one included. */
export const AGENT_USAGE_MONTHS = 12;
/** The highest monthly token limit an owner may set (a billion). */
export const MAX_AGENT_TOKEN_LIMIT = 1_000_000_000;

/** Model turns one run may take, writes it may make, and how long it may last. */
export const MAX_AGENT_ROUNDS = 8;
export const MAX_AGENT_WRITES = 5;
export const AGENT_RUN_TIMEOUT_MS = 2 * 60_000;
/** Other agents one agent may ask (its "Agents it can ask"), and times one run may ask them. */
export const MAX_AGENT_HELPERS = 10;
export const MAX_HANDOFFS_PER_RUN = 3;
/**
 * The longest a run waits, in all, for the agents it asks: its own time stands still meanwhile, so a
 * run of AGENT_RUN_TIMEOUT_MS lasts at most 6 minutes.
 */
export const MAX_HANDOFF_WAIT_MS = 4 * 60_000;
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
/** Where one of an agent's runs opens in Settings (its Runs tab), for its owners. */
export const agentRunPath = (workspaceId: string, agentId: string, runId: string) => `/w/${workspaceId}/settings?tab=agents&agent=${agentId}&run=${runId}`;
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

/**
 * Which of the server's models an agent's runs use: its main model (AI_MODEL), or its cheaper fast
 * one (AI_FAST_MODEL), for routine, well-defined jobs. Without a fast model, and on a workspace's
 * own AI account, which has one model, "fast" runs on the main model.
 */
export const AGENT_MODELS = ["main", "fast"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const isAgentModel = (value: unknown): value is AgentModel => typeof value === "string" && (AGENT_MODELS as readonly string[]).includes(value);

/**
 * What an agent's runs do with the rows they add or change (create_row, update_row): write them at
 * once ("direct", as agents always did), or propose them for review ("review"): each change waits
 * in the workspace's "For review" queue (server/pending-changes.ts) until a person approves it,
 * maybe after editing it, or dismisses it.
 */
export const AGENT_ROW_CHANGES = ["direct", "review"] as const;
export type AgentRowChanges = (typeof AGENT_ROW_CHANGES)[number];

export const isAgentRowChanges = (value: unknown): value is AgentRowChanges =>
  typeof value === "string" && (AGENT_ROW_CHANGES as readonly string[]).includes(value);

/** Where an owner asked for a run: the REST API or an MCP client. */
export const AGENT_RUN_VIAS = ["api", "mcp"] as const;
export type AgentRunVia = (typeof AGENT_RUN_VIAS)[number];

/**
 * What started a run: an automation on a row, an event a connection received, an owner who asked
 * for it with a task of their own (on a row of a database, or on none), one of the agent's
 * schedules (on a database, or on none), a member who mentioned it in a comment, or a person's
 * message in a chat with the agent (see lib/agent-chat.ts).
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
    }
  | {
      kind: "schedule";
      scheduleId: string;
      /** The owner who set the schedule last; the run is held to their access as well. */
      scheduledBy: string;
      /** The database it looks after, when the schedule names one: it may change and comment on its rows. */
      databaseId?: string;
    }
  | {
      kind: "mention";
      /** The page the comment is on, its thread and the comment that mentioned the agent. */
      pageId: string;
      threadId: string;
      commentId: string;
      /** The member who wrote the comment; the run is held to their access as well. */
      mentionedBy: string;
    }
  | {
      kind: "handoff";
      /** The run of the agent that asked (`fromAgentId`), and its call: one call asks once. */
      parentRunId: string;
      fromAgentId: string;
      callId: string;
      /** Whose access holds the asking run besides its agent's own: the helper's run is held to it too. */
      boundTo: string | null;
      /** Whether someone stands behind what the asking run read; if not, the helper's run asks before each connection tool. */
      trusted: boolean;
      /** What started the asking run: who sees what the helper's run did is who sees that run's. */
      parent: Exclude<AgentRunSource, { kind: "handoff" }>;
    }
  | {
      kind: "chat";
      /** Who wrote the message; the run is held to their access as well, and is theirs alone. */
      userId: string;
      /** Their conversation (`agent_conversation`) the answer goes to. */
      conversationId: string;
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
      /**
       * The owner who asked for the run (as `source.requestedBy`), set its schedule
       * (`source.scheduledBy`), or the member who mentioned the agent (`source.mentionedBy`).
       */
      actorId: string;
      /** A schedule's run: when it was due (ISO). */
      scheduledFor?: string;
      /** A mention's run: the language the comment was written in, for what the agent says when it can't answer. */
      locale?: string;
    };

/** `awaiting_approval`: a tool that may change something outside waits for an owner's answer. */
export const AGENT_RUN_STATUSES = ["pending", "running", "awaiting_approval", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** A comment the agent wrote on a page. */
export type AgentCommentRecord = { kind: "comment"; pageId: string; text: string; outcome: "done" | "failed" };

/** An email the agent drafted on a row (`proposed`: it waits for its sender's review), or couldn't. */
export type AgentEmailRecord = { kind: "email"; pageId: string; subject: string; outcome: "proposed" | "failed" };

/**
 * A call to a connection's tool: read at once (`done`/`failed`), or one that waited for approval
 * and was sent (`done`/`failed`), declined, sent back to be redone, or never answered. Without a
 * connection (null), a call to Leafdesk's own tool that waited for approval (a row an event's run
 * adds) and was declined, sent back or never answered; once made, it shows as the change it made.
 */
export type AgentToolRecord = {
  kind: "tool";
  connectionId: string | null;
  tool: string;
  /** The input, as sent (or as it would have been), cut to fit. */
  input: string;
  /** `refused`: a page a schedule's run may not read with no one to ask (lib/web-calls.ts); nothing was sent. */
  outcome: "done" | "failed" | "declined" | "redo" | "expired" | "refused";
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

/**
 * Another agent the run asked (see server/agents/handoff.ts): its run, and how it went (`waiting`:
 * the run still waits, for an owner's approval or its turn), or why it couldn't be asked.
 */
export type AgentHandoffRecord = {
  kind: "handoff";
  agentId: string;
  agentName: string;
  runId: string | null;
  task: string;
  outcome: "done" | "failed" | "waiting" | "paused" | "archived" | "limitReached";
};

/** One thing a run did: followed a skill, searched, read, queried, changed, thought aloud, commented, used a tool or asked another agent. */
export type AgentStepRecord = ChatStepRecord | AgentCommentRecord | AgentEmailRecord | AgentToolRecord | AgentSkillRecord | AgentHandoffRecord;

/** A call waiting for approval: what will be sent, and since when. No connection (null): Leafdesk's own tool. */
export type AgentPendingCall = {
  callId: string;
  connectionId: string | null;
  tool: string;
  arguments: Record<string, unknown>;
  askedAt: string;
};

/** The tools of an agent with web access (server/agents/web.ts): Leafdesk's own, so their steps name no connection. */
export const WEB_TOOL_NAMES = { read: "read_web_page", search: "search_web" } as const;

/** What a call to Leafdesk's own tool (no connection) names in place of a connection. */
export const OWN_TOOLS_NAME = "Leafdesk";

/** The name of the connection a call goes to, from `names`; Leafdesk's for its own tools. */
export const callConnectionName = (connectionId: string | null, names: ReadonlyMap<string, string>) =>
  connectionId === null ? OWN_TOOLS_NAME : (names.get(connectionId) ?? "");

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
 * archived, it can't open the row, the comment that mentioned it is gone, the model failed, the
 * run took too long, no one answered a call that waited for approval, the agent used its tokens
 * for the month, or the workspace's AI reached its monthly cost limit.
 */
export const AGENT_RUN_CODES = [
  "aiOff",
  "agentDisabled",
  "noAccess",
  "rowGone",
  "databaseGone",
  "commentGone",
  "provider",
  "timeout",
  "tooManyAttempts",
  "approvalTimeout",
  "connectionGone",
  "limitReached",
  "costLimit",
  "error",
] as const;
export type AgentRunCode = (typeof AGENT_RUN_CODES)[number];

export type AgentRunUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rounds: number;
  /** The model that answered its latest turn (runs from before it was kept have none). */
  model?: string;
};

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
  /** Whether its runs may read public web pages (read_web_page, and search_web where the server has a search service). */
  webAccess: boolean;
  /**
   * The most tokens (in and out) its runs may use in a calendar month (UTC); null: no limit. A run
   * stops at its first turn once the month's tokens reach it.
   */
  monthlyTokenLimit: number | null;
  /** Which of the server's models its runs use (see AGENT_MODELS). */
  model: AgentModel;
  /** Whether its runs change rows at once or propose the changes for review (see AGENT_ROW_CHANGES). */
  rowChanges: AgentRowChanges;
  /** The viewer's level on it (lib/agent-sharing): owners of the workspace always have full access. */
  access: AgentShareLevel;
  createdAt: string;
  updatedAt: string;
};

/** Whether the viewer may change the agent (edit or full access), not just see it and chat with it. */
export const editsAgent = (agent: Pick<AgentView, "access">) => agent.access !== "interact";

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
 * viewer can't open, or from a run another owner started for themselves, has no `text` for them:
 * it may quote what they can't open; they may only dismiss it.
 */
export type AgentMemoryView = {
  id: string;
  text: string | null;
  status: MemoryStatus;
  run: {
    id: string;
    createdAt: string;
    rowId: string | null;
    rowTitle: string | null;
    connectionName: string | null;
    requested: boolean;
    /** A schedule started it; `databaseHidden`: on a database the viewer can't open (its proposals' text is hidden too). */
    scheduled: boolean;
    databaseHidden: boolean;
    /** Another owner asked for it, or a schedule of theirs without a database started it: its proposals' text is theirs alone. */
    othersRun: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * One of an agent's schedules as its owners see it: when it runs, the task, the database it looks
 * after (its title only for those who can open it) and how the agent may open that database now.
 */
export type AgentScheduleView = {
  id: string;
  rule: RepeatRule;
  timeZone: string;
  /** Empty when it is hidden: the viewer can't open the database, and the task may name what is in it. */
  task: string;
  taskHidden: boolean;
  databaseId: string | null;
  databaseTitle: string | null;
  databaseIcon: string | null;
  /** The agent's access to the database: "none" (its runs skip until it is shared), "view" and "comment" (it can't change rows). */
  agentAccess: "none" | "view" | "comment" | "edit" | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: ScheduleError | null;
  /** The owner who set it last: its runs are held to their access. */
  setBy: { id: string; name: string } | null;
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
  /** For a chat's run: who wrote, and their message (empty for anyone else: a conversation is its person's). */
  chat: { by: string; byName: string; message: string } | null;
  /**
   * For a run a schedule started: the schedule, who set it, the task and the database it looks
   * after (`databaseTitle` and `task` empty where the viewer can't open the database).
   */
  schedule: { id: string; by: string; byName: string; task: string; databaseId: string | null; databaseTitle: string } | null;
  /**
   * For a run a comment started: who mentioned the agent, the page and thread, and the comment
   * (`pageTitle` null and `task` empty where the viewer can't open the page).
   */
  mention: { by: string; byName: string; pageId: string; threadId: string; pageTitle: string | null; task: string } | null;
  /** For a run another agent asked for: that agent, its run, and the task (empty where the viewer may not see it). */
  handoff: { fromAgentId: string; fromName: string; parentRunId: string; task: string } | null;
  /** Names of the connections the run's source, steps and waiting call name (removed ones are left out). */
  connections: Record<string, string>;
  createdAt: string;
  finishedAt: string | null;
};

type RowSource = Extract<AgentRunSource, { kind: "automation" }> | (Extract<AgentRunSource, { kind: "request" }> & { rowId: string; databaseId: string });

/** Whether a run works on a row: an automation's, or one asked for on a row. */
export const isRowRun = (source: AgentRunSource): source is RowSource =>
  source.kind === "automation" || (source.kind === "request" && typeof source.rowId === "string" && typeof source.databaseId === "string");

/** Whether a schedule started a run. */
export const isScheduleRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "schedule" }> => source.kind === "schedule";

/** The task a schedule gives its agent each time. */
export const MAX_SCHEDULE_TASK = MAX_AGENT_PROMPT;

/** Whether a run answers an event a connection received. */
export const isEventRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "connection" }> => source.kind === "connection";

/** Whether a comment that mentioned the agent started a run. */
export const isMentionRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "mention" }> => source.kind === "mention";

/** What decides who sees a run's work: its own source, or for a run another agent asked for, that agent's run's. */
export const accessSource = (source: AgentRunSource): Exclude<AgentRunSource, { kind: "handoff" }> => (source.kind === "handoff" ? source.parent : source);

/** The page whose access decides who sees a run's work: its row, its schedule's database, or the page its comment is on. */
export const runPageOf = (given: AgentRunSource): string | null => {
  const source = accessSource(given);
  return isRowRun(source) ? source.rowId : isScheduleRun(source) ? (source.databaseId ?? null) : isMentionRun(source) ? source.pageId : null;
};

/**
 * Whether an owner sees what a run read, thought and answered, and the call it waits on, and so
 * may answer that call (`opensPage`: whether they can open runPageOf). What a run did can quote
 * pages the agent may open and the owner may not. A row's run puts it all on the row anyway, so
 * it is for those who can open the row; a schedule's run on a database, for those who can open
 * the database. A mention's run answers in the page's comments: it is for those who can open the
 * page, as a row's run is. A run an owner asked for, or one of a schedule without a database, read
 * with that owner's access: it is theirs alone, as a chat's run is its person's (an owner's or
 * not). A connection's event is the owners' (they set up the connection), as is the run it started.
 */
export function ownerSeesRun(given: AgentRunSource, userId: string, opensPage: boolean): boolean {
  // A helper's run read for the run that asked it: it shows to whoever that run shows to.
  const source = accessSource(given);
  if (source.kind === "request") return source.requestedBy === userId && (!isRowRun(source) || opensPage);
  if (source.kind === "chat") return source.userId === userId;
  if (isRowRun(source) || isMentionRun(source)) return opensPage;
  if (isScheduleRun(source)) return source.databaseId ? opensPage : source.scheduledBy === userId;
  return true;
}
