/**
 * The database side of AI usage (see usage.ts): `ai_usage` rows by workspace, month, feature, model
 * and payer, `ai_usage_person` rows by who asked and feature, and the owners' monthly limit from
 * the workspace's settings. Loaded on demand.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiUsage, aiUsagePerson, user, workspace, workspaceAgent } from "@/db/schema";
import { AI_USAGE_MONTHS, type AiUsagePersonRow } from "@/lib/ai-usage";
import { monthOf, type AiUsageLedger } from "./usage";

export const databaseAiUsage: AiUsageLedger = {
  async record(entry, now) {
    const values = {
      workspaceId: entry.workspaceId,
      month: monthOf(now),
      feature: entry.feature.slice(0, 100),
      model: entry.model.slice(0, 200),
      ownAccount: entry.ownAccount,
      requests: 1,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
    };
    // A workspace (or person) deleted while its request was under way: nothing left to count it under.
    const gone = (error: unknown) => {
      if ((error as { code?: string }).code === "23503" || (error as { cause?: { code?: string } }).cause?.code === "23503") return;
      throw error;
    };
    await db
      .insert(aiUsage)
      .values(values)
      .onConflictDoUpdate({
        target: [aiUsage.workspaceId, aiUsage.month, aiUsage.feature, aiUsage.model, aiUsage.ownAccount],
        set: {
          requests: sql`${aiUsage.requests} + 1`,
          inputTokens: sql`${aiUsage.inputTokens} + ${values.inputTokens}`,
          cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${values.cacheReadTokens}`,
          cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${values.cacheWriteTokens}`,
          outputTokens: sql`${aiUsage.outputTokens} + ${values.outputTokens}`,
          costUsd: sql`${aiUsage.costUsd} + ${values.costUsd}`,
        },
      })
      .catch(gone);
    const { model: _model, ownAccount: _own, ...counts } = values;
    await db
      .insert(aiUsagePerson)
      .values({ ...counts, userId: entry.userId ?? null })
      .onConflictDoUpdate({
        // The key treats nulls as equal (NULLS NOT DISTINCT): nobody's requests add up in one row.
        target: [aiUsagePerson.workspaceId, aiUsagePerson.month, aiUsagePerson.userId, aiUsagePerson.feature],
        set: {
          requests: sql`${aiUsagePerson.requests} + 1`,
          inputTokens: sql`${aiUsagePerson.inputTokens} + ${values.inputTokens}`,
          cacheReadTokens: sql`${aiUsagePerson.cacheReadTokens} + ${values.cacheReadTokens}`,
          cacheWriteTokens: sql`${aiUsagePerson.cacheWriteTokens} + ${values.cacheWriteTokens}`,
          outputTokens: sql`${aiUsagePerson.outputTokens} + ${values.outputTokens}`,
          costUsd: sql`${aiUsagePerson.costUsd} + ${values.costUsd}`,
        },
      })
      .catch(gone);
  },

  async spending(workspaceId, now) {
    const month = monthOf(now);
    const [row] = await db
      .select({
        limit: sql<number | null>`(${workspace.settings} ->> 'aiMonthlyLimitUsd')::float8`,
        totalUsd: sql<number>`coalesce((select sum(${aiUsage.costUsd}) from ${aiUsage} where ${aiUsage.workspaceId} = ${workspace.id} and ${aiUsage.month} = ${month}), 0)`.mapWith(Number),
        serverUsd: sql<number>`coalesce((select sum(${aiUsage.costUsd}) from ${aiUsage} where ${aiUsage.workspaceId} = ${workspace.id} and ${aiUsage.month} = ${month} and not ${aiUsage.ownAccount}), 0)`.mapWith(Number),
      })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    return { limit: row?.limit ?? null, totalUsd: row?.totalUsd ?? 0, serverUsd: row?.serverUsd ?? 0 };
  },
};

/** A workspace's stored rows of the months the usage view shows. */
export async function aiUsageRows(workspaceId: string, now = new Date()) {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AI_USAGE_MONTHS - 1), 1));
  const rows = await db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), sql`${aiUsage.month} >= ${monthOf(oldest)}`));
  return rows.map(({ workspaceId: _, month, ...rest }) => ({ ...rest, month: month.slice(0, 7) }));
}

/**
 * A workspace's rows by person of the months the usage view shows, each with who it was: their
 * name, and the agent when the user is one (an agent is its own user). Null user: nobody asked.
 */
export async function aiUsagePersonRows(workspaceId: string, now = new Date()): Promise<AiUsagePersonRow[]> {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AI_USAGE_MONTHS - 1), 1));
  const rows = await db
    .select()
    .from(aiUsagePerson)
    .where(and(eq(aiUsagePerson.workspaceId, workspaceId), sql`${aiUsagePerson.month} >= ${monthOf(oldest)}`));
  const ids = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
  const [people, agents] = ids.length
    ? await Promise.all([
        db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ids)),
        db
          .select({ id: workspaceAgent.id, userId: workspaceAgent.userId, name: workspaceAgent.name })
          .from(workspaceAgent)
          .where(and(eq(workspaceAgent.workspaceId, workspaceId), inArray(workspaceAgent.userId, ids))),
      ])
    : [[], []];
  const names = new Map(people.map((p) => [p.id, p.name.trim() || p.email]));
  const agentOf = new Map(agents.map((a) => [a.userId, a]));
  return rows.map(({ workspaceId: _, month, userId, ...rest }) => {
    const agent = userId ? agentOf.get(userId) : undefined;
    return {
      ...rest,
      month: month.slice(0, 7),
      userId,
      name: agent?.name ?? (userId ? (names.get(userId) ?? null) : null),
      agentId: agent?.id ?? null,
    };
  });
}

/** Forgets months older than AI_USAGE_MONTHS (this one included), for the daily cleanup. */
export async function pruneAiUsage(now = new Date()): Promise<number> {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AI_USAGE_MONTHS - 1), 1));
  const deleted = await db.delete(aiUsage).where(lt(aiUsage.month, monthOf(oldest))).returning({ workspaceId: aiUsage.workspaceId });
  await db.delete(aiUsagePerson).where(lt(aiUsagePerson.month, monthOf(oldest)));
  return deleted.length;
}
