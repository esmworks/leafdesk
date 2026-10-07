/**
 * The agents' worker: takes queued runs (`agent_run`, queued by an automation's "Run an agent"
 * action) and does them, as the agent's own user, with the access it has now. A few run at a time
 * (AI_CONCURRENCY), each within its workspace's AI allowance (a run waits for its turn rather than
 * failing), and apart from the automations' worker, so a long run never holds up a webhook.
 *
 * A run is a short conversation with the model: the agent's instructions, what happened, the row
 * and a map of what the agent can open, then up to MAX_AGENT_ROUNDS turns of tools. With no one
 * to approve anything, the tools are narrow: reading what is shared with the agent, and changing
 * or commenting on the row that started the run, at most MAX_AGENT_WRITES times. Changes it makes
 * start no automations (`asAutomation`), so agents can't set each other off.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, page, user, workspaceAgent } from "@/db/schema";
import {
  AGENT_RUN_HISTORY_DAYS,
  AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_PROMPT,
  MAX_AGENT_ROUNDS,
  MAX_AGENT_WRITES,
  type AgentRunCode,
  type AgentRunContext,
  type AgentRunSource,
  type AgentRunUsage,
  type AgentStepRecord,
} from "@/lib/agents";
import { pageLabel } from "@/lib/labels";
import { AccessError, pageAccessOf } from "@/server/access";
import { aiConfig, AiError, complete, isAiError, takeWorkspaceCapacity, type AiMessage, type AiTool } from "@/server/ai";
import { agentSystemPrompt, agentTaskPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { applyWrite, CHAT_TOOLS, prepareWrite, runTool, workspaceMap, WRITE_TOOLS, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { asAutomation } from "@/server/automations/queue";
import { changeComments } from "@/server/comments";
import { getProperties } from "@/server/databases";
import type * as ops from "@/server/operations";

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
export const AGENT_TOOLS: AiTool[] = [...CHAT_TOOLS, UPDATE_ROW, ADD_COMMENT];

// ------------------------------------------------------------------------------------ queue

type State = { kick?: () => void };
const g = globalThis as typeof globalThis & { __leafdeskAgents?: State };
const state: State = (g.__leafdeskAgents ??= {});

/** Queues a run of an agent; the worker takes it at once (or at its next sweep). */
export async function queueAgentRun(input: {
  agentId: string;
  workspaceId: string;
  source: AgentRunSource;
  context: AgentRunContext;
  prompt: string;
}): Promise<string> {
  const [run] = await db
    .insert(agentRun)
    .values({ ...input, prompt: input.prompt.slice(0, MAX_AGENT_PROMPT) })
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

async function finish(run: Run, values: { status: "done" | "failed"; code?: AgentRunCode | null; error?: string | null; steps?: AgentStepRecord[]; answer?: string; usage?: AgentRunUsage | null }) {
  await db
    .update(agentRun)
    .set({
      status: values.status,
      code: values.code ?? null,
      error: values.error?.slice(0, 500) ?? null,
      ...(values.steps ? { steps: values.steps } : {}),
      ...(values.answer !== undefined ? { answer: values.answer.slice(0, 8_000) } : {}),
      ...(values.usage !== undefined ? { usage: values.usage } : {}),
      finishedAt: new Date(),
    })
    .where(eq(agentRun.id, run.id));
}

/** Puts a run back to wait (for the workspace's AI allowance) until `at`. */
async function later(run: Run, at: Date) {
  await db.update(agentRun).set({ status: "pending", nextAt: at }).where(eq(agentRun.id, run.id));
}

// -------------------------------------------------------------------------------------- run

/** Does one run and saves how it went. */
export async function processRun(run: Run): Promise<void> {
  const [agent] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, run.agentId));
  if (!agent || agent.archivedAt || !agent.enabled) return finish(run, { status: "failed", code: "agentDisabled" });
  if (run.attempts > MAX_CLAIMS) return finish(run, { status: "failed", code: "tooManyAttempts" });
  if (!(await aiAvailable(run.workspaceId))) return finish(run, { status: "failed", code: "aiOff" });

  const { rowId, databaseId } = run.source;
  const [row] = await db.select({ id: page.id, parentId: page.parentId, archivedAt: page.archivedAt }).from(page).where(eq(page.id, rowId));
  if (!row || row.archivedAt || row.parentId !== databaseId) return finish(run, { status: "failed", code: "rowGone" });
  const { level } = await pageAccessOf(agent.userId, rowId);
  if (level === "none") return finish(run, { status: "failed", code: "noAccess" });

  const wait = takeWorkspaceCapacity(run.workspaceId);
  if (wait > 0) return later(run, new Date(Date.now() + wait));

  const outcome = await converse(agent, run).catch((error: unknown) => ({ error }));
  if ("error" in outcome) {
    const error = outcome.error;
    if (isAiError(error) && error.code === "rateLimited") return later(run, new Date(Date.now() + (error.retryAfterMs ?? 30_000)));
    const code: AgentRunCode = isAiError(error) ? (error.code === "aborted" || error.code === "timeout" ? "timeout" : "provider") : "error";
    if (!isAiError(error)) console.error("[agents] run failed", error);
    return finish(run, { status: "failed", code, error: error instanceof Error ? error.message : String(error) });
  }
  return finish(run, outcome);
}

/** The run's turns with the model; what it did, and how it ended. */
async function converse(agent: Agent, run: Run) {
  const ctx: ops.OperationContext = { userId: agent.userId, actor: { userId: agent.userId } };
  const { rowId } = run.source;
  const limits = aiConfig().limits;
  const signal = AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS);
  const system = agentSystemPrompt(agent);
  const toolsSize = AGENT_TOOLS.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  const room = (messages: AiMessage[]) => limits.maxInputChars - system.length - toolsSize - messages.reduce((n, m) => n + m.content.length, 0) - 300;

  const registry: Registry = { sources: [], byKey: new Map() };
  const steps: AgentStepRecord[] = [];
  const usage: AgentRunUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, rounds: 0 };

  // The row, read as the agent (its values as the agent may see them), as source 1.
  const read = await runTool(ctx, run.workspaceId, undefined, { name: "read_page", arguments: { page_id: rowId } }, registry, Math.min(8_000, room([])));
  if (read.isError) return { status: "failed" as const, code: "noAccess" as const, steps, usage };
  const map = await workspaceMap(ctx, run.workspaceId, null, MAP_CHARS);
  const messages: AiMessage[] = [{ role: "user", content: agentTaskPrompt({ task: run.prompt, event: await eventText(run), row: read.content, map }) }];

  let writes = 0;
  let answer = "";
  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (round > 0) {
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
      tools: AGENT_TOOLS,
      signal,
      sessionId: run.id,
    });
    usage.rounds += 1;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;
    if (!result.toolCalls.length || last) {
      answer = result.text;
      break;
    }
    const thought = result.text.replace(/\s+/g, " ").trim();
    if (thought) steps.push({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
    messages.push(result.message);
    for (const call of result.toolCalls) {
      let out: ToolOutcome | { content: string; isError?: boolean; step?: AgentStepRecord };
      if (call.name === "update_row" || call.name === "add_comment") {
        if (writes >= MAX_AGENT_WRITES) out = { content: `You have made ${MAX_AGENT_WRITES} changes, the most one run may make. Finish now.`, isError: true };
        else {
          out = call.name === "update_row" ? await updateRow(ctx, run, call) : await addComment(agent, rowId, call.arguments);
          if (!out.isError) writes += 1;
        }
      } else out = await runTool(ctx, run.workspaceId, undefined, call, registry, room(messages));
      if (out.step) steps.push(out.step);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.content, isError: out.isError });
    }
  }
  return { status: "done" as const, steps, answer, usage };
}

/** update_row, on the run's row only, made at once (no one to ask) and starting no automations. */
async function updateRow(ctx: ops.OperationContext, run: Run, call: { name: string; arguments: Record<string, unknown> }): Promise<ToolOutcome> {
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
async function addComment(agent: Agent, rowId: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean; step?: AgentStepRecord }> {
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

/** What happened, in words: the row added or the properties changed, and by whom. */
async function eventText(run: Run) {
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

async function sweep() {
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

/** Finished runs older than AGENT_RUN_HISTORY_DAYS go. */
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
