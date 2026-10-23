/**
 * Settings > AI usage, for owners: what the workspace's AI cost by month, feature, model and
 * person, and where it stands against its monthly limits (see server/ai/usage.ts for how it's counted).
 */
import { aiLimitHit, summarizeAiUsage, summarizeAiUsageByPerson, type AiUsageReport } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import { requireMembership } from "@/server/access";
import { aiTargetFor } from "@/server/ai";
import { monthOf } from "@/server/ai/usage";
import { aiUsagePersonRows, aiUsageRows, databaseAiUsage } from "@/server/ai/usage-store";

export async function workspaceAiUsage(userId: string, workspaceId: string, now = new Date()): Promise<AiUsageReport> {
  await requireMembership(userId, workspaceId, "owner");
  const [rows, personRows, spent, target] = await Promise.all([
    aiUsageRows(workspaceId, now),
    aiUsagePersonRows(workspaceId, now),
    databaseAiUsage.spending(workspaceId, now),
    aiTargetFor(workspaceId),
  ]);
  const ownAccount = target?.accountId != null;
  const limit = { workspace: spent.limit, server: env.aiMonthlyLimitUsd };
  const spending = { totalUsd: spent.totalUsd, serverUsd: spent.serverUsd };
  const months = summarizeAiUsage(rows, monthOf(now).slice(0, 7));
  return {
    months,
    people: Object.fromEntries(months.map((m) => [m.month, summarizeAiUsageByPerson(personRows, m)])),
    limit,
    spent: spending,
    ownAccount,
    reached: aiLimitHit(limit, spending, { ownAccount }),
  };
}
