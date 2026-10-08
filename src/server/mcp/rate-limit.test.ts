import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_RATE_LIMIT, mcpRateLimitFromEnv, rateLimitedResponse, takeMcpRequest } from "./rate-limit";

describe("mcpRateLimitFromEnv", () => {
  it("reads a whole number, 0 turning the limit off, and falls back on anything else", () => {
    expect(mcpRateLimitFromEnv(undefined)).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(mcpRateLimitFromEnv(" ")).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(mcpRateLimitFromEnv("30")).toBe(30);
    expect(mcpRateLimitFromEnv("0")).toBe(0);
    expect(mcpRateLimitFromEnv("-5")).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(mcpRateLimitFromEnv("lots")).toBe(DEFAULT_MCP_RATE_LIMIT);
  });
});

describe("takeMcpRequest", () => {
  it("allows the limit per user within a minute, then says how long to wait", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeMcpRequest("rl-user-a", 3, now + i)).toBe(0);
    expect(takeMcpRequest("rl-user-a", 3, now + 10)).toBe(60_000 - 10);
    // Another user has a budget of their own.
    expect(takeMcpRequest("rl-user-b", 3, now + 10)).toBe(0);
    // Once the window has passed the first request, one more fits.
    expect(takeMcpRequest("rl-user-a", 3, now + 60_001)).toBe(0);
  });

  it("never limits with 0", () => {
    for (let i = 0; i < 500; i++) expect(takeMcpRequest("rl-user-off", 0, 2_000_000)).toBe(0);
  });
});

describe("rateLimitedResponse", () => {
  it("answers 429 with Retry-After in whole seconds and a JSON-RPC error", async () => {
    const response = rateLimitedResponse(1_200, 120);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    expect(body.error.message).toContain("120 a minute");
  });
});
