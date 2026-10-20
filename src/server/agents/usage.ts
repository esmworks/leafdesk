/**
 * What agents' runs use, by calendar month (UTC): the run worker adds each turn with the model as
 * it comes back (`agent_usage`), so a run that fails or times out still counts what it used; owners
 * read the months, and an agent's monthly token limit stops its runs once the month reaches it.
 *
 * The limit is checked before each turn, so several runs of one agent under way at once can each
 * take one more turn past it (at most AI_CONCURRENCY turns over).
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentUsage } from "@/db/schema";
import { AGENT_USAGE_MONTHS, type AgentUsageMonth } from "@/lib/agents";
import { monthOf } from "@/server/ai/usage";

export { monthOf };
import { ownedAgent } from "./manage";


/** Adds to the agent's usage for the month of `now`. */
export async function addAgentUsage(agentId: string, used: { runs?: number; inputTokens: number; outputTokens: number; costUsd: number }, now = new Date()) {
  const runs = used.runs ?? 0;
  await db
    .insert(agentUsage)
    .values({ agentId, month: monthOf(now), runs, inputTokens: used.inputTokens, outputTokens: used.outputTokens, costUsd: used.costUsd })
    .onConflictDoUpdate({
      target: [agentUsage.agentId, agentUsage.month],
      set: {
        runs: sql`${agentUsage.runs} + ${runs}`,
        inputTokens: sql`${agentUsage.inputTokens} + ${used.inputTokens}`,
        outputTokens: sql`${agentUsage.outputTokens} + ${used.outputTokens}`,
        costUsd: sql`${agentUsage.costUsd} + ${used.costUsd}`,
      },
    });
}

/** Whether the agent's runs used its monthly token limit (none set: never). */
export async function overMonthlyLimit(agent: { id: string; monthlyTokenLimit: number | null }, now = new Date()): Promise<boolean> {
  if (agent.monthlyTokenLimit === null) return false;
  const [row] = await db
    .select({ tokens: sql<number>`${agentUsage.inputTokens} + ${agentUsage.outputTokens}`.mapWith(Number) })
    .from(agentUsage)
    .where(and(eq(agentUsage.agentId, agent.id), eq(agentUsage.month, monthOf(now))));
  return (row?.tokens ?? 0) >= agent.monthlyTokenLimit;
}

const view = (row: typeof agentUsage.$inferSelect): AgentUsageMonth => ({
  month: row.month.slice(0, 7),
  runs: row.runs,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  costUsd: row.costUsd,
});

/**
 * An agent's usage by month, newest first, for its owners: this month always (at zero when its
 * runs used nothing yet), and the earlier months it ran in, AGENT_USAGE_MONTHS in all at most.
 */
export async function agentUsageMonths(userId: string, agentId: string, now = new Date()): Promise<AgentUsageMonth[]> {
  const agent = await ownedAgent(userId, agentId);
  return usageMonthsOf(agent.id, now);
}

/** agentUsageMonths for an agent the caller already found its owner may see. */
export async function usageMonthsOf(agentId: string, now = new Date()): Promise<AgentUsageMonth[]> {
  const rows = await db.select().from(agentUsage).where(eq(agentUsage.agentId, agentId)).orderBy(desc(agentUsage.month)).limit(AGENT_USAGE_MONTHS);
  const months = rows.map(view);
  const current = monthOf(now).slice(0, 7);
  if (months[0]?.month !== current) months.unshift({ month: current, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  return months.slice(0, AGENT_USAGE_MONTHS);
}

/** Forgets months older than AGENT_USAGE_MONTHS (this one included), for the daily cleanup. */
export async function pruneAgentUsage(now = new Date()): Promise<number> {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AGENT_USAGE_MONTHS - 1), 1));
  const deleted = await db.delete(agentUsage).where(lt(agentUsage.month, monthOf(oldest))).returning({ agentId: agentUsage.agentId });
  return deleted.length;
}
