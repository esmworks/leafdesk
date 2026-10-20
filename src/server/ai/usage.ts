/**
 * What AI requests cost each workspace, and its monthly cost limit (see lib/ai-usage.ts). index.ts
 * holds every request to the limit before it is sent, then adds what it used to the workspace's
 * month (`ai_usage`, by feature and model): answers, failures the provider still billed, embeddings
 * and transcriptions alike. Only counts and cost are kept, never what was asked or answered.
 *
 * The limit is checked before each request, so requests under way at once can each finish past it:
 * a month can end up to AI_CONCURRENCY requests over (and a long chat answer's cost at most).
 *
 * The database side (usage-store.ts) is loaded on demand, so tests and scripts without a database
 * never load it; tests give the AI layer a ledger of their own (memoryAiUsageLedger) or none.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { aiLimitHit, type AiLimitHit, type AiUsageRow, ZERO_AI_USAGE } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import { AiError } from "./errors";

/** One request's usage, as index.ts hands it over. */
export type AiUsageEntry = {
  workspaceId: string;
  feature: string;
  model: string;
  /** Paid by the workspace's own AI account rather than the server's AI_* key. */
  ownAccount: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** Where usage goes and the month's spending comes from. */
export type AiUsageLedger = {
  record(entry: AiUsageEntry, now: Date): Promise<void>;
  /** The owners' limit and the month's spending so far: all of it, and what the server's key paid. */
  spending(workspaceId: string, now: Date): Promise<{ limit: number | null; totalUsd: number; serverUsd: number }>;
};

let storeModule: Promise<typeof import("./usage-store")> | undefined;
const databaseLedger = async (): Promise<AiUsageLedger> => (await (storeModule ??= import("./usage-store"))).databaseAiUsage;

/** The first day of `now`'s month (UTC), as `ai_usage.month` and `agent_usage.month` hold it. */
export function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** A pi-ai answer's usage as an entry's numbers. */
export const usageNumbers = (usage: Usage) => ({
  inputTokens: usage.input,
  cacheReadTokens: usage.cacheRead,
  cacheWriteTokens: usage.cacheWrite,
  outputTokens: usage.output,
  costUsd: usage.cost.total,
});

/**
 * Throws AiError "limitReached" when the workspace's month reached a limit that holds this request
 * (see aiLimitHit). `ledger` null: nothing is counted (tests without one).
 */
export async function holdToLimit(ledger: AiUsageLedger | null, workspaceId: string, ownAccount: boolean, now = new Date()): Promise<void> {
  if (!ledger) return;
  const server = env.aiMonthlyLimitUsd;
  const spent = await ledger.spending(workspaceId, now);
  const hit: AiLimitHit = aiLimitHit({ workspace: spent.limit, server }, spent, { ownAccount });
  if (hit) {
    throw new AiError(
      "limitReached",
      hit === "workspace" ? "The workspace reached its monthly AI cost limit" : "The workspace reached the server's monthly AI cost limit",
    );
  }
}

/** Adds a request's usage to its workspace's month; never fails the request (a failed write is logged). */
export function recordUsage(ledger: AiUsageLedger | null, entry: AiUsageEntry, now = new Date()): Promise<void> {
  if (!ledger || !entry.workspaceId) return Promise.resolve();
  return ledger.record(entry, now).catch((error: unknown) => {
    console.error(`[ai] could not record usage feature=${entry.feature} workspace=${entry.workspaceId}`, error instanceof Error ? error.message : error);
  });
}

/** The ledger requests are counted in: the database's, or for tests, theirs (null: none). */
export async function usageLedger(override: { usage?: AiUsageLedger } | undefined): Promise<AiUsageLedger | null> {
  if (override) return override.usage ?? null;
  return databaseLedger();
}

/** A ledger in memory, for tests: `limits` are the owners' limits by workspace. */
export function memoryAiUsageLedger(limits: Record<string, number | null> = {}) {
  const rows: (AiUsageRow & { workspaceId: string })[] = [];
  const ledger: AiUsageLedger & { rows: typeof rows; limits: typeof limits } = {
    rows,
    limits,
    async record(entry, now) {
      const month = monthOf(now).slice(0, 7);
      const { workspaceId, feature, model, ownAccount } = entry;
      let row = rows.find((r) => r.workspaceId === workspaceId && r.month === month && r.feature === feature && r.model === model && r.ownAccount === ownAccount);
      if (!row) rows.push((row = { workspaceId, month, feature, model, ownAccount, ...ZERO_AI_USAGE }));
      row.requests += 1;
      row.inputTokens += entry.inputTokens;
      row.cacheReadTokens += entry.cacheReadTokens;
      row.cacheWriteTokens += entry.cacheWriteTokens;
      row.outputTokens += entry.outputTokens;
      row.costUsd += entry.costUsd;
    },
    async spending(workspaceId, now) {
      const month = monthOf(now).slice(0, 7);
      const mine = rows.filter((r) => r.workspaceId === workspaceId && r.month === month);
      return {
        limit: limits[workspaceId] ?? null,
        totalUsd: mine.reduce((n, r) => n + r.costUsd, 0),
        serverUsd: mine.filter((r) => !r.ownAccount).reduce((n, r) => n + r.costUsd, 0),
      };
    },
  };
  return ledger;
}
