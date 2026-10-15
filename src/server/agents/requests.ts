/**
 * Runs an owner asks for (REST API, MCP): an agent does a task the owner gives it, on a row of a
 * database or on none, held to the owner's access as well as its own (as a row's run is held to
 * the member whose change started it). On a row it may change and comment on that row; on none it
 * only reads, and its answer is what it found or did.
 *
 * Asking is refused rather than queued when the run couldn't do anything: a paused or archived
 * agent, AI off for the workspace, the month's tokens used up, or MAX_REQUESTED_RUNS of the agent's
 * asked-for runs still waiting or under way.
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { agentRun, page } from "@/db/schema";
import { MAX_AGENT_PROMPT, MAX_REQUESTED_RUNS, type AgentRunVia, type AgentRunView } from "@/lib/agents";
import { pageAccessOf } from "@/server/access";
import { aiAvailable } from "@/server/ai-writing";
import { recordAudit } from "@/server/audit";
import { AgentError, getAgentRun, ownedAgent } from "./manage";
import { queueAgentRun } from "./run";
import { overMonthlyLimit } from "./usage";

export type AgentRunRequest = {
  task: string;
  /** A row of a database in the agent's workspace the owner can open. */
  rowId?: string | null;
  via: AgentRunVia;
};

/** Queues a run of the agent with the owner's task; returns it as listAgentRuns shows it (pending). */
export async function requestAgentRun(userId: string, agentId: string, request: AgentRunRequest): Promise<AgentRunView> {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to run it");
  if (!agent.enabled) throw new AgentError("paused", "Turn the agent on to run it");
  const task = typeof request.task === "string" ? request.task.trim() : "";
  if (!task) throw new AgentError("invalid", "A run needs a task", { reason: "task" });
  if (task.length > MAX_AGENT_PROMPT) throw new AgentError("invalid", `A task has at most ${MAX_AGENT_PROMPT} characters`, { reason: "taskLength" });

  let row: { rowId: string; databaseId: string } | null = null;
  if (request.rowId) {
    const database = alias(page, "database");
    const [found] = await db
      .select({ id: page.id, databaseId: database.id })
      .from(page)
      .innerJoin(database, and(eq(database.id, page.parentId), eq(database.kind, "database")))
      .where(and(eq(page.id, request.rowId), eq(page.workspaceId, agent.workspaceId), isNull(page.archivedAt)))
      .limit(1);
    if (!found || (await pageAccessOf(userId, found.id)).level === "none") throw new AgentError("notARow", "Row not found");
    row = { rowId: found.id, databaseId: found.databaseId };
  }

  if (!(await aiAvailable(agent.workspaceId))) throw new AgentError("aiOff", "AI is off for this workspace");
  if (await overMonthlyLimit(agent)) throw new AgentError("limitReached", "The agent used its tokens for this month", { limit: String(agent.monthlyTokenLimit) });
  const [waiting] = await db
    .select({ n: count() })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.agentId, agent.id),
        inArray(agentRun.status, ["pending", "running", "awaiting_approval"]),
        sql`${agentRun.source}->>'kind' = 'request'`,
      ),
    );
  if ((waiting?.n ?? 0) >= MAX_REQUESTED_RUNS) throw new AgentError("tooManyRuns", "Too many runs of this agent are waiting", { max: String(MAX_REQUESTED_RUNS) });

  const runId = await queueAgentRun({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    source: { kind: "request", requestedBy: userId, via: request.via, ...(row ?? {}) },
    context: { actorId: userId },
    prompt: task,
  });
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.run_requested",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { name: agent.name, runId, ...(row ? { rowId: row.rowId } : {}) },
  });
  return getAgentRun(userId, agent.id, runId);
}
