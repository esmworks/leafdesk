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
 * changed, or an event came in), a map of what the agent can open, then up to MAX_AGENT_ROUNDS
 * turns of tools. Leafdesk's own tools are narrow: reading what is shared with the agent; on a
 * row's run, changing or commenting on that row; on an event's run, adding rows to databases
 * shared with it to edit (a log of what came in); at most MAX_AGENT_WRITES changes in all. A
 * schedule's run on a database may change and comment on that database's rows instead, at most
 * MAX_SCHEDULED_WRITES times, over more turns (MAX_SCHEDULED_ROUNDS), and tells the owner who set
 * the schedule how it went (`agent_report`). Changes it makes start no automations
 * (`asAutomation`), so agents can't set each other off. On top of those come the tools of
 * connections an owner allowed it: one that only reads runs at once, except where what the run
 * reads was written by someone the workspace doesn't know (a row's run no member started, an
 * anonymous form answer; a schedule's run over a database with such rows; an event's run whose
 * trigger an owner hasn't marked trusted), where every one waits; any other makes the run wait
 * (`awaiting_approval`, its conversation saved in `state`) until an owner answers, and fails it,
 * sending nothing, after APPROVAL_TIMEOUT_MS. An event's run waits the same way before each row it
 * adds, trusted or not: trust lets it read.
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
  AGENT_RUN_HISTORY_DAYS,
  AGENT_RUN_TIMEOUT_MS,
  isEventRun,
  isRowRun,
  isScheduleRun,
  MAX_AGENT_PROMPT,
  MAX_AGENT_ROUNDS,
  MAX_AGENT_WRITES,
  MAX_SCHEDULED_WRITES,
  skillStepsToAdd,
  type AgentPendingCall,
  type AgentRunCode,
  type AgentRunContext,
  type AgentRunSource,
  type AgentRunUsage,
  type AgentStepRecord,
} from "@/lib/agents";
import { APPROVAL_TIMEOUT_MS, CONNECTION_EVENT_DAYS, MAX_RUN_EXTERNAL_CHARS } from "@/lib/connections";
import { pageLabel } from "@/lib/labels";
import { redactError, redactText, redactValue } from "@/lib/redact";
import { AccessError, findMembership, inWorkspace, pageAccessOf } from "@/server/access";
import { runActingFor } from "@/server/acting-for";
import { aiConfig, AiError, complete, isAiError, promptRoomFor, takeWorkspaceCapacity, type AiMessage, type AiResult, type AiTool, type AiToolCall } from "@/server/ai";
import { agentEventPrompt, agentRequestPrompt, agentSchedulePrompt, agentSystemPrompt, agentTaskPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { memoryAvailable, memoryForPrompt } from "@/server/ai-memory";
import { applyWrite, CHAT_TOOLS, prepareWrite, runTool, workspaceMap, WRITE_TOOLS, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { asAutomation } from "@/server/automations/queue";
import { changeComments } from "@/server/comments";
import { notifyApprovers, withdrawApproval } from "@/server/connections/approvals";
import { agentToolset, inputSummary, runConnectionTool, type ConnectionToolset } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import type * as ops from "@/server/operations";
import { runClock } from "./clock";
import { ASK_AGENT, handoffEventText, handoffFor, handoffHold } from "./handoff";
import { agentsWorker } from "./kick";
import { AGENT_MEMORY_TOOL_NAMES, AGENT_MEMORY_TOOLS, runAgentMemoryTool } from "./memory";
import { agentSkillRoom, runSkills } from "./skills";
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
/** A schedule's run on a database goes through the whole of it: more turns, and more time, than a row's. */
const MAX_SCHEDULED_ROUNDS = 16;
const SCHEDULED_RUN_TIMEOUT_MS = 6 * 60_000;
/** The most of the database a schedule's run reads before its first turn. */
const DATABASE_CHARS = 16_000;

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

const UPDATE_ROW = WRITE_TOOLS.find((t) => t.name === "update_row")!;
const CREATE_ROW = WRITE_TOOLS.find((t) => t.name === "create_row")!;
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
 * What makes two queued runs the same run: the automation's run, the event and trigger, or the
 * schedule and the time it was due. Each run an owner asks for is its own.
 */
function sameSource(source: AgentRunSource, context: AgentRunContext) {
  if (source.kind === "automation") return sql`${agentRun.source}->>'automationRunId' = ${source.automationRunId}`;
  if (source.kind === "connection") return sql`${agentRun.source}->>'eventId' = ${source.eventId} and ${agentRun.source}->>'triggerId' = ${source.triggerId}`;
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
  // A run an owner asked for (or set a schedule for) is held to their access, and stands behind
  // what it reads as they do; only owners ask for runs and set schedules, so one whose owner is no
  // longer an owner opens nothing.
  if (run.source.kind === "request" || run.source.kind === "schedule") {
    const ownerId = run.source.kind === "request" ? run.source.requestedBy : run.source.scheduledBy;
    const asker = await findMembership(ownerId, run.workspaceId);
    if (asker?.role !== "owner") return finish(run, { status: "failed", code: "noAccess" });
    member = bound = ownerId;
    trusted = true;
  }
  // Another agent asked for the run (handoff.ts): held as its run was.
  if (run.source.kind === "handoff") {
    const held = await handoffHold(run.source, run.workspaceId);
    if (!held) return finish(run, { status: "failed", code: "noAccess" });
    member = bound = held.bound;
    trusted = held.trusted;
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

  const outcome = await withinMember(agent, bound, () => converse(agent, run, { member, bound, trusted })).catch((error: unknown) => ({ error }));
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
  { member, bound, trusted }: { member: string | null; bound: string | null; trusted: boolean },
): Promise<Ending | Paused> {
  const ctx: ops.OperationContext = { userId: agent.userId, actor: { userId: agent.userId } };
  const rowRun = isRowRun(run.source);
  const scheduled = isScheduleRun(run.source);
  const databaseId = scheduledDatabase(run.source);
  // Changes it may make in all, and turns with the model it may take.
  const maxWrites = databaseId ? MAX_SCHEDULED_WRITES : MAX_AGENT_WRITES;
  const maxRounds = databaseId ? MAX_SCHEDULED_ROUNDS : MAX_AGENT_ROUNDS;
  const eventRun = isEventRun(run.source);
  // Leafdesk's own tools this run makes only once an owner approves (none on a row's run).
  const ownApproved: ReadonlySet<string> = eventRun ? EVENT_APPROVED_TOOLS : new Set();
  // A row no member wrote, or an event from a service no owner vouched for, may carry anyone's
  // instructions: no connection tool runs without an owner.
  const askEveryTool = rowRun ? !member : !trusted;
  // The run's own time, from now: the wait for an answer doesn't count, nor (up to a point) the
  // wait for agents it asks.
  const clock = runClock(databaseId ? SCHEDULED_RUN_TIMEOUT_MS : AGENT_RUN_TIMEOUT_MS);
  const signal = clock.signal;
  const toolset = await agentToolset(agent.id);
  const connections = [...new Set([...toolset.byName.values()].map((e) => e.connection.name))];
  // What a run reads that no one in the workspace stands behind could fill the owners' review with
  // its own notes: such a run proposes none.
  const memoryOn = await memoryAvailable(run.workspaceId);
  // Another agent wrote a helper's task: its run proposes none either.
  const handedOff = run.source.kind === "handoff";
  const remembers = memoryOn && !askEveryTool && !handedOff;
  // Other agents it may ask; none on a helper's run.
  const handoff = await handoffFor(agent, run, { bound, trusted: !askEveryTool, clock, runHelper: runInSlot });
  const tools = [
    ...(rowRun ? AGENT_TOOLS : databaseId ? SCHEDULED_DATABASE_TOOLS : eventRun ? EVENT_TOOLS : CHAT_TOOLS),
    ...(remembers ? AGENT_MEMORY_TOOLS : []),
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
    addsRows: eventRun,
    connections,
    askEveryTool,
    skills: skillSet.skills,
    remembers,
  });
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  const budget = await promptRoomFor(run.workspaceId);
  const room = (messages: AiMessage[]) => budget - system.length - toolsSize - messages.reduce((n, m) => n + m.content.length, 0) - 300;

  const registry: Registry = { sources: [], byKey: new Map() };
  const steps: AgentStepRecord[] = [...run.steps];
  steps.push(...skillStepsToAdd(steps, skillSet.steps));
  const usage: AgentRunUsage = run.usage ? { ...run.usage } : { inputTokens: 0, outputTokens: 0, costUsd: 0, rounds: 0 };
  let messages: AiMessage[];
  let writes = 0;
  let externalChars = 0;
  let firstRound = 0;
  let queue: AiToolCall[] = [];

  const saved = run.state;
  if (saved) {
    messages = saved.messages as AiMessage[];
    writes = saved.writes;
    externalChars = saved.externalChars;
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
      const out = await runConnectionTool({ entry: external, args: call.arguments, actorId: agent.userId, approvedBy: approved?.userId ?? null, room: left, signal });
      externalChars += out.chars;
      if (external.tool.kind === "write") writes += 1;
      return out;
    }
    // Notes change nothing in the workspace: they don't count as changes.
    if (AGENT_MEMORY_TOOL_NAMES.has(call.name)) {
      if (!remembers) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      return runAgentMemoryTool(agent, run.id, call);
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
    if ((rowRun || databaseId) && (call.name === "update_row" || call.name === "edit_page" || call.name === "add_comment")) {
      if (writes >= maxWrites) return { content: `You have made ${maxWrites} changes, the most one run may make. Finish now.`, isError: true };
      const out: CallResult = call.name === "add_comment" ? await addComment(agent, run, call.arguments) : await changeRow(ctx, run, call);
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
      .set({ state: { messages, queue, rounds: usage.rounds, writes, externalChars }, steps: redactValue(steps), usage })
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
          state: { messages, queue, rounds: usage.rounds, writes, externalChars },
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
      if (answered || writes !== writesBefore) await checkpoint();
    }
    return null;
  };

  if (saved) {
    const paused = await drain(saved.decision);
    if (paused) return paused;
  }

  let finalAnswer = "";
  for (let round = Math.max(firstRound, usage.rounds); round < maxRounds; round++) {
    if (round > firstRound) {
      const wait = takeWorkspaceCapacity(run.workspaceId);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 15_000)));
      // Still under way: a run that takes long (a schedule's, over a database) isn't taken again as stale.
      await db.update(agentRun).set({ nextAt: new Date() }).where(and(eq(agentRun.id, run.id), eq(agentRun.status, "running")));
    }
    // The month's tokens may have run out since the run started or was taken again (other runs of
    // the agent use them too); a new run's first turn was checked in processRun.
    if ((round > firstRound || saved) && (await overMonthlyLimit(agent))) return { status: "failed", code: "limitReached", steps, usage };
    const last = round === maxRounds - 1;
    let result: AiResult;
    try {
      result = await complete({
        feature: "agent",
        userId: agent.userId,
        workspaceId: run.workspaceId,
        skipRateLimit: true,
        system,
        messages,
        tools,
        signal,
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
 * row only, or, on a schedule's run, on the rows of the database it looks after. A row's text
 * changed shows on its page for review, as any AI change does.
 */
async function changeRow(ctx: ops.OperationContext, run: Run, call: { name: string; arguments: Record<string, unknown> }): Promise<ToolOutcome> {
  const given = call.name === "edit_page" ? call.arguments.page_id : call.arguments.row_id;
  const rowId = typeof given === "string" ? given.trim() : "";
  const databaseId = scheduledDatabase(run.source);
  if (databaseId) {
    if (!(await isRowOf(rowId, databaseId))) {
      return { content: `You may change only rows of the database this run looks after (database_id ${databaseId}). Nothing was changed.`, isError: true };
    }
  } else if (!isRowRun(run.source)) {
    return { content: "This run has no row to change.", isError: true };
  } else if (rowId !== run.source.rowId) {
    return { content: `You may change only the row that started this run (row_id ${run.source.rowId}). Nothing was changed.`, isError: true };
  }
  const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
  if (!("action" in prepared)) return prepared;
  const registry: Registry = { sources: [], byKey: new Map() };
  return asAutomation(() => applyWrite(prepared, "approve", registry));
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

/** What happened, in words: the row added or the properties changed, and by whom; the event received; or who asked, or set the schedule. */
async function eventText(run: Run) {
  if (run.source.kind === "handoff") return handoffEventText(run.source);
  if (isScheduleRun(run.source)) {
    const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, run.source.scheduledBy));
    const due = "scheduledFor" in run.context && run.context.scheduledFor ? ` It was due at ${run.context.scheduledFor} (UTC).` : "";
    const on = run.source.databaseId ? ", to look after the database below" : "";
    return `${owner?.name ?? "An owner"} set a schedule for you that started this run${on}.${due}`;
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
      .returning({ id: agentRun.id, steps: agentRun.steps, pending: agentRun.pending, workspaceId: agentRun.workspaceId, agentId: agentRun.agentId, source: agentRun.source });
    for (const run of expired) {
      const pending = run.pending;
      if (pending) {
        const step: AgentStepRecord = { kind: "tool", connectionId: pending.connectionId, tool: pending.tool, input: inputSummary(pending.arguments), outcome: "expired" };
        await db.update(agentRun).set({ steps: [...run.steps, step], pending: null }).where(eq(agentRun.id, run.id));
      }
      await withdrawApproval(run.id);
      await reportScheduledRun(run);
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
