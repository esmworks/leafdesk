/**
 * When AI spending gets a word to the workspace's owners (server/ai-limit-notices.ts): near a
 * month's limit, at it, and an agent new enough to be still set up wrong spending fast. Pure, for
 * the server, the inbox and the tests.
 */

/** The share of a month's limit at which owners hear the limit is near. */
export const LIMIT_NEAR_SHARE = 0.8;

/** How long an agent counts as new: spending fast in this time pauses it. */
export const NEW_AGENT_MS = 24 * 60 * 60 * 1000;

/** Spending fast for a new agent without a limit: this many tokens in its first day. */
export const FAST_TOKENS_WITHOUT_LIMIT = 2_000_000;

/** A new agent with a limit is spending fast past this share of it. */
export const FAST_LIMIT_SHARE = 0.25;

/** What an "ai_limit" inbox item says happened (notification.message). */
export const AI_LIMIT_NOTICES = ["near", "reached", "paused", "raised", "declined"] as const;
export type AiLimitNotice = (typeof AI_LIMIT_NOTICES)[number];
export const isAiLimitNotice = (value: unknown): value is AiLimitNotice => (AI_LIMIT_NOTICES as readonly unknown[]).includes(value);

/** Where a month's use stands against its limit: null below LIMIT_NEAR_SHARE, or without a limit. */
export function limitStage(used: number, limit: number | null): "near" | "reached" | null {
  if (limit === null || !(limit > 0)) return null;
  if (used >= limit) return "reached";
  return used >= limit * LIMIT_NEAR_SHARE ? "near" : null;
}

/**
 * Whether an agent is new and spending fast: made less than NEW_AGENT_MS ago, its month's tokens
 * (all it used since it was made, unless a month began in between) went past a quarter of its
 * monthly limit, or past FAST_TOKENS_WITHOUT_LIMIT when it has none.
 */
export function spendingFast(agent: { createdAt: Date; monthlyTokenLimit: number | null }, monthTokens: number, now = new Date()): boolean {
  if (now.getTime() - agent.createdAt.getTime() >= NEW_AGENT_MS) return false;
  const line = agent.monthlyTokenLimit === null ? FAST_TOKENS_WITHOUT_LIMIT : agent.monthlyTokenLimit * FAST_LIMIT_SHARE;
  return monthTokens > line;
}

/**
 * Which line an "ai_limit" item reads as, in the inbox and in push messages: the notice itself
 * about an agent, or the workspace's cost limit near or reached (`agent` false).
 */
export function aiLimitLine(notice: AiLimitNotice, agent: boolean) {
  if (agent) return notice;
  return notice === "reached" ? "workspaceReached" : "workspaceNear";
}

/** Where an "ai_limit" item leads: the agent, or the workspace's AI usage in Settings. */
export const aiLimitPath = (workspaceId: string, agentId: string | null) =>
  agentId ? `/w/${workspaceId}/settings?tab=agents&agent=${agentId}` : `/w/${workspaceId}/settings?tab=aiUsage`;

/** The most characters of the reason a request for a higher agent limit gives. */
export const MAX_LIMIT_REQUEST_NOTE = 500;

/** A request for a higher agent limit that waits for the owners (server/agents/limits.ts). */
export type AgentLimitRequestView = { id: string; tokens: number; note: string; createdAt: string };
