/**
 * What AI requests add to their workspace's month (usage.ts), and the monthly cost limits that stop
 * them before anything is sent: the owners' limit on all spending, the server's
 * (AI_MONTHLY_LIMIT_USD) on what its own key pays.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { complete, embed, stream, transcribe } from "./index";
import { installFauxAi, resetAi } from "./testing";
import { memoryAiUsageLedger, monthOf, usageNumbers, type AiUsageEntry } from "./usage";

const now = new Date();
const entry = (over: Partial<AiUsageEntry>): AiUsageEntry => ({
  workspaceId: "w1",
  feature: "chat",
  model: "faux-writer",
  ownAccount: false,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  ...over,
});

let asked = 0;
let ledger: ReturnType<typeof memoryAiUsageLedger>;

beforeEach(() => {
  asked = 0;
  delete process.env.AI_MONTHLY_LIMIT_USD;
  ledger = memoryAiUsageLedger();
  installFauxAi(
    () => {
      asked += 1;
      return "An answer of a few words.";
    },
    { usage: ledger, embed: async (texts) => texts.map(() => [1, 0]), transcribe: async () => "heard" },
  );
});

afterEach(() => {
  delete process.env.AI_MONTHLY_LIMIT_USD;
  resetAi();
});

describe("recording AI usage", () => {
  it("adds each answer to its workspace's month by feature and model", async () => {
    const first = await complete({ feature: "editor.improve", workspaceId: "w1", messages: [{ role: "user", content: "Make this better." }] });
    await complete({ feature: "editor.improve", workspaceId: "w1", messages: [{ role: "user", content: "And this." }] });
    await complete({ feature: "chat", workspaceId: "w2", messages: [{ role: "user", content: "Hello" }] });

    const improve = ledger.rows.find((r) => r.workspaceId === "w1" && r.feature === "editor.improve");
    expect(improve).toMatchObject({ month: monthOf(now).slice(0, 7), model: "faux-writer", ownAccount: false, requests: 2 });
    expect(improve!.inputTokens).toBeGreaterThan(0);
    expect(improve!.outputTokens).toBeGreaterThanOrEqual(first.usage.outputTokens);
    expect(ledger.rows.filter((r) => r.workspaceId === "w2")).toHaveLength(1);
    expect(ledger.rows.find((r) => r.workspaceId === "w2")).toMatchObject({ feature: "chat", requests: 1 });
  });

  it("keeps cache tokens apart and takes the provider's cost", () => {
    const numbers = usageNumbers({
      input: 10,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 370,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.05, total: 0.38 },
    });
    expect(numbers).toEqual({ inputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 40, outputTokens: 20, costUsd: 0.38 });
  });

  it("counts a streamed answer, and one the provider failed", async () => {
    const s = stream({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    for await (const _ of s) void _;
    await s.result();
    installFauxAi(
      () => {
        throw new Error("overloaded");
      },
      { usage: ledger },
    );
    await expect(complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] })).rejects.toMatchObject({ code: "provider" });
    expect(ledger.rows.find((r) => r.feature === "chat")?.requests).toBe(2);
  });

  it("counts embeddings and transcriptions, at no cost", async () => {
    await embed(["one", "two"], { feature: "search.index", workspaceId: "w1", skipRateLimit: true });
    await transcribe({ bytes: new Blob(["x"]), type: "audio/webm" }, { feature: "voice.transcribe", workspaceId: "w1" });
    expect(ledger.rows.find((r) => r.feature === "search.index")).toMatchObject({ model: "test", requests: 1, costUsd: 0 });
    expect(ledger.rows.find((r) => r.feature === "voice.transcribe")).toMatchObject({ model: "faux-listener", requests: 1, costUsd: 0 });
  });

  it("never records anything without a ledger", async () => {
    installFauxAi(() => "ok");
    await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    expect(ledger.rows).toEqual([]);
  });
});

describe("the monthly cost limit", () => {
  it("refuses a workspace's requests once its month reached the owners' limit, before anything is sent", async () => {
    ledger.limits.w1 = 5;
    await ledger.record(entry({ costUsd: 4.99 }), now);
    await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    expect(asked).toBe(1);

    await ledger.record(entry({ costUsd: 0.01 }), now);
    await expect(complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] })).rejects.toMatchObject({
      code: "limitReached",
    });
    await expect(embed(["x"], { feature: "search.query", workspaceId: "w1" })).rejects.toMatchObject({ code: "limitReached" });
    await expect(transcribe({ bytes: new Blob(["x"]), type: "audio/webm" }, { feature: "voice.transcribe", workspaceId: "w1" })).rejects.toMatchObject({
      code: "limitReached",
    });
    expect(asked).toBe(1);
    // A refused request costs nothing and isn't counted.
    expect(ledger.rows.filter((r) => r.workspaceId === "w1").reduce((n, r) => n + r.requests, 0)).toBe(3);

    // Other workspaces, and last month's spending, don't count.
    await complete({ feature: "chat", workspaceId: "w2", messages: [{ role: "user", content: "Hi" }] });
    expect(asked).toBe(2);
  });

  it("starts again with the next month", async () => {
    ledger.limits.w1 = 1;
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await ledger.record(entry({ costUsd: 50 }), lastMonth);
    await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    expect(asked).toBe(1);
  });

  it("holds the server's own key to AI_MONTHLY_LIMIT_USD, counting only what that key paid", async () => {
    process.env.AI_MONTHLY_LIMIT_USD = "10";
    // The workspace's own AI account paid these: the server's limit doesn't count them.
    await ledger.record(entry({ ownAccount: true, costUsd: 25 }), now);
    await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    expect(asked).toBe(1);

    await ledger.record(entry({ costUsd: 10 }), now);
    await expect(complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] })).rejects.toMatchObject({
      code: "limitReached",
      message: expect.stringContaining("server's"),
    });
    expect(asked).toBe(1);
  });

  it("ignores a server limit that isn't a positive amount", async () => {
    process.env.AI_MONTHLY_LIMIT_USD = "lots";
    await ledger.record(entry({ costUsd: 1000 }), now);
    await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hi" }] });
    expect(asked).toBe(1);
  });
});
