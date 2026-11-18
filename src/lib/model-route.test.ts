import { describe, expect, it } from "vitest";
import { AUTO_MODEL, FAST_ROUNDS, isAutoModel, isRouteReason, LONG_HISTORY_CHARS, LONG_QUESTION_CHARS, looksLikeCode, looksLikeList, routeModel, type RouteInput } from "./model-route";

const quick: RouteInput = { question: 30, text: "What is on my plate today?", history: 400, files: 0, round: 0 };

describe("routeModel", () => {
  it("sends a short, simple question to the fast model", () => {
    expect(routeModel(quick)).toEqual({ tier: "fast", reason: null });
    expect(routeModel({ ...quick, round: FAST_ROUNDS - 1 })).toEqual({ tier: "fast", reason: null });
  });

  it("sends what is not quick to the main model, with the reason", () => {
    const main = (input: Partial<RouteInput>) => routeModel({ ...quick, ...input });
    expect(main({ research: true })).toEqual({ tier: "main", reason: "research" });
    expect(main({ planning: true })).toEqual({ tier: "main", reason: "plan" });
    expect(main({ deep: true })).toEqual({ tier: "main", reason: "deep" });
    expect(main({ files: 1 })).toEqual({ tier: "main", reason: "files" });
    expect(main({ question: LONG_QUESTION_CHARS + 1 })).toEqual({ tier: "main", reason: "long" });
    expect(main({ history: LONG_HISTORY_CHARS + 1 })).toEqual({ tier: "main", reason: "history" });
    expect(main({ text: "Fix this:\n```ts\nconst a = 1;\n```" })).toEqual({ tier: "main", reason: "code" });
    expect(main({ text: "Do these:\n- one\n- two\n- three\n- four" })).toEqual({ tier: "main", reason: "list" });
    expect(main({ round: FAST_ROUNDS })).toEqual({ tier: "main", reason: "steps" });
  });

  it("keeps the fast model's limits exact", () => {
    expect(routeModel({ ...quick, question: LONG_QUESTION_CHARS }).tier).toBe("fast");
    expect(routeModel({ ...quick, history: LONG_HISTORY_CHARS }).tier).toBe("fast");
  });

  it("moves to the main model once the fast one failed, whatever the question", () => {
    expect(routeModel({ ...quick, failed: true })).toEqual({ tier: "main", reason: "failed" });
  });

  it("names the first reason that holds", () => {
    expect(routeModel({ ...quick, research: true, files: 2, round: 9 }).reason).toBe("research");
    expect(routeModel({ ...quick, failed: true, research: true }).reason).toBe("failed");
  });
});

describe("text rules", () => {
  it("tells code from prose", () => {
    expect(looksLikeCode("How do I bake bread?")).toBe(false);
    expect(looksLikeCode("Why does `x` fail? Is it a problem; or not")).toBe(false);
    expect(looksLikeCode("const total = rows.map((r) => r.value);")).toBe(true);
    expect(looksLikeCode("SELECT * FROM page")).toBe(true);
  });

  it("tells a task list from a few bullets", () => {
    expect(looksLikeList("- a\n- b\n- c")).toBe(false);
    expect(looksLikeList("1. a\n2. b\n3) c\n4. d")).toBe(true);
  });
});

describe("Auto's id", () => {
  it("is recognised, and is none of a reason", () => {
    expect(isAutoModel(AUTO_MODEL)).toBe(true);
    expect(isAutoModel("gpt")).toBe(false);
    expect(isRouteReason("steps")).toBe(true);
    expect(isRouteReason("auto")).toBe(false);
  });
});
