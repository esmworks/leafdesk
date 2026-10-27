/**
 * The agents' worker: takes queued runs (`agent_run`, queued by an automation's "Run an agent"
 * action, a connection's trigger, an owner's request or one of the agent's schedules) and does them, as the agent's own user, with the access it has
 * now. A row's run started by a member's change is also held to what that member may
 * (acting-for.ts): the agent reads and changes only pages and values both of them can, so it never
 * hands someone what they couldn't open themselves. An answer to a public form no member stands
 * behind (anonymous, or a visitor outside the workspace) is held to what the form's publisher may
 * instead. A few run at a time (AI_CONCURRENCY), each
 * within its workspace's AI allowance (a run waits for its turn rather than failing), and apart
 * from the automations' worker, so a long run never holds up a webhook.
 *
 * A run is a short conversation with the model: the agent's instructions, what happened (a row
 * changed, or an event came in), a map of what the agent can open, then turns of tools until it
 * answers or has spent AI_RUN_LIMIT_USD (RUN_ROUNDS for a model without a price). Leafdesk's own tools are narrow: reading what is shared with the agent; on a
 * row's run, changing or commenting on that row; on an event's run, adding rows to databases
 * shared with it to edit (a log of what came in); at most MAX_AGENT_WRITES changes in all. A
 * schedule's run on a database may change and comment on that database's rows instead, at most
 * MAX_SCHEDULED_WRITES times, and tells the owner who set
 * the schedule how it went (`agent_report`). Changes it makes start no automations
 * (`asAutomation`), so agents can't set each other off. On top of those come the tools of
 * connections an owner allowed it: one that only reads runs at once, except where what the run
 * reads was written by someone the workspace doesn't know (a row's run no member started, an
 * anonymous form answer; a schedule's run over a database with such rows; an event's run whose
 * trigger an owner hasn't marked trusted), where every one waits; any other makes the run wait
 * (`awaiting_approval`, its conversation saved in `state`) until an owner answers, and fails it,
 * sending nothing, after APPROVAL_TIMEOUT_MS. An event's run waits the same way before each row it
 * adds, trusted or not: trust lets it read. An agent an owner gave web access reads public pages
 * (and searches, where the server has a search service; web.ts) as it reads from a connection:
 * within the same limit, and waiting for an owner before each call where every connection tool does,
 * and on a run a person asked for in words (a chat, a mention, a request) before each call whose
 * address or search words aren't in their message: what it read could otherwise leave in one.
 *
 * A person's message in a chat with the agent (lib/agent-chat.ts) is a run too, held to that
 * person's access: the run of someone who can edit the agent (an owner, or someone it is shared
 * with at full access or can edit, see sharing.ts) may also change pages at once (WRITE_TOOLS,
 * within MAX_AGENT_WRITES) and calls connections' tools as a request does; anyone else's only
 * reads, with no tool that changes something offered at all. Its answer goes to the conversation when it ends
 * (chat-store.ts).
 *
 * The notes its owners kept from earlier runs go with each run (memory.ts). A run whose input a
 * member or a trusted trigger stands behind may propose new ones (`remember`), which wait for an
 * owner, and drop old ones (`forget`); others may neither. With the workspace's AI memory off, no
 * run carries notes or may keep any.
 *
 * What a run keeps to show (its steps, answer and error, and the call waiting for approval) has
 * credentials masked (lib/redact). `state` is kept as it was: the run goes on from it and sends the
 * waiting call as the agent made it; only owners approving that call see it from there (the
 * agent's runs in the app), and it is cleared once the run ends.
 */
import { and, eq, inArray, isNotNull, isNull, lte, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, connection, connectionEvent, connectionTrigger, notification, page, user, workspaceAgent, type AgentRunState } from "@/db/schema";
import {
  accessSource,
  AGENT_RUN_HISTORY_DAYS,
  isEventRun,
  isMentionRun,
  isRowRun,
  isScheduleRun,
  MAX_AGENT_PROMPT,
  MAX_AGENT_WRITES,
  MAX_SCHEDULED_WRITES,
  MENTION_THREAD_CHARS,
  MENTION_THREAD_COMMENTS,
  skillStepsToAdd,
  type AgentPendingCall,
  type AgentRunCode,
  type AgentRunContext,
  type AgentRunSource,
  type AgentRunUsage,
  type AgentStepRecord,
  WEB_TOOL_NAMES,
} from "@/lib/agents";
import { hasAgentLevel } from "@/lib/agent-sharing";
import { APPROVAL_TIMEOUT_MS, CONNECTION_EVENT_DAYS, MAX_RUN_EXTERNAL_CHARS } from "@/lib/connections";
import { pageLabel } from "@/lib/labels";
import { redactError, redactText, redactValue } from "@/lib/redact";
import { threadBefore } from "@/lib/comments";
import { agentWebCallAsks, scheduledWebCallGoes } from "@/lib/web-calls";
import { AccessError, findMembership, hasLevel, inWorkspace, pageAccessOf } from "@/server/access";
import { runActingFor } from "@/server/acting-for";
import { aiConfig, AiError, complete, isAiError, promptRoomFor, RUN_ROUNDS, takeWorkspaceCapacity, type AiMessage, type AiResult, type AiTool, type AiToolCall } from "@/server/ai";
import { agentChatPrompt, agentEventPrompt, agentMentionPrompt, agentRequestPrompt, agentSchedulePrompt, agentSystemPrompt, agentTaskPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { memoryAvailable, memoryForPrompt } from "@/server/ai-memory";
import { applyWrite, CHAT_TOOLS, prepareWrite, runTool, workspaceMap, WRITE_TOOL_NAMES, WRITE_TOOLS, type PreparedWrite, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { proposeChange } from "@/server/pending-changes";
import { databaseOfRow, DRAFT_EMAIL, draftEmailTool, draftRowEmail, draftSender } from "./email-drafts";
import { asAutomation } from "@/server/automations/queue";
import { threadsVisibleTo } from "@/server/property-comments";
import { changeComments } from "@/server/comments";
import { notifyApprovers, withdrawApproval } from "@/server/connections/approvals";
import { agentToolset, inputSummary, runConnectionTool, type ConnectionToolset } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import * as ops from "@/server/operations";
import { ToolInputError } from "@/server/mcp/format";
import { COMBINE, MAX_MERGE_ROWS } from "@/lib/merge-rows";
import { PropertyValueError } from "@/lib/properties";
import type { ChatWriteRecord } from "@/db/schema/ai";
import { runClock } from "./clock";
import { ASK_AGENT, handoffEventText, handoffFor, handoffHold } from "./handoff";
import { chatRunHistory, closeChatTurn } from "./chat-store";
import { approversOf } from "./approvers";
import { agentsWorker } from "./kick";
import { AGENT_MEMORY_TOOL_NAMES, AGENT_MEMORY_TOOLS, runAgentMemoryTool } from "./memory";
import { agentSkillRoom, runSkills } from "./skills";
import { runWebTool, webToolsFor } from "./web";
import { agentLevel } from "./sharing";
import { addAgentUsage, overMonthlyLimit, pruneAgentUsage } from "./usage";
import { pruneAiUsage } from "@/server/ai/usage-store";
import { dropOldToolResults } from "@/server/ai/compact";

const SWEEP_INTERVAL_MS = 5_000;
/** A run taken (or last gone on with, see converse) this long ago and not finished belongs to a worker that stopped: it's taken again. */
const STALE_MS = 10 * 60_000;
/** A run taken this many times (waiting for the AI allowance, or stopping the worker) fails. */
const MAX_CLAIMS = 40;
/** The most of the prompt the map of the workspace may take. */
const MAP_CHARS = 6_000;
/** The most of a comment an agent writes. */
const MAX_COMMENT = 4_000;
/** The most of what the model says before a tool call that is kept as a step. */
const THOUGHT_CHARS = 300;
/** The most of an event's body the agent reads. */
const EVENT_CHARS = 8_000;
/** The most of the prompt the agent's memory may take. */
const MEMORY_CHARS = 6_000;
/** The most of the database a schedule's run reads before its first turn. */
const DATABASE_CHARS = 16_000;
/** The share of the prompt a chat's earlier messages may take. */
const CHAT_HISTORY_SHARE = 0.25;

type Run = typeof agentRun.$inferSelect;
type Agent = typeof workspaceAgent.$inferSelect;

const ADD_COMMENT: AiTool = {
  name: "add_comment",
  description: "Writes a comment on the row that started this run, as you. Use it to explain a change, answer a question in the row, or ask a person for what is missing.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The comment, in plain text." } },
    required: ["text"],
    additionalProperties: false,
  },
};

const ADD_ROW_COMMENT: AiTool = {
  name: "add_comment",
  description: "Writes a comment on a row of the database this run looks after, as you. Use it to explain a change, or to ask a person for what is missing.",
  parameters: {
    type: "object",
    properties: {
      row_id: { type: "string", description: "The row's page_id (from a source)." },
      text: { type: "string", description: "The comment, in plain text." },
    },
    required: ["row_id", "text"],
    additionalProperties: false,
  },
};

const MERGE_ROWS: AiTool = {
  name: "merge_rows",
  description: `Merges duplicate rows of the database this run looks after into one kept row, as you. The kept row takes, for each property, the value of the row named for it (or "${COMBINE}": every row's values of a multi-value property); properties left out keep the kept row's value, or the first row's that has one. Links, comments, activity, files, email and page text of the other rows move to the kept row, and they go to the trash. Merge only rows that are clearly the same record. Counts as one change.`,
  parameters: {
    type: "object",
    properties: {
      kept_row_id: { type: "string", description: "The page_id of the row that stays (from a source)." },
      other_row_ids: {
        type: "array",
        items: { type: "string" },
        description: `The page_ids of the rows merged into it (1-${MAX_MERGE_ROWS - 1}).`,
      },
      properties: {
        type: "object",
        description: `For each property to take from another row, by name: the page_id of that row, or "${COMBINE}".`,
        additionalProperties: { type: "string" },
      },
      title: { type: "string", description: "The page_id of the row whose title the kept row takes, if not its own." },
    },
    required: ["kept_row_id", "other_row_ids"],
    additionalProperties: false,
  },
};

const UPDATE_ROW = WRITE_TOOLS.find((t) => t.name === "update_row")!;
const CREATE_ROW = WRITE_TOOLS.find((t) => t.name === "create_row")!;

/**
 * create_row and update_row of an agent whose changes wait for review: the same, proposing the
 * change instead of making it, with why (for the person reviewing it).
 */
function proposing(tool: AiTool): AiTool {
  const parameters = tool.parameters as { properties: Record<string, unknown>; required: string[] };
  return {
    ...tool,
    description: `${tool.description.replace(/\. Returns it as a numbered source\.$/, ".").replace(/^Adds/, "Proposes adding").replace(/^Changes/, "Proposes changing")} The change waits for a person to approve it; nothing is saved until then.`,
    parameters: {
      ...parameters,
      properties: { ...parameters.properties, reason: { type: "string", description: "Why you propose it, in a sentence, for the person reviewing it." } },
      required: [...parameters.required, "reason"],
    },
  };
}
const PROPOSE_TOOLS = new Map([UPDATE_ROW, CREATE_ROW].map((t) => [t.name, proposing(t)]));
/** The run's tools, with create_row and update_row proposing when the agent's changes wait for review. */
const forReview = (tools: AiTool[], reviews: boolean) => (reviews ? tools.map((t) => PROPOSE_TOOLS.get(t.name) ?? t) : tools);
const EDIT_PAGE = WRITE_TOOLS.find((t) => t.name === "edit_page")!;
/** Leafdesk's tools on a row's run: update_row and edit_page on that row. Any run may also keep notes (memory.ts). */
export const AGENT_TOOLS: AiTool[] = [...CHAT_TOOLS, UPDATE_ROW, EDIT_PAGE, ADD_COMMENT];
/** Leafdesk's tools on a schedule's run on a database: update_row, edit_page and add_comment on any of its rows. */
export const SCHEDULED_DATABASE_TOOLS: AiTool[] = [...CHAT_TOOLS, UPDATE_ROW, EDIT_PAGE, ADD_ROW_COMMENT];

/** The database a schedule's run looks after, if any. */
const scheduledDatabase = (source: AgentRunSource) => (isScheduleRun(source) ? (source.databaseId ?? null) : null);

/** Leafdesk's tools on a connection event's run: reading, and adding rows where the agent may edit. */
export const EVENT_TOOLS: AiTool[] = [...CHAT_TOOLS, CREATE_ROW];
/** Leafdesk's own tools that wait for an owner on an event's run, as a connection's writing tools do. */
const EVENT_APPROVED_TOOLS: ReadonlySet<string> = new Set([CREATE_ROW.name]);

// ------------------------------------------------------------------------------------ queue

const state = agentsWorker;

/**
 * What makes two queued runs the same run: the automation's run, the event and trigger, the
 * schedule and the time it was due, or the comment that mentioned the agent. Each run an owner
 * asks for is its own.
 */
function sameSource(source: AgentRunSource, context: AgentRunContext) {
  // A "for each" step runs the agent once per found row of the automation's run.
  if (source.kind === "automation") return sql`${agentRun.source}->>'automationRunId' = ${source.automationRunId} and ${agentRun.source}->>'rowId' = ${source.rowId}`;
  if (source.kind === "connection") return sql`${agentRun.source}->>'eventId' = ${source.eventId} and ${agentRun.source}->>'triggerId' = ${source.triggerId}`;
  if (source.kind === "mention") return sql`${agentRun.source}->>'commentId' = ${source.commentId}`;
  if (source.kind === "schedule" && "scheduledFor" in context && context.scheduledFor) {
    return sql`${agentRun.source}->>'scheduleId' = ${source.scheduleId} and ${agentRun.context}->>'scheduledFor' = ${context.scheduledFor}`;
  }
  return sql`false`;
}

/**
 * Queues a run of an agent; the worker takes it at once (or at its next sweep). A step taken again
 * (its worker stopped before saving that it queued the run) finds the run it queued rather than
 * queuing another.
 */
export async function queueAgentRun(input: {
  agentId: string;
  workspaceId: string;
  source: AgentRunSource;
  context: AgentRunContext;
  prompt: string;
}): Promise<string> {
  const prompt = input.prompt.slice(0, MAX_AGENT_PROMPT);
  const [queued] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(and(eq(agentRun.agentId, input.agentId), sameSource(input.source, input.context), eq(agentRun.prompt, prompt)))
    .limit(1);
  if (queued) return queued.id;
  const [run] = await db
    .insert(agentRun)
    .values({ ...input, prompt })
    .returning({ id: agentRun.id });
  state.kick?.();
  return run.id;
}

/** Takes due runs, marking them running, so two sweeps never take the same one. */
async function claim(limit: number): Promise<Run[]> {
  if (limit <= 0) return [];
  const taken = await db.execute<{ id: string }>(sql`
    update ${agentRun} set status = 'running', attempts = attempts + 1, next_at = now(), started_at = coalesce(started_at, now())
    where id in (
      select id from ${agentRun}
      where (status = 'pending' and next_at <= now())
         or (status = 'running' and next_at <= now() - make_interval(secs => ${STALE_MS / 1000}))
      order by next_at
      limit ${limit}
      for update skip locked
    )
    returning id
  `);
  const ids = [...taken].map((r) => r.id);
  if (!ids.length) return [];
  return db.select().from(agentRun).where(inArray(agentRun.id, ids)).orderBy(agentRun.createdAt);
}

type Ending = { status: "done" | "failed"; code?: AgentRunCode | null; error?: string | null; steps?: AgentStepRecord[]; answer?: string; usage?: AgentRunUsage | null };

async function finish(run: Run, values: Ending) {
  await db
    .update(agentRun)
    .set({
      status: values.status,
      code: values.code ?? null,
      error: values.error ? redactText(values.error).slice(0, 500) : null,
      ...(values.steps ? { steps: redactValue(values.steps) } : {}),
      ...(values.answer !== undefined ? { answer: redactText(values.answer).slice(0, 8_000) } : {}),
      ...(values.usage !== undefined ? { usage: values.usage } : {}),
      state: null,
      pending: null,
      finishedAt: new Date(),
    })
    .where(eq(agentRun.id, run.id));
  await reportScheduledRun(run);
  await replyToMention(run, values);
  await closeChatTurn(run, values);
}

/**
 * Tells the owner who set a schedule that its run ended (done or failed): the report is the run
 * itself, which their inbox shows. Never throws; the run's ending is saved either way.
 */
async function reportScheduledRun(run: Pick<Run, "id" | "workspaceId" | "agentId" | "source">) {
  if (!isScheduleRun(run.source)) return;
  try {
    // From the agent's user, looked up in the same statement.
    const actorId = sql<string>`(select ${workspaceAgent.userId} from ${workspaceAgent} where ${workspaceAgent.id} = ${run.agentId})`;
    const inserted = await db
      .insert(notification)
      .values({ userId: run.source.scheduledBy, workspaceId: run.workspaceId, kind: "agent_report", actorId, agentRunId: run.id })
      .returning({ id: notification.id });
    signalInbox(run.workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("[agents] could not report a scheduled run", redactError(error));
  }
}

/** What an agent mentioned in a comment says in the thread when its run ends without an answer, by the run's code (lib/agents). */
const MENTION_REPLIES = ["aiOff", "agentDisabled", "limitReached", "costLimit", "timeout", "approvalTimeout"] as const;

/**
 * Answers the comment that started a mention's run, in its thread, as the agent: its final message,
 * or a short word on why it has none (in the mentioner's language). Posted as the agent's own
 * comment, which starts no run (server/agents/mentions). Never throws: the run's ending is saved
 * either way, and the agent may no longer comment there.
 */
async function replyToMention(run: Pick<Run, "agentId" | "source" | "context">, ending: Pick<Ending, "status" | "code" | "answer">) {
  if (!isMentionRun(run.source)) return;
  const { pageId, threadId, mentionedBy } = run.source;
  try {
    const [agent] = await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.id, run.agentId));
    if (!agent) return;
    let text = ending.status === "done" ? redactText(ending.answer ?? "").trim().slice(0, MAX_COMMENT) : "";
    if (!text) {
      const locale = await recipientLocale(mentionedBy, "locale" in run.context ? run.context.locale : null);
      const t = emailTranslator(locale);
      const code = ending.code ?? null;
      const key = ending.status === "done" ? "empty" : MENTION_REPLIES.find((c) => c === code) ?? "failed";
      text = t(`agentReply.${key}`);
    }
    await asAutomation(() => changeComments(agent.userId, pageId, { type: "addComment", threadId, body: text }));
  } catch (error) {
    console.error("[agents] could not answer a mention", redactError(error));
  }
}

/** Puts a run back to wait (for the workspace's AI allowance) until `at`. */
async function later(run: Run, at: Date) {
  await db.update(agentRun).set({ status: "pending", nextAt: at }).where(eq(agentRun.id, run.id));
}

/**
 * Parks a run until an owner answers the call it waits on (or the call runs out of time). `pending`
 * keeps the call's input with credentials masked, for lists and the audit log; what is sent once
 * approved is the call as the agent made it, from `state`, which is what owners approve.
 */
async function park(run: Run, agent: Agent, values: { state: AgentRunState; pending: AgentPendingCall; steps: AgentStepRecord[]; usage: AgentRunUsage }) {
  await db
    .update(agentRun)
    .set({
      status: "awaiting_approval",
      state: values.state,
      pending: { ...values.pending, arguments: redactValue(values.pending.arguments) },
      steps: redactValue(values.steps),
      usage: values.usage,
      // Taking it again for an answer is no failed attempt.
      attempts: 0,
      nextAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS),
    })
    .where(eq(agentRun.id, run.id));
  await notifyApprovers(run, agent.userId);
}

// -------------------------------------------------------------------------------------- run

/** Does one run (or goes on with one an owner answered) and saves how it went. */
export async function processRun(run: Run): Promise<void> {
  const [agent] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, run.agentId));
  if (!agent || agent.archivedAt || !agent.enabled) return finish(run, { status: "failed", code: "agentDisabled" });
  if (run.attempts > MAX_CLAIMS) return finish(run, { status: "failed", code: "tooManyAttempts" });
  if (!(await aiAvailable(run.workspaceId))) return finish(run, { status: "failed", code: "aiOff" });
  // A run going on after an owner's answer sends what they approved first; converse checks the
  // limit before its next turn.
  if (!run.state && (await overMonthlyLimit(agent))) return finish(run, { status: "failed", code: "limitReached" });

  // The member whose change started a row's run: the agent works within their access as well. Asked
  // again each time the run is taken (after an approval too): their access as it is now counts, and
  // once they have left the workspace the run goes on as one no member started.
  let member: string | null = null;
  // Whose access holds the agent besides its own: the member, or a public form's publisher.
  let bound: string | null = null;
  // An event's run: whether an owner trusts what its trigger's service sends, asked again each time
  // too (turning it off holds back the calls of runs already under way). A trigger since removed
  // isn't trusted.
  let trusted = false;
  // A run someone asked for (or set a schedule for) is held to their access, and stands behind what
  // it reads as they do; only those who can edit the agent (sharing.ts) ask for runs and set
  // schedules, so one whose asker can no longer edit it opens nothing.
  if (run.source.kind === "request" || run.source.kind === "schedule") {
    const askerId = run.source.kind === "request" ? run.source.requestedBy : run.source.scheduledBy;
    const asker = await findMembership(askerId, run.workspaceId);
    if (!asker || !hasAgentLevel(await agentLevel(askerId, agent, asker.role), "edit")) return finish(run, { status: "failed", code: "noAccess" });
    member = bound = askerId;
    trusted = true;
  } else if (isMentionRun(run.source)) {
    // A member mentioned the agent: it works within their access, and they stand behind the task.
    // Asked again each time, so one who left the workspace or became a guest since opens nothing.
    const { mentionedBy, pageId } = run.source;
    const mentioner = await findMembership(mentionedBy, run.workspaceId);
    if (!mentioner || (await agentLevel(mentionedBy, agent, mentioner.role)) === "none") return finish(run, { status: "failed", code: "noAccess" });
    member = bound = mentionedBy;
    trusted = true;
    const [target] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, pageId));
    if (!target || target.archivedAt) return finish(run, { status: "failed", code: "commentGone" });
    // It answers with a comment: it must still be allowed to write one.
    const { level } = await withinMember(agent, bound, () => pageAccessOf(agent.userId, pageId));
    if (!hasLevel(level, "comment")) return finish(run, { status: "failed", code: "noAccess" });
  }
  // Another agent asked for the run (handoff.ts): held as its run was.
  if (run.source.kind === "handoff") {
    const held = await handoffHold(run.source, run.workspaceId);
    if (!held) return finish(run, { status: "failed", code: "noAccess" });
    member = bound = held.bound;
    trusted = held.trusted;
  }
  // A chat's run is held to the person who wrote, while the agent is still shared with them; only
  // the run of someone who can edit the agent may change things.
  let chatWrites = false;
  if (run.source.kind === "chat") {
    const writer = await findMembership(run.source.userId, run.workspaceId);
    const level = writer ? await agentLevel(run.source.userId, agent, writer.role) : "none";
    if (level === "none") return finish(run, { status: "failed", code: "noAccess" });
    member = bound = run.source.userId;
    trusted = true;
    chatWrites = hasAgentLevel(level, "edit");
  }
  const databaseId = scheduledDatabase(run.source);
  if (databaseId) {
    const [database] = await db.select({ kind: page.kind, archivedAt: page.archivedAt }).from(page).where(eq(page.id, databaseId));
    if (!database || database.archivedAt || database.kind !== "database") return finish(run, { status: "failed", code: "databaseGone" });
    const { level } = await withinMember(agent, bound, () => pageAccessOf(agent.userId, databaseId));
    if (level === "none") return finish(run, { status: "failed", code: "noAccess" });
    // The run reads every row unattended: the owner stands behind rows people of the workspace
    // wrote, not an anonymous form answer or a row someone since gone last changed.
    trusted = await rowsStoodBehind(databaseId, run.workspaceId);
  }
  if (isRowRun(run.source)) {
    const { rowId, databaseId } = run.source;
    const [row] = await db.select({ id: page.id, parentId: page.parentId, archivedAt: page.archivedAt }).from(page).where(eq(page.id, rowId));
    if (!row || row.archivedAt || row.parentId !== databaseId) return finish(run, { status: "failed", code: "rowGone" });
    if (run.source.kind === "automation") member = await memberBehind(run);
    if (!member) {
      // An answer to a public form from someone the workspace doesn't know: held to the form's
      // publisher, who must still be in the workspace (or the run opens nothing).
      const publisher = "boundTo" in run.context ? (run.context.boundTo ?? null) : null;
      if (publisher) {
        if (!(await findMembership(publisher, run.workspaceId))) return finish(run, { status: "failed", code: "noAccess" });
        bound = publisher;
      }
    } else bound = member;
    const { level } = await withinMember(agent, bound, () => pageAccessOf(agent.userId, rowId));
    if (level === "none") return finish(run, { status: "failed", code: "noAccess" });
  } else if (isEventRun(run.source)) {
    const [conn] = await db.select({ id: connection.id }).from(connection).where(eq(connection.id, run.source.connectionId));
    if (!conn) return finish(run, { status: "failed", code: "connectionGone" });
    const [trigger] = await db
      .select({ trusted: connectionTrigger.trusted })
      .from(connectionTrigger)
      .where(and(eq(connectionTrigger.id, run.source.triggerId), eq(connectionTrigger.connectionId, conn.id)));
    trusted = trigger?.trusted === true;
  }

  const wait = takeWorkspaceCapacity(run.workspaceId);
  if (wait > 0) return later(run, new Date(Date.now() + wait));

  const outcome = await withinMember(agent, bound, () => converse(agent, run, { member, bound, trusted, chatWrites })).catch((error: unknown) => ({ error }));
  if ("error" in outcome) {
    const error = outcome.error;
    if (isAiError(error) && error.code === "rateLimited") return later(run, new Date(Date.now() + (error.retryAfterMs ?? 30_000)));
    const code: AgentRunCode = !isAiError(error)
      ? "error"
      : error.code === "limitReached"
        ? "costLimit"
        : error.code === "aborted" || error.code === "timeout"
          ? "timeout"
          : "provider";
    if (!isAiError(error)) console.error("[agents] run failed", redactError(error));
    return finish(run, { status: "failed", code, error: error instanceof Error ? error.message : String(error) });
  }
  if (outcome.status === "awaiting") return park(run, agent, outcome);
  return finish(run, outcome);
}

/**
 * Who started a row's run, if it is someone in the workspace (a guest too): null for an anonymous
 * form answer, a signed-in visitor's answer to a public form (both held to the form's publisher
 * instead, see processRun), or an account since removed.
 */
async function memberBehind(run: Run): Promise<string | null> {
  const actorId = "actorId" in run.context ? run.context.actorId : null;
  if (!actorId) return null;
  return (await findMembership(actorId, run.workspaceId)) ? actorId : null;
}

/**
 * Whether people of the workspace (agents included, whose changes are held to someone's access)
 * created and last changed every live row of the database. A row from someone the workspace doesn't
 * know may carry anyone's instructions, so a schedule's run over such a database asks before each
 * connection tool and proposes no notes, as a row's run no member started does.
 */
async function rowsStoodBehind(databaseId: string, workspaceId: string) {
  const [stranger] = await db
    .select({ id: page.id })
    .from(page)
    .where(
      and(
        eq(page.parentId, databaseId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        or(isNull(page.createdBy), not(inWorkspace(page.createdBy, workspaceId)), and(isNotNull(page.updatedBy), not(inWorkspace(page.updatedBy, workspaceId)))),
      ),
    )
    .limit(1);
  return !stranger;
}

/** Runs `fn` with the agent held to this member's access as well (no one: the agent's own). */
function withinMember<T>(agent: Agent, member: string | null, fn: () => Promise<T>): Promise<T> {
  return member ? runActingFor({ userId: agent.userId, forUserId: member }, fn) : fn();
}

type Paused = { status: "awaiting"; state: AgentRunState; pending: AgentPendingCall; steps: AgentStepRecord[]; usage: AgentRunUsage };
type CallResult = { content: string; isError?: boolean; step?: AgentStepRecord };

/** The run's turns with the model (from the start, or from where it waited): what it did, and how it ended. */
async function converse(
  agent: Agent,
  run: Run,
  { member, bound, trusted, chatWrites }: { member: string | null; bound: string | null; trusted: boolean; chatWrites: boolean },
): Promise<Ending | Paused> {
  const ctx: ops.OperationContext = { userId: agent.userId, actor: { userId: agent.userId, model: true } };
  const rowRun = isRowRun(run.source);
  const scheduled = isScheduleRun(run.source);
  const databaseId = scheduledDatabase(run.source);
  // Changes it may make in all.
  const maxWrites = databaseId ? MAX_SCHEDULED_WRITES : MAX_AGENT_WRITES;
  const eventRun = isEventRun(run.source);
  const mention = isMentionRun(run.source) ? run.source : null;
  // A mention's run may change the page its comment is on where the agent (and the member) may
  // edit it, and its values when it is a database row.
  const mentionEdits = mention ? await mentionEditing(agent, mention.pageId) : null;
  // A row no member wrote, or an event from a service no owner vouched for, may carry anyone's
  // instructions: no connection tool runs without an owner.
  const askEveryTool = rowRun ? !member : !trusted;
  // An agent with web access reads pages (and searches) as it reads from a connection: on such a
  // run each call waits for an owner too, or the run could be steered to send what it read to any
  // address.
  const webTools = webToolsFor(agent);
  const webNames = new Set(webTools.map((t) => t.name));
  // A run a person asked for in words (a chat message, a mention, a request, or a helper's run for
  // one) reads what they may open, some of it written by others, who could steer it into sending
  // that out: a web call carrying an address or search words the person didn't write (or any, on a
  // helper's run, whose task an agent wrote) waits for an owner too (lib/web-calls.ts).
  const askedFor = accessSource(run.source);
  const askedInWords = askedFor.kind === "chat" || askedFor.kind === "request" || isMentionRun(askedFor);
  const webAsks = { askEveryTool, typed: askedInWords ? (run.source.kind === "handoff" ? [] : [run.prompt]) : null };
  // A schedule's run (or a helper's run for one) has no one watching and is due again later: it
  // searches, and reads the pages of its task or of its own searches' results, and any other read
  // is refused at once (lib/web-calls.ts). Over rows no member stands behind each call still waits.
  const unattended = isScheduleRun(askedFor) && !askEveryTool;
  const webTask = run.source.kind === "handoff" ? [] : [run.prompt];
  const chat = run.source.kind === "chat";
  // Its owners chose that its changes to rows wait for review: create_row and update_row propose
  // them (pending-changes.ts). A chat's changes are still made at once: the person is there, and asked.
  const proposes = agent.rowChanges === "review" && !chat;
  // Leafdesk's own tools this run makes only once an owner approves (none on a row's run). A row an
  // event's run proposes waits for review instead: nothing to approve before then.
  const ownApproved: ReadonlySet<string> = new Set([...(eventRun && !proposes ? EVENT_APPROVED_TOOLS : []), ...(askEveryTool || askedInWords ? webNames : [])]);
  // What the run may still wait for the agents it asks.
  const clock = runClock();
  // A read-only chat isn't offered connections' tools that change something. Nor is a run held to
  // someone no owner answers for (one someone who isn't an owner asked for, set or chats in,
  // approvers.ts): each such call waits for an owner, and would only run out of time.
  const heldTo = accessSource(run.source);
  const heldToPerson = heldTo.kind === "chat" || heldTo.kind === "request" || (isScheduleRun(heldTo) && !heldTo.databaseId);
  const unanswered = heldToPerson && (await approversOf(run)).length === 0;
  const toolset = await agentToolset(agent.id, { writes: (!chat || chatWrites) && !unanswered });
  const connections = [...new Set([...toolset.byName.values()].map((e) => e.connection.name))];
  // What a run reads that no one in the workspace stands behind could fill the owners' review with
  // its own notes: such a run proposes none.
  const memoryOn = await memoryAvailable(run.workspaceId);
  // A mention's run answers one person in a thread, another agent wrote a helper's task, and
  // someone who isn't an owner shouldn't fill the owners' review from a read-only chat: these read
  // the notes owners kept, but propose none.
  const handedOff = run.source.kind === "handoff";
  const remembers = memoryOn && !askEveryTool && !mention && !handedOff && (!chat || chatWrites);
  const mentionTools = mentionEdits?.edits ? [EDIT_PAGE, ...(mentionEdits.row ? [UPDATE_ROW] : [])] : [];
  // Other agents it may ask; none on a helper's run.
  const handoff = await handoffFor(agent, run, { bound, trusted: !askEveryTool, clock, runHelper: runInSlot });
  const ownTools = rowRun ? AGENT_TOOLS : databaseId ? SCHEDULED_DATABASE_TOOLS : eventRun ? EVENT_TOOLS : chatWrites ? [...CHAT_TOOLS, ...WRITE_TOOLS] : [...CHAT_TOOLS, ...mentionTools];
  const reviews = proposes && ownTools.some((t) => PROPOSE_TOOLS.has(t.name));
  // A run on a row, or a schedule's on a database, that works for someone with a mailbox where mail
  // is matched to the rows drafts email from it; each draft waits for them (email-drafts.ts).
  const draftDatabase = databaseId ?? (isRowRun(run.source) ? await databaseOfRow(run.source.rowId) : null);
  const sender = await draftSender(member, run.workspaceId, draftDatabase);
  // A schedule's run on a database merges duplicates there only where the agent may edit it, and
  // not when its changes wait for review: a merge can't be proposed.
  const merges = !rowRun && !proposes && databaseId !== null && hasLevel((await pageAccessOf(agent.userId, databaseId)).level, "edit");
  const tools = [
    ...forReview(ownTools, proposes),
    ...(merges ? [MERGE_ROWS] : []),
    ...(sender ? [draftEmailTool(sender, { anyRow: Boolean(databaseId) })] : []),
    ...(remembers ? AGENT_MEMORY_TOOLS : []),
    ...webTools,
    ...(handoff ? [handoff.tool] : []),
    ...toolset.tools,
  ];
  // Checked when the run starts and again when it goes on after waiting for approval, so a skill
  // someone else may edit by then is left out (see steps below).
  const skillSet = await runSkills(agent, agentSkillRoom(), bound);
  const requested = run.source.kind === "request" || handedOff;
  const system = agentSystemPrompt(agent, {
    row: rowRun,
    requested,
    askedByAgent: handedOff,
    scheduled: scheduled ? { database: Boolean(databaseId), maxWrites } : undefined,
    chat: chat ? { writes: chatWrites } : undefined,
    addsRows: eventRun,
    mentioned: mentionEdits ?? undefined,
    connections,
    askEveryTool,
    web: webTools.length
      ? {
          search: webNames.has(WEB_TOOL_NAMES.search),
          asks: unattended ? undefined : webAsks.typed ? (webAsks.typed.length ? "untyped" : "each") : undefined,
          reads: unattended ? "taskOrFound" : undefined,
        }
      : undefined,
    skills: skillSet.skills,
    remembers,
    reviews,
    drafts: Boolean(sender),
  });
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  // The model its owners chose: every turn of every run of the agent's goes to it (features.ts).
  const feature = agent.model === "fast" ? "agent.fast" : "agent";
  const budget = await promptRoomFor(run.workspaceId, feature);
  const room = (messages: AiMessage[]) => budget - system.length - toolsSize - messages.reduce((n, m) => n + m.content.length, 0) - 300;

  const registry: Registry = { sources: [], byKey: new Map() };
  const steps: AgentStepRecord[] = [...run.steps];
  steps.push(...skillStepsToAdd(steps, skillSet.steps));
  const usage: AgentRunUsage = run.usage ? { ...run.usage } : { inputTokens: 0, outputTokens: 0, costUsd: 0, rounds: 0 };
  let messages: AiMessage[];
  let writes = 0;
  let externalChars = 0;
  // The addresses this run's searches returned: a schedule's run may read them.
  let webFound: string[] = [];
  let firstRound = 0;
  let queue: AiToolCall[] = [];

  const saved = run.state;
  if (saved) {
    messages = saved.messages as AiMessage[];
    writes = saved.writes;
    externalChars = saved.externalChars;
    webFound = saved.webFound ?? [];
    firstRound = saved.rounds;
    queue = saved.queue;
  } else if (isRowRun(run.source)) {
    // The row, read as the agent (its values as both it and the member may see them), as source 1.
    const read = await runTool(ctx, run.workspaceId, undefined, { name: "read_page", arguments: { page_id: run.source.rowId } }, registry, Math.min(8_000, room([])));
    if (read.isError) return { status: "failed", code: "noAccess", steps, usage };
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    messages = [{ role: "user", content: agentTaskPrompt({ task: run.prompt, event: await eventText(run), row: read.content, map, memory: memory.text }) }];
  } else if (scheduled) {
    // The database it looks after, read as the agent (within the owner's access), as source 1.
    const read = databaseId
      ? await runTool(ctx, run.workspaceId, undefined, { name: "read_page", arguments: { page_id: databaseId } }, registry, Math.min(DATABASE_CHARS, room([])))
      : null;
    if (read?.isError) return { status: "failed", code: "noAccess", steps, usage };
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    messages = [{ role: "user", content: agentSchedulePrompt({ task: run.prompt, event: await eventText(run), database: read?.content ?? null, map, memory: memory.text }) }];
  } else if (mention) {
    // The comment and the thread before it, as they are now: a run on a comment since deleted ends here.
    const thread = (await threadsVisibleTo(agent.userId, mention.pageId)).find((t) => t.id === mention.threadId);
    const comment = thread?.comments.find((c) => c.id === mention.commentId);
    if (!thread || !comment || comment.deletedAt) return { status: "failed", code: "commentGone", steps, usage };
    // The page, read as the agent (within the member's access), as source 1.
    const read = await runTool(ctx, run.workspaceId, undefined, { name: "read_page", arguments: { page_id: mention.pageId } }, registry, Math.min(8_000, room([])));
    if (read.isError) return { status: "failed", code: "noAccess", steps, usage };
    const names = await threadNames(thread.comments.map((c) => c.userId));
    const before = threadBefore(thread, comment.id, (id) => names.get(id) ?? "Someone", { max: MENTION_THREAD_COMMENTS, chars: MENTION_THREAD_CHARS });
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    messages = [
      { role: "user", content: agentMentionPrompt({ comment: run.prompt, event: await eventText(run), page: read.content, thread: before, map, memory: memory.text }) },
    ];
  } else if (chat) {
    // The conversation so far, then the message, with the workspace as the agent sees it (with the person).
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    const history = await chatRunHistory(run, Math.floor(room([]) * CHAT_HISTORY_SHARE));
    messages = [...history, { role: "user", content: agentChatPrompt({ message: run.prompt, event: await eventText(run), map, memory: memory.text }) }];
  } else if (requested) {
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    messages = [{ role: "user", content: agentRequestPrompt({ task: run.prompt, event: await eventText(run), map, memory: memory.text }) }];
  } else {
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const memory = memoryOn ? await memoryForPrompt(agent.userId, run.workspaceId, Math.min(MEMORY_CHARS, Math.floor(room([]) * 0.2))) : { text: "" };
    const type = "eventType" in run.context ? run.context.eventType : "event";
    const body = `Type: ${type}\n\n${"body" in run.context ? run.context.body.slice(0, EVENT_CHARS) : ""}`;
    messages = [{ role: "user", content: agentEventPrompt({ task: run.prompt, event: await eventText(run), body, map, memory: memory.text }) }];
  }

  /**
   * Keeps a checked create_row or update_row for review rather than making it (pending-changes.ts):
   * the person the run works for hears about it, else whoever made the agent, else the owners.
   */
  const propose = async (prepared: PreparedWrite, call: { arguments: Record<string, unknown> }): Promise<CallResult> => {
    const row = prepared.row;
    if (!row) return { content: "This change can't be proposed.", isError: true };
    const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.trim() : "";
    if (!reason) return { content: "Give a reason: why you propose this change, for the person reviewing it. Nothing was proposed.", isError: true };
    const { replaced } = await proposeChange({
      workspaceId: run.workspaceId,
      kind: row.kind,
      databaseId: row.databaseId,
      rowId: row.rowId,
      payload: row.payload,
      before: row.before,
      reason,
      source: { kind: "agent_run", runId: run.id, automationRunId: run.source.kind === "automation" ? run.source.automationRunId : null },
      agent: { id: agent.id, userId: agent.userId },
      runId: run.id,
      for: [member, agent.createdBy],
    });
    return {
      content: `${replaced ? "Proposed again, in place of your earlier proposal for this row" : "Proposed"}: it waits for a person to approve it under For review and isn't made yet. Don't propose it again.`,
      step: { ...prepared.record, outcome: "proposed", pageId: row.rowId },
    };
  };

  /** Answers one tool call; null when it must wait for approval. */
  const answer = async (call: AiToolCall, approved: { userId: string } | null): Promise<CallResult | null> => {
    const external = toolset.byName.get(call.name);
    if (external) {
      if (external.tool.kind === "write" && writes >= maxWrites) {
        return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      }
      if ((external.tool.kind === "write" || askEveryTool) && !approved) return null;
      const left = MAX_RUN_EXTERNAL_CHARS - externalChars;
      if (left <= 200) return { content: "You have read as much from connected services as one run may. Finish with what you have.", isError: true };
      const out = await runConnectionTool({ entry: external, args: call.arguments, actorId: agent.userId, approvedBy: approved?.userId ?? null, room: left });
      externalChars += out.chars;
      if (external.tool.kind === "write") writes += 1;
      return out;
    }
    // Notes change nothing in the workspace: they don't count as changes.
    if (AGENT_MEMORY_TOOL_NAMES.has(call.name)) {
      if (!remembers) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      return runAgentMemoryTool(agent, run.id, call);
    }
    // Reading the web changes nothing: it counts as reading from outside, not as a change.
    if (webNames.has(call.name)) {
      if (unattended && !approved && !scheduledWebCallGoes(call, { typed: webTask, found: webFound })) {
        return {
          content:
            "This address is neither in your task nor among the results of your searches, and no one can approve it on this run: nothing was sent. Read only those addresses, or finish without it.",
          isError: true,
          step: { kind: "tool", connectionId: null, tool: call.name, input: inputSummary(call.arguments), outcome: "refused" },
        };
      }
      if (!unattended && !approved && agentWebCallAsks(call, webAsks)) {
        // No owner answers for this run: waiting would only run out of time.
        if (unanswered && !askEveryTool) {
          return {
            content: "This address or search isn't in the message you were given, and no one can approve it on this run: nothing was sent. Use only the addresses and search words of the message, or finish without it.",
            isError: true,
          };
        }
        return null;
      }
      const left = Math.min(MAX_RUN_EXTERNAL_CHARS - externalChars, room(messages));
      if (left <= 200) return { content: "You have read as much from outside as one run may. Finish with what you have.", isError: true };
      const out = await runWebTool(call, { room: left, decidedBy: approved?.userId ?? null });
      externalChars += out.chars;
      if (out.found) webFound = [...webFound, ...out.found];
      return out;
    }
    // An owner's chat changes what they ask for at once: they are there, and asked.
    if (chatWrites && WRITE_TOOL_NAMES.has(call.name)) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one message may make. Finish now.`, isError: true };
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      const out = await asAutomation(() => applyWrite(prepared, "approve", registry));
      if (!out.isError) writes += 1;
      return out;
    }
    // A row an event's run would add, proposed for review.
    if (proposes && eventRun && call.name === CREATE_ROW.name) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      const out = await propose(prepared, call);
      if (!out.isError) writes += 1;
      return out;
    }
    if (ownApproved.has(call.name)) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      // Checked first, so a call that can't be made goes back to the agent rather than to an owner.
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      // As a connection's writing tool: a trusted service is one whose events the agent may read, not
      // one that may change the workspace without an owner.
      if (!approved) return null;
      const out = await asAutomation(() => applyWrite(prepared, "approve", registry));
      if (!out.isError) writes += 1;
      return out;
    }
    const mentionWrite = mention && mentionTools.some((t) => t.name === call.name);
    if ((rowRun || databaseId || mentionWrite) && (call.name === "update_row" || call.name === "edit_page" || call.name === "add_comment")) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      const out: CallResult =
        call.name === "add_comment" ? await addComment(agent, run, call.arguments) : await changeRow(ctx, run, call, proposes && call.name === UPDATE_ROW.name ? propose : null);
      if (!out.isError) writes += 1;
      return out;
    }
    if (sender && call.name === DRAFT_EMAIL) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      const rowId = databaseId ? (typeof call.arguments.row_id === "string" ? call.arguments.row_id.trim() : "") : isRowRun(run.source) ? run.source.rowId : "";
      if (databaseId && !(await isRowOf(rowId, databaseId))) {
        return { content: `You may draft email only on rows of the database this run looks after (database_id ${databaseId}).`, isError: true };
      }
      const out = await draftRowEmail({
        workspaceId: run.workspaceId,
        agent: { id: agent.id, userId: agent.userId },
        runId: run.id,
        automationRunId: run.source.kind === "automation" ? run.source.automationRunId : null,
        sender,
        rowId,
        args: call.arguments,
      });
      if (!out.isError) writes += 1;
      return out;
    }
    if (databaseId && call.name === MERGE_ROWS.name && tools.includes(MERGE_ROWS)) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      const out = await mergeRowsTool(ctx, agent, databaseId, call.arguments);
      if (!out.isError) writes += 1;
      return out;
    }
    if (handoff && call.name === ASK_AGENT) return handoff.ask(call, room(messages));
    if (!tools.some((t) => t.name === call.name)) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
    const out: ToolOutcome = await runTool(ctx, run.workspaceId, undefined, call, registry, room(messages));
    return out;
  };

  /**
   * Saves where the run is, after a change it can't take back (or an owner's answer used up): a run
   * taken again (put back for the AI allowance, or after its worker stopped) goes on from here
   * rather than making the change a second time.
   */
  const checkpoint = () =>
    db
      .update(agentRun)
      .set({ state: { messages, queue, rounds: usage.rounds, writes, externalChars, webFound }, steps: redactValue(steps), usage })
      .where(eq(agentRun.id, run.id));

  /** Answers the calls waiting in `queue`, in order; the run pauses at the first that needs approval. */
  const drain = async (decision: AgentRunState["decision"] | undefined): Promise<Paused | null> => {
    let pendingDecision = decision;
    while (queue.length) {
      const call = queue[0];
      const writesBefore = writes;
      const answered = Boolean(pendingDecision);
      let out: CallResult | null;
      if (pendingDecision) {
        out = await decided(call, pendingDecision, toolset, answer, ownApproved);
        pendingDecision = undefined;
      } else out = await answer(call, null);
      if (!out) {
        // A connection's tool, or Leafdesk's own (create_row on an event's run): no connection.
        const external = toolset.byName.get(call.name);
        return {
          status: "awaiting",
          state: { messages, queue, rounds: usage.rounds, writes, externalChars, webFound },
          pending: {
            callId: call.id,
            connectionId: external?.connection.id ?? null,
            tool: external?.tool.name ?? call.name,
            arguments: call.arguments,
            askedAt: new Date().toISOString(),
          },
          steps,
          usage,
        };
      }
      if (out.step) steps.push(out.step);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.content, isError: out.isError });
      queue = queue.slice(1);
      // A chat's steps are saved as they come: the person follows them (chat.ts chatTurn).
      if (answered || writes !== writesBefore || chat) await checkpoint();
    }
    return null;
  };

  if (saved) {
    const paused = await drain(saved.decision);
    if (paused) return paused;
  }

  // Still under way: a run that takes long isn't taken again as stale.
  const stillRunning = () => db.update(agentRun).set({ nextAt: new Date() }).where(and(eq(agentRun.id, run.id), eq(agentRun.status, "running")));
  const limitUsd = aiConfig().limits.runLimitUsd;
  let finalAnswer = "";
  // The last turn called tools instead of answering: it's asked once more, with none run.
  let closing = false;
  for (let round = Math.max(firstRound, usage.rounds); round < RUN_ROUNDS; round++) {
    if (round > firstRound) {
      const wait = takeWorkspaceCapacity(run.workspaceId);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 15_000)));
      await stillRunning();
    }
    // The month's tokens may have run out since the run started or was taken again (other runs of
    // the agent use them too); a new run's first turn was checked in processRun.
    if ((round > firstRound || saved) && (await overMonthlyLimit(agent))) return { status: "failed", code: "limitReached", steps, usage };
    // Past AI_RUN_LIMIT_USD (or RUN_ROUNDS' last turn, for a model without a price), it answers.
    const last = round === RUN_ROUNDS - 1 || usage.costUsd >= limitUsd;
    let result: AiResult;
    try {
      result = await complete({
        feature,
        userId: agent.userId,
        workspaceId: run.workspaceId,
        skipRateLimit: true,
        system,
        messages,
        tools,
        sessionId: run.id,
      });
    } catch (error) {
      // Too long for the model: old tool results make room (the agent can call the tool again),
      // and the same turn is asked again.
      if (isAiError(error) && error.code === "tooLarge" && dropOldToolResults(messages) > 0) {
        round -= 1;
        continue;
      }
      throw error;
    }
    // Counted as it comes back, so a run that fails later still counts what it used; a run is one
    // of the month's runs at its first turn.
    await addAgentUsage(agent.id, { runs: usage.rounds === 0 ? 1 : 0, ...result.usage }).catch((error) =>
      console.error("[agents] could not count what a run used", redactError(error)),
    );
    usage.rounds += 1;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;
    usage.model = result.model;
    await stillRunning();
    if (last && result.toolCalls.length && !result.text.trim() && !closing) {
      closing = true;
      messages.push(result.message);
      for (const call of result.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Not run: this run has no turns left for tools. Answer now with what you have, and say what is left to do.", isError: true });
      }
      round -= 1;
      continue;
    }
    if (!result.toolCalls.length || last) {
      finalAnswer = result.text;
      break;
    }
    const thought = redactText(result.text.replace(/\s+/g, " ").trim());
    if (thought) steps.push({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
    messages.push(result.message);
    queue = result.toolCalls;
    const paused = await drain(undefined);
    if (paused) return paused;
  }
  return { status: "done", steps, answer: finalAnswer, usage };
}

/**
 * Answers the call an owner decided on: sends it (approved), or tells the agent it was declined or
 * sent back. `ownApproved`: Leafdesk's own tools the run waits on, made by `answer` once approved.
 */
async function decided(
  call: AiToolCall,
  decision: NonNullable<AgentRunState["decision"]>,
  toolset: ConnectionToolset,
  answer: (call: AiToolCall, approved: { userId: string } | null) => Promise<CallResult | null>,
  ownApproved: ReadonlySet<string>,
): Promise<CallResult> {
  const external = toolset.byName.get(call.name);
  const own = ownApproved.has(call.name);
  if (!external && !own) {
    // The tool was taken away (or its connection) while the call waited: nothing is sent.
    return { content: `The tool "${call.name}" is no longer allowed to you. Nothing was sent; finish without it.`, isError: true };
  }
  const base = {
    kind: "tool" as const,
    connectionId: external?.connection.id ?? null,
    tool: external?.tool.name ?? call.name,
    input: inputSummary(call.arguments),
    decidedBy: decision.userId,
  };
  if (decision.decision === "approve") return (await answer(call, { userId: decision.userId }))!;
  if (decision.decision === "decline") {
    return { content: "A person declined this call: it was not sent. Don't call it again in this run; finish without it, saying what you would have done.", step: { ...base, outcome: "declined" } };
  }
  return {
    content: `A person sent this call back before it was sent, with this note:\n<note>${(decision.note ?? "").replace(/</g, "‹")}</note>\nNothing was sent. Prepare the call again with the note in mind, and call the tool again.`,
    step: { ...base, outcome: "redo", note: decision.note },
  };
}

/** Whether a page is a row (not a template) of the database, still out of the trash. */
async function isRowOf(rowId: string, databaseId: string) {
  if (!rowId) return false;
  const [row] = await db
    .select({ parentId: page.parentId, archivedAt: page.archivedAt, isTemplate: page.isTemplate, inTemplate: page.inTemplate })
    .from(page)
    .where(eq(page.id, rowId));
  return Boolean(row && row.parentId === databaseId && !row.archivedAt && !row.isTemplate && !row.inTemplate);
}

/**
 * update_row and edit_page, made at once (no one to ask) and starting no automations: on the run's
 * row only, on the page a mention's comment is on, or, on a schedule's run, on the rows of the
 * database it looks after. A row's text
 * changed shows on its page for review, as any AI change does.
 */
async function changeRow(
  ctx: ops.OperationContext,
  run: Run,
  call: { name: string; arguments: Record<string, unknown> },
  propose: ((prepared: PreparedWrite, call: { arguments: Record<string, unknown> }) => Promise<CallResult>) | null,
): Promise<CallResult> {
  const given = call.name === "edit_page" ? call.arguments.page_id : call.arguments.row_id;
  const rowId = typeof given === "string" ? given.trim() : "";
  const databaseId = scheduledDatabase(run.source);
  if (databaseId) {
    if (!(await isRowOf(rowId, databaseId))) {
      return { content: `You may change only rows of the database this run looks after (database_id ${databaseId}). Nothing was changed.`, isError: true };
    }
  } else if (isMentionRun(run.source)) {
    if (rowId !== run.source.pageId) {
      return { content: `You may change only the page the comment is on (page_id ${run.source.pageId}). Nothing was changed.`, isError: true };
    }
  } else if (!isRowRun(run.source)) {
    return { content: "This run has no row to change.", isError: true };
  } else if (rowId !== run.source.rowId) {
    return { content: `You may change only the row that started this run (row_id ${run.source.rowId}). Nothing was changed.`, isError: true };
  }
  const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
  if (!("action" in prepared)) return prepared;
  // The agent's changes wait for review: kept, not made.
  if (propose) return propose(prepared, call);
  const registry: Registry = { sources: [], byKey: new Map() };
  return asAutomation(() => applyWrite(prepared, "approve", registry));
}

/**
 * merge_rows on a schedule's run: rows of the database it looks after only, made at once and
 * starting no automations, as update_row is. The merge checks the agent's access to every row.
 */
async function mergeRowsTool(ctx: ops.OperationContext, agent: Agent, databaseId: string, args: Record<string, unknown>): Promise<CallResult> {
  const keptId = typeof args.kept_row_id === "string" ? args.kept_row_id.trim() : "";
  const others = Array.isArray(args.other_row_ids) ? args.other_row_ids.filter((v): v is string => typeof v === "string").map((v) => v.trim()) : [];
  const choices =
    args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)
      ? Object.fromEntries(Object.entries(args.properties as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined;
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
  const record = (outcome: "done" | "failed") =>
    ({ kind: "write", action: "mergeRows", outcome, targetId: keptId || null, pageId: outcome === "done" ? keptId : null, title: null, changes: [] }) satisfies ChatWriteRecord;
  for (const id of [keptId, ...others]) {
    if (!(await isRowOf(id, databaseId))) {
      return { content: `You may merge only rows of the database this run looks after (database_id ${databaseId}). Nothing was merged.`, isError: true };
    }
  }
  try {
    // The heading over each merged body is in the language of the person who set the agent up.
    const locale = agent.createdBy ? await recipientLocale(agent.createdBy, null) : undefined;
    const out = await asAutomation(() =>
      ops.mergeRows(ctx, { database_id: databaseId, kept_row_id: keptId, other_row_ids: others, properties: choices, title, dry_run: false }, { locale }),
    );
    return { content: `Merged ${others.length} ${others.length === 1 ? "row" : "rows"} into the row ${keptId}: ${JSON.stringify(out)}`, step: record("done") };
  } catch (error) {
    if (error instanceof AccessError || error instanceof PropertyValueError || error instanceof ToolInputError) {
      return { content: `Nothing was merged: ${error.message}`, isError: true, step: record("failed") };
    }
    throw error;
  }
}

/** add_comment: a new comment thread, as the agent, on the run's row (or a row of the database a schedule's run looks after). */
async function addComment(agent: Agent, run: Run, args: Record<string, unknown>): Promise<CallResult> {
  const databaseId = scheduledDatabase(run.source);
  let rowId: string;
  if (databaseId) {
    rowId = typeof args.row_id === "string" ? args.row_id.trim() : "";
    if (!(await isRowOf(rowId, databaseId))) return { content: `You may comment only on rows of the database this run looks after (database_id ${databaseId}).`, isError: true };
  } else if (isRowRun(run.source)) {
    rowId = run.source.rowId;
  } else return { content: "This run has no row to comment on.", isError: true };
  const text = typeof args.text === "string" ? args.text.trim().slice(0, MAX_COMMENT) : "";
  if (!text) return { content: "add_comment needs text.", isError: true };
  try {
    await asAutomation(() => changeComments(agent.userId, rowId, { type: "createThread", body: text }));
    return { content: "The comment was added.", step: { kind: "comment", pageId: rowId, text: redactText(text).slice(0, 500), outcome: "done" } };
  } catch (error) {
    if (error instanceof AccessError) {
      return { content: "You may not comment on this row: you can only read it.", isError: true, step: { kind: "comment", pageId: rowId, text: redactText(text).slice(0, 500), outcome: "failed" } };
    }
    throw error;
  }
}

/**
 * Whether a mention's run may change the page its comment is on (the agent, within the member's
 * access, may edit it) and whether that page is a database row (update_row).
 */
async function mentionEditing(agent: Agent, pageId: string): Promise<{ edits: boolean; row: boolean }> {
  const { page: target, level } = await pageAccessOf(agent.userId, pageId);
  if (!target || !hasLevel(level, "edit")) return { edits: false, row: false };
  const [parent] = target.parentId ? await db.select({ kind: page.kind }).from(page).where(eq(page.id, target.parentId)) : [];
  return { edits: true, row: parent?.kind === "database" };
}

/** Names of the people (and agents) who wrote in a thread, for a mention's run to read it by. */
async function threadNames(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const [rows, agents] = await Promise.all([
    db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
    db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.userId, ids)),
  ]);
  const isAgent = new Set(agents.map((a) => a.userId));
  return new Map(rows.map((r) => [r.id, isAgent.has(r.id) ? `${r.name} (agent)` : r.name]));
}

/** What happened, in words: the row added or the properties changed, and by whom; the event received; who asked, or set the schedule; or who mentioned the agent. */
async function eventText(run: Run) {
  if (run.source.kind === "handoff") return handoffEventText(run.source);
  if (run.source.kind === "chat") {
    const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, run.source.userId));
    return `${person?.name ?? "A person"} wrote to you in a chat.`;
  }
  if (isScheduleRun(run.source)) {
    const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, run.source.scheduledBy));
    const due = "scheduledFor" in run.context && run.context.scheduledFor ? ` It was due at ${run.context.scheduledFor} (UTC).` : "";
    const on = run.source.databaseId ? ", to look after the database below" : "";
    return `${owner?.name ?? "An owner"} set a schedule for you that started this run${on}.${due}`;
  }
  if (isMentionRun(run.source)) {
    const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, run.source.mentionedBy));
    return `${person?.name ?? "A member"} mentioned you in a comment on the page below.`;
  }
  if (run.source.kind === "request") {
    const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, run.source.requestedBy));
    const via = run.source.via === "api" ? "the REST API" : "an AI assistant (MCP)";
    return `${owner?.name ?? "An owner"} asked for this run over ${via}${isRowRun(run.source) ? ", on the row below" : ""}.`;
  }
  if (isEventRun(run.source)) {
    // The type is the sender's word (often an unsigned header): it goes with the event's data, not here.
    const [conn] = await db.select({ name: connection.name }).from(connection).where(eq(connection.id, run.source.connectionId));
    return `The connection "${conn?.name ?? "?"}" received an event.`;
  }
  if (!("created" in run.context)) return "The row changed.";
  if (run.context.datePassed) return `The row's date (${run.context.datePassed}) is as far past as the automation waits for.`;
  const { created, changed, actorId } = run.context;
  const [actor] = actorId ? await db.select({ name: user.name }).from(user).where(eq(user.id, actorId)) : [];
  const by = actor ? ` by ${actor.name}` : "";
  if (created) return `A row was added to the database${by}.`;
  const props = await getProperties(run.source.databaseId);
  const names = changed.flatMap((id) => {
    const prop = props.find((p) => p.id === id);
    return prop ? [`"${pageLabel(prop.name)}"`] : [];
  });
  return names.length ? `The row's ${names.join(", ")} changed${by}.` : `The row changed${by}.`;
}

// ----------------------------------------------------------------------------------- worker

/** Does a run taken in a slot of the worker (or, a helper's, in the slot of the run that asked it), failing it on an error. */
function runInSlot(run: Run): Promise<void> {
  return processRun(run).catch(async (error) => {
    console.error("[agents] run failed", redactError(error));
    await finish(run, { status: "failed", code: "error", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  });
}

const running = new Set<string>();
/** A sweep under way, and whether another was asked for meanwhile: one at a time, or two could each take the free slots. */
let sweeping: Promise<void> | null = null;
let sweepAgain = false;

function sweep(): Promise<void> {
  if (sweeping) {
    sweepAgain = true;
    return sweeping;
  }
  sweeping = (async () => {
    do {
      sweepAgain = false;
      await expireApprovals();
      await takeDue();
    } while (sweepAgain);
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

async function takeDue() {
  try {
    const free = aiConfig().limits.concurrency - running.size;
    const runs = await claim(free);
    for (const run of runs) {
      running.add(run.id);
      void runInSlot(run)
        .finally(() => {
          running.delete(run.id);
          // A slot is free: take what waits.
          setImmediate(() => void sweep());
        });
    }
  } catch (error) {
    console.error("[agents] could not run agents", redactError(error));
  }
}

/** Runs whose call no one answered in time fail, sending nothing. */
export async function expireApprovals() {
  try {
    const expired = await db
      .update(agentRun)
      .set({ status: "failed", code: "approvalTimeout", finishedAt: new Date(), state: null })
      .where(and(eq(agentRun.status, "awaiting_approval"), lte(agentRun.nextAt, new Date())))
      .returning({
        id: agentRun.id,
        steps: agentRun.steps,
        pending: agentRun.pending,
        workspaceId: agentRun.workspaceId,
        agentId: agentRun.agentId,
        source: agentRun.source,
        context: agentRun.context,
      });
    for (const run of expired) {
      const pending = run.pending;
      let steps = run.steps;
      if (pending) {
        const step: AgentStepRecord = { kind: "tool", connectionId: pending.connectionId, tool: pending.tool, input: inputSummary(pending.arguments), outcome: "expired" };
        steps = [...run.steps, step];
        await db.update(agentRun).set({ steps, pending: null }).where(eq(agentRun.id, run.id));
      }
      await withdrawApproval(run.id);
      await reportScheduledRun(run);
      await replyToMention(run, { status: "failed", code: "approvalTimeout" });
      await closeChatTurn({ ...run, steps }, { code: "approvalTimeout" });
    }
  } catch (error) {
    console.error("[agents] could not expire approvals", redactError(error));
  }
}

/** Runs everything due now and waits for it (scripts and tests; the server sweeps on its own). */
export async function flushAgentRuns() {
  for (;;) {
    await sweep();
    while (running.size) await new Promise((resolve) => setTimeout(resolve, 20));
    const [due] = await db
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(and(eq(agentRun.status, "pending"), lte(agentRun.nextAt, new Date())))
      .limit(1);
    if (!due) return;
  }
}

/** Finished runs older than AGENT_RUN_HISTORY_DAYS go, and the events connections received a while ago. */
export async function pruneAgentRuns() {
  await db
    .delete(agentRun)
    .where(
      and(
        inArray(agentRun.status, ["done", "failed"]),
        lte(agentRun.finishedAt, new Date(Date.now() - AGENT_RUN_HISTORY_DAYS * 24 * 60 * 60_000)),
      ),
    )
    .catch((error) => console.error("[agents] could not prune runs", redactError(error)));
  await db
    .delete(connectionEvent)
    .where(lte(connectionEvent.receivedAt, new Date(Date.now() - CONNECTION_EVENT_DAYS * 24 * 60 * 60_000)))
    .catch((error) => console.error("[connections] could not prune events", redactError(error)));
  await pruneAgentUsage().catch((error) => console.error("[agents] could not prune usage", redactError(error)));
  await pruneAiUsage().catch((error) => console.error("[ai] could not prune usage", redactError(error)));
}

/** Server only: runs queued agents, right away when they are queued and every few seconds. */
export function startAgents() {
  state.kick = () => setImmediate(() => void sweep());
  void sweep();
  void pruneAgentRuns();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  const daily = setInterval(() => void pruneAgentRuns(), 24 * 60 * 60_000);
  timer.unref?.();
  daily.unref?.();
  return () => {
    clearInterval(timer);
    clearInterval(daily);
  };
}

export { AiError };
