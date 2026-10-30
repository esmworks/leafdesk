import { describe, expect, it } from "vitest";
import { aiLimitLine, FAST_TOKENS_WITHOUT_LIMIT, isAiLimitNotice, limitStage, NEW_AGENT_MS, spendingFast } from "./agent-guardrails";

describe("limitStage", () => {
  it("is near from 80% of the limit and reached at it", () => {
    expect(limitStage(799, 1000)).toBeNull();
    expect(limitStage(800, 1000)).toBe("near");
    expect(limitStage(999.5, 1000)).toBe("near");
    expect(limitStage(1000, 1000)).toBe("reached");
    expect(limitStage(5000, 1000)).toBe("reached");
  });

  it("says nothing without a limit", () => {
    expect(limitStage(10_000_000, null)).toBeNull();
    expect(limitStage(10, 0)).toBeNull();
  });
});

describe("spendingFast", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const madeAgo = (ms: number) => new Date(now.getTime() - ms);

  it("pauses a new agent past a quarter of its limit", () => {
    const agent = { createdAt: madeAgo(60 * 60 * 1000), monthlyTokenLimit: 400_000 };
    expect(spendingFast(agent, 100_000, now)).toBe(false);
    expect(spendingFast(agent, 100_001, now)).toBe(true);
  });

  it("takes two million tokens for a new agent without a limit", () => {
    const agent = { createdAt: madeAgo(1000), monthlyTokenLimit: null };
    expect(spendingFast(agent, FAST_TOKENS_WITHOUT_LIMIT, now)).toBe(false);
    expect(spendingFast(agent, FAST_TOKENS_WITHOUT_LIMIT + 1, now)).toBe(true);
  });

  it("leaves an agent a day old or more alone", () => {
    expect(spendingFast({ createdAt: madeAgo(NEW_AGENT_MS), monthlyTokenLimit: 1000 }, 1_000_000, now)).toBe(false);
  });
});

describe("isAiLimitNotice", () => {
  it("knows the stored notices only", () => {
    expect(isAiLimitNotice("paused")).toBe(true);
    expect(isAiLimitNotice("over")).toBe(false);
    expect(isAiLimitNotice(null)).toBe(false);
  });
});

describe("aiLimitLine", () => {
  it("names the workspace's lines when no agent is named", () => {
    expect(aiLimitLine("near", true)).toBe("near");
    expect(aiLimitLine("paused", true)).toBe("paused");
    expect(aiLimitLine("near", false)).toBe("workspaceNear");
    expect(aiLimitLine("reached", false)).toBe("workspaceReached");
  });
});
