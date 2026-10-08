/**
 * The agents' worker: takes queued runs (`agent_run`, queued by an automation's "Run an agent"
 * action or a connection's trigger) and does them, as the agent's own user, with the access it has
 * now. A row's run started by a member's change is also held to what that member may
 * (acting-for.ts): the agent reads and changes only pages and values both of them can, so it never
 * hands someone what they couldn't open themselves. A few run at a time (AI_CONCURRENCY), each
 * within its workspace's AI allowance (a run waits for its turn rather than failing), and apart
 * from the automations' worker, so a long run never holds up a webhook.
 *
 * A run is a short conversation with the model: the agent's instructions, what happened (a row
 * changed, or an event came in), a map of what the agent can open, then up to MAX_AGENT_ROUNDS
 * turns of tools. Leafdesk's own tools are narrow: reading what is shared with the agent, and, on a
 * row's run, changing or commenting on that row, at most MAX_AGENT_WRITES times. Changes it makes
 * start no automations (`asAutomation`), so agents can't set each other off. On top of those come
 * the tools of connections an owner allowed it: one that only reads runs at once (except on a row's
 * run no member started, an anonymous form answer, where every one waits: the row was written by
 * someone the workspace doesn't know); any other makes the run wait (`awaiting_approval`, its
 * conversation saved in `state`) until an owner answers, and fails it, sending nothing, after
 * APPROVAL_TIMEOUT_MS.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, connection, connectionEvent, page, user, workspaceAgent, type AgentRunState } from "@/db/schema";
import {
  AGENT_RUN_HISTORY_DAYS,
  AGENT_RUN_TIMEOUT_MS,
  isRowRun,
  MAX_AGENT_PROMPT,
  MAX_AGENT_ROUNDS,
  MAX_AGENT_WRITES,
  type AgentPendingCall,
  type AgentRunCode,
  type AgentRunContext,
  type AgentRunSource,
  type AgentRunUsage,
  type AgentStepRecord,
} from "@/lib/agents";
import { APPROVAL_TIMEOUT_MS, CONNECTION_EVENT_DAYS, MAX_RUN_EXTERNAL_CHARS } from "@/lib/connections";
import { pageLabel } from "@/lib/labels";
import { AccessError, findMembership, pageAccessOf } from "@/server/access";
import { runActingFor } from "@/server/acting-for";
import { aiConfig, AiError, complete, isAiError, takeWorkspaceCapacity, type AiMessage, type AiTool, type AiToolCall } from "@/server/ai";
import { agentEventPrompt, agentSystemPrompt, agentTaskPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { applyWrite, CHAT_TOOLS, prepareWrite, runTool, workspaceMap, WRITE_TOOLS, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { asAutomation } from "@/server/automations/queue";
import { changeComments } from "@/server/comments";
import { notifyApprovers, withdrawApproval } from "@/server/connections/approvals";
import { agentToolset, inputSummary, runConnectionTool, type ConnectionToolset } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import type * as ops from "@/server/operations";
import { agentsWorker } from "./kick";

const SWEEP_INTERVAL_MS = 5_000;
/** A run taken this long ago and not finished belongs to a worker that stopped: it's taken again. */
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

const UPDATE_ROW = WRITE_TOOLS.find((t) => t.name === "update_row")!;
/** Leafdesk's tools on a row's run; a connection event's run only reads. */
export const AGENT_TOOLS: AiTool[] = [...CHAT_TOOLS, UPDATE_ROW, ADD_COMMENT];

// ------------------------------------------------------------------------------------ queue

const state = agentsWorker;

/** What makes two queued runs the same run: the automation's run, or the event and trigger. */
function sameSource(source: AgentRunSource) {
  return source.kind === "automation"
    ? sql`${agentRun.source}->>'automationRunId' = ${source.automationRunId}`
    : sql`${agentRun.source}->>'eventId' = ${source.eventId} and ${agentRun.source}->>'triggerId' = ${source.triggerId}`;
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
    .where(and(eq(agentRun.agentId, input.agentId), sameSource(input.source), eq(agentRun.prompt, prompt)))
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
      error: values.error?.slice(0, 500) ?? null,
      ...(values.steps ? { steps: values.steps } : {}),
      ...(values.answer !== undefined ? { answer: values.answer.slice(0, 8_000) } : {}),
      ...(values.usage !== undefined ? { usage: values.usage } : {}),
      state: null,
      pending: null,
      finishedAt: new Date(),
    })
    .where(eq(agentRun.id, run.id));
}

/** Puts a run back to wait (for the workspace's AI allowance) until `at`. */
async function later(run: Run, at: Date) {
  await db.update(agentRun).set({ status: "pending", nextAt: at }).where(eq(agentRun.id, run.id));
}

/** Parks a run until an owner answers the call it waits on (or the call runs out of time). */
async function park(run: Run, agent: Agent, values: { state: AgentRunState; pending: AgentPendingCall; steps: AgentStepRecord[]; usage: AgentRunUsage }) {
  await db
    .update(agentRun)
    .set({
      status: "awaiting_approval",
      state: values.state,
      pending: values.pending,
      steps: values.steps,
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

  // The member whose change started a row's run: the agent works within their access as well. Asked
  // again each time the run is taken (after an approval too): their access as it is now counts, and
  // once they have left the workspace the run goes on as one no member started.
  let member: string | null = null;
  if (isRowRun(run.source)) {
    const { rowId, databaseId } = run.source;
    const [row] = await db.select({ id: page.id, parentId: page.parentId, archivedAt: page.archivedAt }).from(page).where(eq(page.id, rowId));
    if (!row || row.archivedAt || row.parentId !== databaseId) return finish(run, { status: "failed", code: "rowGone" });
    member = await memberBehind(run);
    const { level } = await withinMember(agent, member, () => pageAccessOf(agent.userId, rowId));
    if (level === "none") return finish(run, { status: "failed", code: "noAccess" });
  } else {
    const [conn] = await db.select({ id: connection.id }).from(connection).where(eq(connection.id, run.source.connectionId));
    if (!conn) return finish(run, { status: "failed", code: "connectionGone" });
  }

  const wait = takeWorkspaceCapacity(run.workspaceId);
  if (wait > 0) return later(run, new Date(Date.now() + wait));

  const outcome = await withinMember(agent, member, () => converse(agent, run, { member })).catch((error: unknown) => ({ error }));
  if ("error" in outcome) {
    const error = outcome.error;
    if (isAiError(error) && error.code === "rateLimited") return later(run, new Date(Date.now() + (error.retryAfterMs ?? 30_000)));
    const code: AgentRunCode = isAiError(error) ? (error.code === "aborted" || error.code === "timeout" ? "timeout" : "provider") : "error";
    if (!isAiError(error)) console.error("[agents] run failed", error);
    return finish(run, { status: "failed", code, error: error instanceof Error ? error.message : String(error) });
  }
  if (outcome.status === "awaiting") return park(run, agent, outcome);
  return finish(run, outcome);
}

/**
 * Who started a row's run, if it is someone in the workspace (a guest too): null for an anonymous
 * form answer, a signed-in visitor's answer to a public form, or an account since removed.
 */
async function memberBehind(run: Run): Promise<string | null> {
  const actorId = "actorId" in run.context ? run.context.actorId : null;
  if (!actorId) return null;
  return (await findMembership(actorId, run.workspaceId)) ? actorId : null;
}

/** Runs `fn` with the agent held to the member's access as well (no member: the agent's own). */
function withinMember<T>(agent: Agent, member: string | null, fn: () => Promise<T>): Promise<T> {
  return member ? runActingFor({ userId: agent.userId, forUserId: member }, fn) : fn();
}

type Paused = { status: "awaiting"; state: AgentRunState; pending: AgentPendingCall; steps: AgentStepRecord[]; usage: AgentRunUsage };
type CallResult = { content: string; isError?: boolean; step?: AgentStepRecord };

/** The run's turns with the model (from the start, or from where it waited): what it did, and how it ended. */
async function converse(agent: Agent, run: Run, { member }: { member: string | null }): Promise<Ending | Paused> {
  const ctx: ops.OperationContext = { userId: agent.userId, actor: { userId: agent.userId } };
  const rowRun = isRowRun(run.source);
  // A row no member wrote may carry anyone's instructions: no connection tool runs without an owner.
  const askEveryTool = rowRun && !member;
  const limits = aiConfig().limits;
  // The run's own time, from now: the wait for an answer doesn't count.
  const signal = AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS);
  const toolset = await agentToolset(agent.id);
  const connections = [...new Set([...toolset.byName.values()].map((e) => e.connection.name))];
  const tools = [...(rowRun ? AGENT_TOOLS : CHAT_TOOLS), ...toolset.tools];
  const system = agentSystemPrompt(agent, { row: rowRun, connections, askEveryTool });
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  const room = (messages: AiMessage[]) => limits.maxInputChars - system.length - toolsSize - messages.reduce((n, m) => n + m.content.length, 0) - 300;

  const registry: Registry = { sources: [], byKey: new Map() };
  const steps: AgentStepRecord[] = [...run.steps];
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
    messages = [{ role: "user", content: agentTaskPrompt({ task: run.prompt, event: await eventText(run), row: read.content, map }) }];
  } else {
    const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
    const type = "eventType" in run.context ? run.context.eventType : "event";
    const body = `Type: ${type}\n\n${"body" in run.context ? run.context.body.slice(0, EVENT_CHARS) : ""}`;
    messages = [{ role: "user", content: agentEventPrompt({ task: run.prompt, event: await eventText(run), body, map }) }];
  }

  /** Answers one tool call; null when it must wait for approval. */
  const answer = async (call: AiToolCall, approved: { userId: string } | null): Promise<CallResult | null> => {
    const external = toolset.byName.get(call.name);
    if (external) {
      if (external.tool.kind === "write" && writes >= MAX_AGENT_WRITES) {
        return { content: `You have made ${MAX_AGENT_WRITES} changes, the most one run may make. Finish now.`, isError: true };
      }
      if ((external.tool.kind === "write" || askEveryTool) && !approved) return null;
      const left = MAX_RUN_EXTERNAL_CHARS - externalChars;
      if (left <= 200) return { content: "You have read as much from connected services as one run may. Finish with what you have.", isError: true };
      const out = await runConnectionTool({ entry: external, args: call.arguments, agentUserId: agent.userId, agentName: agent.name, approvedBy: approved?.userId ?? null, room: left, signal });
      externalChars += out.chars;
      if (external.tool.kind === "write") writes += 1;
      return out;
    }
    if (rowRun && (call.name === "update_row" || call.name === "add_comment")) {
      if (writes >= MAX_AGENT_WRITES) return { content: `You have made ${MAX_AGENT_WRITES} changes, the most one run may make. Finish now.`, isError: true };
      const out: CallResult = call.name === "update_row" ? await updateRow(ctx, run, call) : await addComment(agent, run, call.arguments);
      if (!out.isError) writes += 1;
      return out;
    }
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
      .set({ state: { messages, queue, rounds: usage.rounds, writes, externalChars }, steps, usage })
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
        out = await decided(call, pendingDecision, toolset, answer);
        pendingDecision = undefined;
      } else out = await answer(call, null);
      if (!out) {
        const external = toolset.byName.get(call.name)!;
        return {
          status: "awaiting",
          state: { messages, queue, rounds: usage.rounds, writes, externalChars },
          pending: { callId: call.id, connectionId: external.connection.id, tool: external.tool.name, arguments: call.arguments, askedAt: new Date().toISOString() },
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
  for (let round = Math.max(firstRound, usage.rounds); round < MAX_AGENT_ROUNDS; round++) {
    if (round > firstRound) {
      const wait = takeWorkspaceCapacity(run.workspaceId);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 15_000)));
    }
    const last = round === MAX_AGENT_ROUNDS - 1;
    const result = await complete({
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
    usage.rounds += 1;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;
    if (!result.toolCalls.length || last) {
      finalAnswer = result.text;
      break;
    }
    const thought = result.text.replace(/\s+/g, " ").trim();
    if (thought) steps.push({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
    messages.push(result.message);
    queue = result.toolCalls;
    const paused = await drain(undefined);
    if (paused) return paused;
  }
  return { status: "done", steps, answer: finalAnswer, usage };
}

/** Answers the call an owner decided on: sends it (approved), or tells the agent it was declined or sent back. */
async function decided(
  call: AiToolCall,
  decision: NonNullable<AgentRunState["decision"]>,
  toolset: ConnectionToolset,
  answer: (call: AiToolCall, approved: { userId: string } | null) => Promise<CallResult | null>,
): Promise<CallResult> {
  const external = toolset.byName.get(call.name);
  if (!external) {
    // The tool was taken away (or its connection) while the call waited: nothing is sent.
    return { content: `The tool "${call.name}" is no longer allowed to you. Nothing was sent; finish without it.`, isError: true };
  }
  const base = { kind: "tool" as const, connectionId: external.connection.id, tool: external.tool.name, input: inputSummary(call.arguments), decidedBy: decision.userId };
  if (decision.decision === "approve") return (await answer(call, { userId: decision.userId }))!;
  if (decision.decision === "decline") {
    return { content: "A person declined this call: it was not sent. Don't call it again in this run; finish without it, saying what you would have done.", step: { ...base, outcome: "declined" } };
  }
  return {
    content: `A person sent this call back before it was sent, with this note:\n<note>${(decision.note ?? "").replace(/</g, "‹")}</note>\nNothing was sent. Prepare the call again with the note in mind, and call the tool again.`,
    step: { ...base, outcome: "redo", note: decision.note },
  };
}

/** update_row, on the run's row only, made at once (no one to ask) and starting no automations. */
async function updateRow(ctx: ops.OperationContext, run: Run, call: { name: string; arguments: Record<string, unknown> }): Promise<ToolOutcome> {
  if (!isRowRun(run.source)) return { content: "This run has no row to change.", isError: true };
  const rowId = typeof call.arguments.row_id === "string" ? call.arguments.row_id.trim() : "";
  if (rowId !== run.source.rowId) {
    return { content: `You may change only the row that started this run (row_id ${run.source.rowId}). Nothing was changed.`, isError: true };
  }
  const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
  if (!("action" in prepared)) return prepared;
  const registry: Registry = { sources: [], byKey: new Map() };
  return asAutomation(() => applyWrite(prepared, "approve", registry));
}

/** add_comment: a new comment thread on the run's row, as the agent. */
async function addComment(agent: Agent, run: Run, args: Record<string, unknown>): Promise<CallResult> {
  if (!isRowRun(run.source)) return { content: "This run has no row to comment on.", isError: true };
  const rowId = run.source.rowId;
  const text = typeof args.text === "string" ? args.text.trim().slice(0, MAX_COMMENT) : "";
  if (!text) return { content: "add_comment needs text.", isError: true };
  try {
    await asAutomation(() => changeComments(agent.userId, rowId, { type: "createThread", body: text }));
    return { content: "The comment was added.", step: { kind: "comment", pageId: rowId, text: text.slice(0, 500), outcome: "done" } };
  } catch (error) {
    if (error instanceof AccessError) {
      return { content: "You may not comment on this row: you can only read it.", isError: true, step: { kind: "comment", pageId: rowId, text: text.slice(0, 500), outcome: "failed" } };
    }
    throw error;
  }
}

/** What happened, in words: the row added or the properties changed, and by whom; or the event received. */
async function eventText(run: Run) {
  if (!isRowRun(run.source)) {
    // The type is the sender's word (often an unsigned header): it goes with the event's data, not here.
    const [conn] = await db.select({ name: connection.name }).from(connection).where(eq(connection.id, run.source.connectionId));
    return `The connection "${conn?.name ?? "?"}" received an event.`;
  }
  if (!("created" in run.context)) return "The row changed.";
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
      void processRun(run)
        .catch(async (error) => {
          console.error("[agents] run failed", error);
          await finish(run, { status: "failed", code: "error", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        })
        .finally(() => {
          running.delete(run.id);
          // A slot is free: take what waits.
          setImmediate(() => void sweep());
        });
    }
  } catch (error) {
    console.error("[agents] could not run agents", error);
  }
}

/** Runs whose call no one answered in time fail, sending nothing. */
export async function expireApprovals() {
  try {
    const expired = await db
      .update(agentRun)
      .set({ status: "failed", code: "approvalTimeout", finishedAt: new Date(), state: null })
      .where(and(eq(agentRun.status, "awaiting_approval"), lte(agentRun.nextAt, new Date())))
      .returning({ id: agentRun.id, steps: agentRun.steps, pending: agentRun.pending });
    for (const run of expired) {
      const pending = run.pending;
      if (pending) {
        const step: AgentStepRecord = { kind: "tool", connectionId: pending.connectionId, tool: pending.tool, input: inputSummary(pending.arguments), outcome: "expired" };
        await db.update(agentRun).set({ steps: [...run.steps, step], pending: null }).where(eq(agentRun.id, run.id));
      }
      await withdrawApproval(run.id);
    }
  } catch (error) {
    console.error("[agents] could not expire approvals", error);
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
    .catch((error) => console.error("[agents] could not prune runs", error));
  await db
    .delete(connectionEvent)
    .where(lte(connectionEvent.receivedAt, new Date(Date.now() - CONNECTION_EVENT_DAYS * 24 * 60 * 60_000)))
    .catch((error) => console.error("[connections] could not prune events", error));
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
