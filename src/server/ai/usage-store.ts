/**
 * The database side of AI usage (see usage.ts): `ai_usage` rows by workspace, month, feature, model
 * and payer, and the owners' monthly limit from the workspace's settings. Loaded on demand.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiUsage, workspace } from "@/db/schema";
import { AI_USAGE_MONTHS } from "@/lib/ai-usage";
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
      // A workspace deleted while its request was under way: nothing left to count it under.
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === "23503" || (error as { cause?: { code?: string } }).cause?.code === "23503") return;
        throw error;
      });
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

/** Forgets months older than AI_USAGE_MONTHS (this one included), for the daily cleanup. */
export async function pruneAiUsage(now = new Date()): Promise<number> {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AI_USAGE_MONTHS - 1), 1));
  const deleted = await db.delete(aiUsage).where(lt(aiUsage.month, monthOf(oldest))).returning({ workspaceId: aiUsage.workspaceId });
  return deleted.length;
}
