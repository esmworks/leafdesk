import { sharedLimiter, takeAll } from "@/lib/rate-limit";

/** Requests per user per minute to /mcp when MCP_RATE_LIMIT isn't set. */
export const DEFAULT_MCP_RATE_LIMIT = 120;
const WINDOW_MS = 60_000;

/** MCP_RATE_LIMIT: requests per user per minute to /mcp; 0 turns the limit off. */
export function mcpRateLimitFromEnv(value = process.env.MCP_RATE_LIMIT): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MCP_RATE_LIMIT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MCP_RATE_LIMIT;
}

/**
 * Takes one request from the user's budget: every app they connected counts against the same one,
 * so a runaway client can't hammer the server by connecting twice. Returns how many milliseconds
 * to wait when the budget is used up, else 0.
 */
export function takeMcpRequest(userId: string, limit = mcpRateLimitFromEnv(), now = Date.now()): number {
  if (limit <= 0) return 0;
  return takeAll([[sharedLimiter("mcp", limit, WINDOW_MS), userId]], now);
}

/** The answer to a request over the limit: HTTP 429 with a JSON-RPC error and Retry-After. */
export function rateLimitedResponse(waitMs: number, limit = mcpRateLimitFromEnv()) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const message = `Too many requests: at most ${limit} a minute per user. Try again in ${seconds} seconds.`;
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(seconds) },
  });
}
