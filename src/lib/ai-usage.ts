// Client-safe: what the workspace's AI usage view and its monthly cost limit share with the server
// (server/ai/usage.ts records usage and holds requests to the limit).

/** Months of AI usage kept and shown, this one included. */
export const AI_USAGE_MONTHS = 12;

/** The highest monthly limit an owner may set, in US dollars. */
export const MAX_AI_MONTHLY_LIMIT_USD = 1_000_000;

/**
 * A monthly cost limit as typed or stored: a positive number of US dollars (rounded to cents) up to
 * MAX_AI_MONTHLY_LIMIT_USD, null for none (null or an empty string), undefined when it is neither.
 */
export function parseAiMonthlyLimit(value: unknown): number | null | undefined {
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const cents = Math.round(n * 100) / 100;
  return cents > 0 && cents <= MAX_AI_MONTHLY_LIMIT_USD ? cents : undefined;
}

/** The groups the usage view adds features up in, each named in the view. */
export const AI_USAGE_GROUPS = ["chat", "writing", "properties", "agents", "search", "voice", "other"] as const;
export type AiUsageGroup = (typeof AI_USAGE_GROUPS)[number];

/** The group of an AiRequest feature ("editor.improve", "property.summary", "chat", "agent", …). */
export function aiUsageGroup(feature: string): AiUsageGroup {
  const family = feature.split(".")[0];
  switch (family) {
    case "chat":
      return "chat";
    case "editor":
      return "writing";
    case "property":
      return "properties";
    case "agent":
      return "agents";
    case "search":
      return "search";
    case "voice":
      return "voice";
    default:
      return "other";
  }
}

/** What some requests used: tokens by kind (input without the prompt cache's) and cost in US dollars. */
export type AiUsageTotals = {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
};

export const ZERO_AI_USAGE: AiUsageTotals = { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };

/** One stored row: a month's usage of one feature on one model, by one payer. */
export type AiUsageRow = AiUsageTotals & { month: string; feature: string; model: string; ownAccount: boolean };

/** A month of the usage view ("2026-10"), its total and its lines by feature group and model, costliest first. */
export type AiUsageMonth = {
  month: string;
  total: AiUsageTotals;
  /** What the workspace's own AI account paid of `total`. */
  ownAccountCostUsd: number;
  byGroup: (AiUsageTotals & { group: AiUsageGroup })[];
  byModel: (AiUsageTotals & { model: string })[];
};

export type AiLimitView = {
  /** The owners' limit (Settings), null for none. */
  workspace: number | null;
  /** The server's limit on what its own AI key pays (AI_MONTHLY_LIMIT_USD), null for none. */
  server: number | null;
};

export type AiUsageReport = {
  months: AiUsageMonth[];
  limit: AiLimitView;
  /** This month's spending against the limits: all of it, and what the server's key paid. */
  spent: { totalUsd: number; serverUsd: number };
  /** Whether the workspace's AI runs on its own AI account now (the server's limit doesn't hold it). */
  ownAccount: boolean;
  /** Which limit stops the workspace's AI now, if one does. */
  reached: AiLimitHit;
};

const add = (into: AiUsageTotals, row: AiUsageTotals) => {
  into.requests += row.requests;
  into.inputTokens += row.inputTokens;
  into.cacheReadTokens += row.cacheReadTokens;
  into.cacheWriteTokens += row.cacheWriteTokens;
  into.outputTokens += row.outputTokens;
  into.costUsd += row.costUsd;
};

const byCost = <T extends AiUsageTotals>(a: T, b: T) => b.costUsd - a.costUsd || b.requests - a.requests;

/**
 * The months of the view, newest first, from stored rows: `current` ("2026-10") always, at zero when
 * nothing was used yet, then the earlier months with usage, AI_USAGE_MONTHS in all at most.
 */
export function summarizeAiUsage(rows: AiUsageRow[], current: string): AiUsageMonth[] {
  const months = new Map<string, { total: AiUsageTotals; own: number; groups: Map<AiUsageGroup, AiUsageTotals>; models: Map<string, AiUsageTotals> }>();
  const monthOf = (month: string) => {
    let m = months.get(month);
    if (!m) months.set(month, (m = { total: { ...ZERO_AI_USAGE }, own: 0, groups: new Map(), models: new Map() }));
    return m;
  };
  monthOf(current);
  for (const row of rows) {
    const m = monthOf(row.month);
    add(m.total, row);
    if (row.ownAccount) m.own += row.costUsd;
    const group = aiUsageGroup(row.feature);
    if (!m.groups.has(group)) m.groups.set(group, { ...ZERO_AI_USAGE });
    add(m.groups.get(group)!, row);
    if (!m.models.has(row.model)) m.models.set(row.model, { ...ZERO_AI_USAGE });
    add(m.models.get(row.model)!, row);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, AI_USAGE_MONTHS)
    .map(([month, m]) => ({
      month,
      total: m.total,
      ownAccountCostUsd: m.own,
      byGroup: [...m.groups.entries()].map(([group, totals]) => ({ group, ...totals })).sort(byCost),
      byModel: [...m.models.entries()].map(([model, totals]) => ({ model, ...totals })).sort(byCost),
    }));
}

/** Which limit a request would go past: the owners' ("workspace"), the server's ("server"), or none. */
export type AiLimitHit = "workspace" | "server" | null;

/**
 * Whether the workspace's AI may send another request this month. The owners' limit counts all of
 * the month's spending, whoever paid; the server's counts only what its own AI key paid, and only
 * holds back requests that key would pay (`ownAccount` false): a workspace on its own AI account
 * spends its own money.
 */
export function aiLimitHit(
  limit: AiLimitView,
  spent: { totalUsd: number; serverUsd: number },
  request: { ownAccount: boolean },
): AiLimitHit {
  if (limit.workspace !== null && spent.totalUsd >= limit.workspace) return "workspace";
  if (!request.ownAccount && limit.server !== null && spent.serverUsd >= limit.server) return "server";
  return null;
}
