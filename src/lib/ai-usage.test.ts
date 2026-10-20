import { describe, expect, it } from "vitest";
import { aiLimitHit, aiUsageGroup, AI_USAGE_MONTHS, parseAiMonthlyLimit, summarizeAiUsage, ZERO_AI_USAGE, type AiUsageRow } from "./ai-usage";

const row = (over: Partial<AiUsageRow>): AiUsageRow => ({ ...ZERO_AI_USAGE, month: "2026-10", feature: "chat", model: "m", ownAccount: false, ...over });

describe("a monthly cost limit", () => {
  it("is a positive amount in cents, or none", () => {
    expect(parseAiMonthlyLimit(25)).toBe(25);
    expect(parseAiMonthlyLimit("12.345")).toBe(12.35);
    expect(parseAiMonthlyLimit(" 40 ")).toBe(40);
    expect(parseAiMonthlyLimit(null)).toBeNull();
    expect(parseAiMonthlyLimit("")).toBeNull();
    for (const bad of [0, -5, "0", "abc", "1e3", "-1", Number.NaN, Infinity, 2_000_000, true, {}]) {
      expect(parseAiMonthlyLimit(bad)).toBeUndefined();
    }
  });

  it("holds the owners' limit against all spending and the server's against its own key's", () => {
    const none = { workspace: null, server: null };
    expect(aiLimitHit(none, { totalUsd: 1e6, serverUsd: 1e6 }, { ownAccount: false })).toBeNull();
    expect(aiLimitHit({ workspace: 10, server: null }, { totalUsd: 10, serverUsd: 0 }, { ownAccount: true })).toBe("workspace");
    expect(aiLimitHit({ workspace: 10, server: null }, { totalUsd: 9.99, serverUsd: 9.99 }, { ownAccount: false })).toBeNull();
    expect(aiLimitHit({ workspace: null, server: 5 }, { totalUsd: 20, serverUsd: 5 }, { ownAccount: false })).toBe("server");
    // A workspace on its own AI account spends its own money: the server's limit doesn't hold it.
    expect(aiLimitHit({ workspace: null, server: 5 }, { totalUsd: 20, serverUsd: 5 }, { ownAccount: true })).toBeNull();
    expect(aiLimitHit({ workspace: null, server: 5 }, { totalUsd: 20, serverUsd: 4 }, { ownAccount: false })).toBeNull();
  });
});

describe("the usage view", () => {
  it("groups features", () => {
    expect(aiUsageGroup("chat")).toBe("chat");
    expect(aiUsageGroup("editor.improve")).toBe("writing");
    expect(aiUsageGroup("property.summary")).toBe("properties");
    expect(aiUsageGroup("agent")).toBe("agents");
    expect(aiUsageGroup("search.index")).toBe("search");
    expect(aiUsageGroup("voice.transcribe")).toBe("voice");
    expect(aiUsageGroup("something.new")).toBe("other");
  });

  it("adds up months by feature group and model, newest and costliest first", () => {
    const months = summarizeAiUsage(
      [
        row({ feature: "editor.improve", model: "a", requests: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.5 }),
        row({ feature: "editor.fix", model: "b", requests: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.25 }),
        row({ feature: "chat", model: "a", ownAccount: true, requests: 3, cacheReadTokens: 900, costUsd: 2 }),
        row({ month: "2026-08", feature: "agent", model: "a", requests: 1, costUsd: 1 }),
      ],
      "2026-10",
    );
    expect(months.map((m) => m.month)).toEqual(["2026-10", "2026-08"]);
    const [october] = months;
    expect(october.total).toMatchObject({ requests: 6, inputTokens: 110, outputTokens: 55, cacheReadTokens: 900, costUsd: 2.75 });
    expect(october.ownAccountCostUsd).toBe(2);
    expect(october.byGroup.map((g) => [g.group, g.requests, g.costUsd])).toEqual([
      ["chat", 3, 2],
      ["writing", 3, 0.75],
    ]);
    expect(october.byModel.map((m) => [m.model, m.costUsd])).toEqual([
      ["a", 2.5],
      ["b", 0.25],
    ]);
  });

  it("always has this month, at zero before anything was used, and at most AI_USAGE_MONTHS", () => {
    expect(summarizeAiUsage([], "2026-10")).toEqual([{ month: "2026-10", total: ZERO_AI_USAGE, ownAccountCostUsd: 0, byGroup: [], byModel: [] }]);
    const rows = Array.from({ length: 20 }, (_, i) => row({ month: `2025-${String((i % 12) + 1).padStart(2, "0")}`, requests: 1 }));
    expect(summarizeAiUsage(rows, "2026-10")).toHaveLength(AI_USAGE_MONTHS);
  });
});
