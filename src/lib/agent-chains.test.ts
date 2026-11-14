import { describe, expect, it } from "vitest";
import { chainRunning, checkChainInput, MAX_CHAIN_NAME, MAX_CHAIN_STEPS } from "./agent-chains";

const step = (agentId = "a1", task = "Do it", databaseId: string | null = null) => ({ agentId, task, databaseId });

describe("checkChainInput", () => {
  it("takes a name and two to eight steps, trimming what was typed", () => {
    const result = checkChainInput({ name: "  Weekly  ", steps: [step("a1", " Read "), { agentId: "a2", task: "Write" }] }, 100);
    expect(result).toEqual({ ok: true, name: "Weekly", steps: [step("a1", "Read"), step("a2", "Write")] });
    expect(checkChainInput({ name: "x", steps: Array.from({ length: MAX_CHAIN_STEPS }, () => step()) }, 100).ok).toBe(true);
  });

  it("refuses a missing or long name", () => {
    expect(checkChainInput({ name: "  ", steps: [step(), step()] }, 100)).toEqual({ ok: false, reason: "name" });
    expect(checkChainInput({ name: 3, steps: [step(), step()] }, 100)).toEqual({ ok: false, reason: "name" });
    expect(checkChainInput({ name: "x".repeat(MAX_CHAIN_NAME + 1), steps: [step(), step()] }, 100)).toEqual({ ok: false, reason: "nameLength" });
  });

  it("refuses too few or too many steps, and steps without an agent", () => {
    expect(checkChainInput({ name: "x", steps: [step()] }, 100)).toEqual({ ok: false, reason: "steps" });
    expect(checkChainInput({ name: "x", steps: Array.from({ length: MAX_CHAIN_STEPS + 1 }, () => step()) }, 100)).toEqual({ ok: false, reason: "steps" });
    expect(checkChainInput({ name: "x", steps: "a1,a2" }, 100)).toEqual({ ok: false, reason: "steps" });
    expect(checkChainInput({ name: "x", steps: [step(), step("")] }, 100)).toEqual({ ok: false, reason: "steps" });
    expect(checkChainInput({ name: "x", steps: [step(), null] }, 100)).toEqual({ ok: false, reason: "steps" });
    expect(checkChainInput({ name: "x", steps: [step(), step("a2", "t", "")] }, 100)).toEqual({ ok: false, reason: "steps" });
  });

  it("refuses an empty or long task", () => {
    expect(checkChainInput({ name: "x", steps: [step(), step("a2", "  ")] }, 100)).toEqual({ ok: false, reason: "task" });
    expect(checkChainInput({ name: "x", steps: [step(), step("a2", "y".repeat(11))] }, 10)).toEqual({ ok: false, reason: "taskLength" });
  });
});

describe("chainRunning", () => {
  it("is true only while the latest run goes on", () => {
    const run = { id: "r", step: 0, trigger: "click" as const, code: null, startedAt: "", finishedAt: null };
    expect(chainRunning({ ...run, status: "running" })).toBe(true);
    expect(chainRunning({ ...run, status: "done" })).toBe(false);
    expect(chainRunning(null)).toBe(false);
  });
});
