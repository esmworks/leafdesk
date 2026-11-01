// Client-safe: shared by the agents' server side (src/server/agents), the settings and the
// automation editor.

import { agentPagePath } from "./agent-page";
import type { AgentShareLevel } from "./agent-sharing";
import type { ChatStepRecord, MemoryKind, MemoryStatus } from "@/db/schema/ai";
import type { QuietHours } from "./quiet-hours";
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
/** Runs owners asked for, and tasks other agents gave it, that one agent may have waiting or under way at once. */
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

/** Writes one run may make. What it may spend is AI_RUN_LIMIT_USD; it has no turn or time limit of its own. */
export const MAX_AGENT_WRITES = 5;
/**
 * Rows one run that read email may propose (agents/run.ts): nothing changes until the person
 * approves, so a list read from an email (a day's balances) is proposed whole.
 */
export const MAX_MAIL_PROPOSALS = 60;
/** Other agents one agent may ask (its "Agents it can ask"), and times one run may ask them. */
export const MAX_AGENT_HELPERS = 10;
export const MAX_HANDOFFS_PER_RUN = 3;
/** Tasks given to other agents that an agent's run lists at once (`agent_tasks`), newest first. */
export const MAX_LISTED_TASKS = 10;
/** The longest a run waits, in all, for the agents it asks. */
export const MAX_HANDOFF_WAIT_MS = 4 * 60_000;
/** Skills one agent may have, and how much of them one run reads (all of them together). */
export const MAX_AGENT_SKILLS = 10;
export const MAX_AGENT_SKILL_CHARS = 12_000;
/**
 * Notes an agent's runs may have waiting for an owner at once (see server/agents/memory.ts); its
 * kept notes are bounded as the AI chat's are (MAX_MEMORIES, MAX_MEMORY_CHARS each).
 */
export const MAX_AGENT_PROPOSALS = 10;
/** Notes one run may propose: what it learned that lasts is rarely more than a fact or two. */
export const MAX_PROPOSALS_PER_RUN = 2;
/** Corrections one chat run may keep at once (server/agents/memory.ts); it proposes those past them. */
export const MAX_CORRECTIONS_PER_RUN = 3;
/** The longest note a schedule's run leaves for its next run (where it left off). */
export const MAX_HANDOFF_CHARS = 2_000;
/**
 * Runs new email may start for one agent in one mailbox (agents/mail-trigger.ts), in the last hour
 * and in the last day: mail sent in bulk, or a loop of replies, can't spend the month in an hour.
 */
export const MAX_MAIL_RUNS_PER_HOUR = 20;
export const MAX_MAIL_RUNS_PER_DAY = 100;
/** The task new email gives the agent, and the senders and subject words a trigger's filters name. */
export const MAX_MAIL_TASK = MAX_AGENT_PROMPT;
export const MAX_MAIL_SENDERS = 50;
export const MAX_MAIL_SUBJECT = 200;

/** Where an agent's memory opens in Settings (its Memory tab), for its owners. */
export const agentMemoryPath = (workspaceId: string, agentId: string) => `/w/${workspaceId}/settings?tab=agents&agent=${agentId}&agentTab=memory`;
/** Where one of an agent's runs opens in Settings (its Runs tab), for its owners. */
export const agentRunPath = (workspaceId: string, agentId: string, runId: string) => `/w/${workspaceId}/settings?tab=agents&agent=${agentId}&run=${runId}`;
/** Where a scheduled run's report opens, for the person who set the schedule: the agent's own chat, at that run. */
export const agentReportPath = (workspaceId: string, agentId: string, runId: string) => `${agentPagePath(workspaceId, agentId)}?run=${runId}`;
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
      /**
       * A task given to do in its own time (`assign_agent`) rather than waited for: the asking agent
       * reads how it went with `agent_tasks`, and the person behind the asking run gets its report.
       */
      queued?: true;
    }
  | {
      kind: "chat";
      /** Who wrote the message; the run is held to their access as well, and is theirs alone. */
      userId: string;
      /** Their conversation (`agent_conversation`) the answer goes to. */
      conversationId: string;
      /** Sent from a connected app (MCP, the REST API, the Telegram bot), which reads the answer. */
      fromApp?: boolean;
      /** Its messages waited in the queue while this run answered (lib/agent-chat-queue.ts). */
      after?: string;
      /**
       * Its message (or one of those that waited) came from the Telegram bot, which follows this
       * run's answer too: the person's own words, unlike another connected app's.
       */
      telegram?: true;
      /**
       * Its message (or one of those that waited) came from a connected app other than the
       * Telegram bot (MCP, the REST API): another app's words, never kept as the person's own.
       */
      otherApp?: true;
      /**
       * The web session it was sent from in the app (each message of a merged turn from the same
       * one): only the desktop app connected with this very session lends the run its computer
       * (server/agents/computer.ts), so a chat sent from a phone or another computer gets none.
       */
      sessionId?: string;
    }
  | {
      kind: "mail";
      /** The mailbox the email came to, which its owner (`userId`) opened to the agent (agent_mailbox). */
      mailboxId: string;
      /** The mailbox's owner; the run is held to their access as well, and is theirs alone. */
      userId: string;
      /** The thread of the Mail tab's index the email is in, and the email (`mail_message` ids). */
      threadId: string;
      messageId: string;
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
       * (`source.scheduledBy`), the member who mentioned the agent (`source.mentionedBy`), or whose
       * email started it (`source.userId`).
       */
      actorId: string;
      /** A schedule's run: when it was due (ISO). */
      scheduledFor?: string;
      /** A mention's run: the language the comment was written in, for what the agent says when it can't answer. */
      locale?: string;
      /** The zone the run's times read in: the browser's of whoever wrote a chat message, a schedule's own. */
      timeZone?: string;
      /** A chat's run: the text files attached to its messages (lib/agent-chat-files.ts), which go to the model as data. */
      files?: { name: string; size: number; text: string }[];
    };

/** `awaiting_approval`: a tool that may change something outside waits for an owner's answer. */
export const AGENT_RUN_STATUSES = ["pending", "running", "awaiting_approval", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** A comment the agent wrote on a page. */
export type AgentCommentRecord = { kind: "comment"; pageId: string; text: string; outcome: "done" | "failed" };

/**
 * An email the agent drafted on a row (`proposed`: it waits for its sender's review), or couldn't;
 * or, without a row (`pageId` null), one it sent to the agent's recipients (`to`), or couldn't.
 */
export type AgentEmailRecord = { kind: "email"; pageId: string | null; subject: string; outcome: "proposed" | "sent" | "failed"; to?: string[] };

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
  /**
   * `refused`: a page a schedule's run may not read with no one to ask (lib/web-calls.ts); `afterMail`:
   * a call besides reading pages and drafting after the run read email (agents/mail.ts);
   * `afterLocalRead`: a call that would carry something out (a connection's tool, the web, another
   * agent, sending email) after the run, or its conversation, read files on the person's computer
   * (agents/run.ts); `denied`: an owner's rule declines every call of the tool; `limited`: a change
   * past the agent's daily limit (of any tool, Leafdesk's own too). Nothing was sent.
   */
  outcome: "done" | "failed" | "declined" | "redo" | "expired" | "refused" | "afterMail" | "afterLocalRead" | "denied" | "limited";
  /** Who approved, declined or sent it back. */
  decidedBy?: string | null;
  /** An owner's "allow" rule sent it without asking (lib/connections.ts TOOL_RULES): no one approved it. */
  rule?: "allow";
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
 * the run still waits, for an owner's approval or its turn; `queued`: given as a task to do in its
 * own time), or why it couldn't be asked.
 */
export type AgentHandoffRecord = {
  kind: "handoff";
  agentId: string;
  agentName: string;
  runId: string | null;
  task: string;
  outcome: "done" | "failed" | "waiting" | "queued" | "paused" | "archived" | "limitReached" | "busy";
};

/** One thing a run did: followed a skill, searched, read, queried, changed, thought aloud, commented, used a tool or asked another agent. */
export type AgentStepRecord = ChatStepRecord | AgentCommentRecord | AgentEmailRecord | AgentToolRecord | AgentSkillRecord | AgentHandoffRecord;

/**
 * A call waiting for approval: what will be sent, and since when. No connection (null): Leafdesk's
 * own tool. `deferredUntil`: a call an owner's rule lets go without asking, held for the agent's
 * quiet hours; no one is asked, and the run goes on at that time (an owner may still approve it
 * before then).
 */
export type AgentPendingCall = {
  callId: string;
  connectionId: string | null;
  tool: string;
  arguments: Record<string, unknown>;
  askedAt: string;
  deferredUntil?: string;
};

/** The tools of an agent with web access (server/agents/web.ts): Leafdesk's own, so their steps name no connection. */
export const WEB_TOOL_NAMES = { read: "read_web_page", search: "search_web" } as const;

/**
 * The tools a chat's run gets for files on its person's computer, while their desktop app is
 * connected (server/agents/computer.ts): Leafdesk's own, so their steps name no connection. A
 * step's input is the file's place as `{"path": "<folder>/<path>"}` (and `bytes` for a write),
 * never what a file holds; `declined`: the person said no on their computer, `expired`: no one
 * answered there in time.
 */
export const COMPUTER_TOOL_NAMES = { list: "computer_list_folder", read: "computer_read_file", write: "computer_write_file", trash: "computer_trash_file" } as const;
/** The computer's tools that bring what it holds into the run: words no one in the conversation wrote. */
export const COMPUTER_READ_TOOLS: ReadonlySet<string> = new Set([COMPUTER_TOOL_NAMES.list, COMPUTER_TOOL_NAMES.read]);
export const isComputerTool = (name: string) => Object.values(COMPUTER_TOOL_NAMES).some((n) => n === name);

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
 * archived, it can't open the row, the comment that mentioned it is gone, the email that started
 * it is gone (or its mailbox no longer opened to the agent), the model failed, the
 * run took too long, no one answered a call that waited for approval, the agent used its tokens
 * for the month, the workspace's AI reached its monthly cost limit, or a schedule's run said it
 * couldn't do its task (finish_run, see finishRunCall; its reason is the run's answer).
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
  "mailGone",
  "limitReached",
  "costLimit",
  "selfReported",
  "error",
] as const;
export type AgentRunCode = (typeof AGENT_RUN_CODES)[number];

/** The tool a schedule's run ends itself with (server/agents/run.ts): nothing new to report, or the task couldn't be done. */
export const FINISH_RUN_TOOL = "finish_run";
export const FINISH_RUN_OUTCOMES = ["nothing_new", "failed"] as const;
export type FinishRunOutcome = (typeof FINISH_RUN_OUTCOMES)[number];
/** The most of the reason finish_run keeps. */
export const MAX_FINISH_REASON = 300;

/** The outcomes of a tool step whose call wasn't made: refused, declined by an owner's rule or a person, never answered or past the daily limit. */
const BLOCKED_TOOL_OUTCOMES: ReadonlySet<AgentToolRecord["outcome"]> = new Set(["declined", "expired", "refused", "afterMail", "afterLocalRead", "denied", "limited"]);

/**
 * Whether a run's steps leave its person something to hear besides changes: a call that wasn't
 * made (BLOCKED_TOOL_OUTCOMES) or a task given to another agent to do later (`assign_agent`, a
 * `queued` handoff).
 */
export const leftUntold = (steps: readonly AgentStepRecord[]): boolean =>
  steps.some((s) => (s.kind === "tool" && BLOCKED_TOOL_OUTCOMES.has(s.outcome)) || (s.kind === "handoff" && s.outcome === "queued"));

/**
 * A finish_run call checked: how the run ends and why, or what the agent is told instead. A run
 * that changed something (`changed`) can't end as nothing new: what it changed must be told, in
 * a report; nor can one that left something untold (`untold`, see leftUntold): a call it couldn't
 * make, or a task it gave another agent. A failure needs its reason; nothing new may have one.
 */
export function finishRunCall(
  args: Record<string, unknown>,
  { changed, untold }: { changed: boolean; untold: boolean },
): { outcome: FinishRunOutcome; reason: string } | { error: string } {
  const outcome = FINISH_RUN_OUTCOMES.find((o) => o === args.outcome);
  if (!outcome) return { error: `outcome is "nothing_new" or "failed". The run goes on.` };
  const reason = typeof args.reason === "string" ? args.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length > MAX_FINISH_REASON) return { error: `The reason has at most ${MAX_FINISH_REASON} characters. The run goes on.` };
  if (outcome === "failed" && !reason) return { error: "Give a reason: why the task couldn't be done, for the person who set the schedule. The run goes on." };
  if (outcome === "nothing_new" && changed) {
    return { error: "You changed something in this run, so it isn't nothing new: the person who set the schedule must hear what changed. Don't call finish_run; write your report as your final message." };
  }
  if (outcome === "nothing_new" && untold) {
    return {
      error:
        "In this run a call wasn't made (refused, declined or past a limit) or you gave another agent a task, so it isn't nothing new: the person who set the schedule must hear of it. Don't call finish_run nothing_new; write your report as your final message.",
    };
  }
  return { outcome, reason };
}

export type AgentRunUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rounds: number;
  /** The model that answered its latest turn (runs from before it was kept have none). */
  model?: string;
};

/** An agent as the settings show it. */
/** What a copy of an agent (server/agents/duplicate.ts) left out, by part: how many of each. Absent when it took all of it. */
export type CopyLeftOut = { skills?: number; helpers?: number; connections?: number };

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
  /** Addresses its runs may send email to (send_email), from the mailbox of the person a run works for. */
  mailRecipients: string[];
  /**
   * The most tokens (in and out) its runs may use in a calendar month (UTC); null: no limit. A run
   * stops at its first turn once the month's tokens reach it.
   */
  monthlyTokenLimit: number | null;
  /** Which of the server's models its runs use (see AGENT_MODELS). */
  model: AgentModel;
  /** Whether its runs change rows at once or propose the changes for review (see AGENT_ROW_CHANGES). */
  rowChanges: AgentRowChanges;
  /** When connection calls an owner's rule allows wait instead of going (lib/quiet-hours.ts); null: never. */
  quietHours: QuietHours | null;
  /** The most changes its runs may make in a day, together; null: no limit. */
  dailyChangeLimit: number | null;
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
 * it may quote what they can't open; they may only dismiss it. A correction (`kind`) kept from
 * someone's chat names them (`saidBy`, null once they are gone).
 */
export type AgentMemoryView = {
  id: string;
  text: string | null;
  status: MemoryStatus;
  kind: MemoryKind;
  saidBy: { id: string; name: string } | null;
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
  /** A proposal's kept note it would change when kept (null: it would be a new note). */
  replaces: { id: string; text: string } | null;
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
  lastError: Exclude<ScheduleError, "dashboardGone"> | null;
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
  /** What it said at the end; for a schedule's run it ended with finish_run, the reason it gave. */
  answer: string;
  /** A schedule's run that found nothing new (finish_run): it told no one. */
  quiet: boolean;
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
  /** For a run new email started: whose email, and its subject (empty for anyone else: it is their mail). */
  mail: { by: string; byName: string; subject: string } | null;
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

/** Whether new email started a run (agents/mail-trigger.ts). */
export const isMailRun = (source: AgentRunSource): source is Extract<AgentRunSource, { kind: "mail" }> => source.kind === "mail";

/** What decides who sees a run's work: its own source, or for a run another agent asked for, that agent's run's. */
export const accessSource = (source: AgentRunSource): Exclude<AgentRunSource, { kind: "handoff" }> => (source.kind === "handoff" ? source.parent : source);

/** The page whose access decides who sees a run's work: its row, its schedule's database, or the page its comment is on. */
export const runPageOf = (given: AgentRunSource): string | null => {
  const source = accessSource(given);
  return isRowRun(source) ? source.rowId : isScheduleRun(source) ? (source.databaseId ?? null) : isMentionRun(source) ? source.pageId : null;
};

/**
 * Whether a run may read the email its person opened to the agent (server/agents/mail.ts): only one
 * whose steps and answer show to that person alone (ownerSeesRun) and stay in the app: their chat
 * with the agent there, a schedule they set that looks after no database, or one their new email
 * started (it starts as one that read email: agents/run.ts). Never a run another
 * agent asked for, a request (from MCP or the REST API) or a chat sent from a connected app; and
 * what one that read email answered stays out of those too (readEmail).
 */
export const mailRun = (source: AgentRunSource): boolean => (source.kind === "chat" && !source.fromApp) || (isScheduleRun(source) && !source.databaseId) || isMailRun(source);

/**
 * The mail tools of an agent's run (server/ai-chat-mail.ts MAIL_TOOL_NAMES and AGENT_MAIL_ACTIONS):
 * reading (an email's files too) and drafting as the AI chat does, and sorting what came (marking
 * it read or starred, archiving it, moving it to one of the mailbox's folders) and keeping a
 * thread's summary, which the Mail tab can undo or the person write again. Never sending, deleting
 * or the trash.
 */
export const AGENT_MAIL_TOOLS: ReadonlySet<string> = new Set(["search_mail", "read_mail", "read_mail_attachment", "draft_mail", "sort_mail", "summarize_mail"]);

/**
 * What a run that read email may still call besides the mail tools: reading pages (and files on
 * the person's computer, which bring something in but carry nothing out), finding tools, and
 * use_tool, whose writes run.ts refuses on their own.
 */
export const READS_AFTER_MAIL: ReadonlySet<string> = new Set([
  "search_pages",
  "read_page",
  "query_database",
  "list_comments",
  "page_history",
  "page_version",
  "read_attachment",
  "find_tools",
  "use_tool",
  ...COMPUTER_READ_TOOLS,
]);

/**
 * Whether a run that read email may make this call: email is anyone's words and could steer it into
 * carrying what it read away, so only reads and drafts (whose recipients ai-chat-mail.ts checks),
 * never a connected service's tool.
 */
export const mayCallAfterMail = (name: string, connectionTool: boolean): boolean => !connectionTool && (READS_AFTER_MAIL.has(name) || AGENT_MAIL_TOOLS.has(name));

/** The mail steps that read email (ChatMailRecord): drafting, sorting and summarizing don't on their own. */
const READ_MAIL_ACTIONS: ReadonlySet<string> = new Set(["search", "read", "attachment", "earlier"]);

/**
 * Whether a run's steps show it read email, or went on from a conversation that had: its answer
 * may then quote mail, so connected apps (MCP, the REST API) get neither its answer nor its steps,
 * and the chat's next runs only read pages and draft email.
 */
export const readEmail = (steps: readonly { kind: string; action?: unknown }[] | undefined): boolean =>
  (steps ?? []).some((s) => s.kind === "mail" && typeof s.action === "string" && READ_MAIL_ACTIONS.has(s.action));

const WEB_TOOLS: ReadonlySet<string> = new Set(Object.values(WEB_TOOL_NAMES));

/**
 * Leafdesk's further tools (use_tool, server/ai-more-tools.ts) whose answer carries other agents'
 * answers or what reached the person's inbox from others: runs, chats with agents, notifications.
 */
export const OTHERS_WORDS_MORE_TOOLS: ReadonlySet<string> = new Set(["list_agent_runs", "get_agent_chat", "chat_with_agent", "start_agent_run", "list_notifications"]);

/**
 * Whether a run's steps show it read words no one in its conversation wrote: email (readEmail), a
 * web page or search, what a connection's tool answered (failed too: a service's error says what
 * it likes), a folder or file on the person's computer (anything may have put it there), or
 * another agent's answer, which may carry what that agent read (asked with ask_agent, or read
 * through use_tool: OTHERS_WORDS_MORE_TOOLS). A chat run that did keeps no correction at once
 * (server/agents/memory.ts), and an owner's "allow" rule doesn't hold on it (server/agents/run.ts).
 */
export const readOthersWords = (steps: readonly AgentStepRecord[]): boolean =>
  readEmail(steps) ||
  steps.some((s) =>
    s.kind === "tool"
      ? ((s.outcome === "done" || s.outcome === "failed") && (s.connectionId !== null || WEB_TOOLS.has(s.tool))) ||
        (s.connectionId === null && s.outcome === "done" && COMPUTER_READ_TOOLS.has(s.tool))
      : s.kind === "leafdesk"
        ? s.outcome === "done" && OTHERS_WORDS_MORE_TOOLS.has(s.tool)
        : s.kind === "handoff" && s.outcome === "done",
  );

/**
 * Whether an owner sees what a run read, thought and answered, and the call it waits on, and so
 * may answer that call (`opensPage`: whether they can open runPageOf). What a run did can quote
 * pages the agent may open and the owner may not. A row's run puts it all on the row anyway, so
 * it is for those who can open the row; a schedule's run on a database, for those who can open
 * the database. A mention's run answers in the page's comments: it is for those who can open the
 * page, as a row's run is. A run an owner asked for, or one of a schedule without a database, read
 * with that owner's access: it is theirs alone, as a chat's run is its person's (an owner's or
 * not), and one their email started. A connection's event is the owners' (they set up the connection), as is the run it started.
 */
export function ownerSeesRun(given: AgentRunSource, userId: string, opensPage: boolean): boolean {
  // A helper's run read for the run that asked it: it shows to whoever that run shows to.
  const source = accessSource(given);
  if (source.kind === "request") return source.requestedBy === userId && (!isRowRun(source) || opensPage);
  if (source.kind === "chat" || source.kind === "mail") return source.userId === userId;
  if (isRowRun(source) || isMentionRun(source)) return opensPage;
  if (isScheduleRun(source)) return source.databaseId ? opensPage : source.scheduledBy === userId;
  return true;
}
