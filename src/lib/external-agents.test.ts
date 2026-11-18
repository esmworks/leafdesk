import { describe, expect, it } from "vitest";
import { chooseBinding, claudeCodeAddCommand, consentHolds, mcpServerName, mentionExcerpt, MENTION_EXCERPT_CHARS } from "./external-agents";

describe("chooseBinding", () => {
  const a = { agentId: "a" };
  const b = { agentId: "b" };
  it("is none without bindings, even when an agent is named", () => {
    expect(chooseBinding([], undefined)).toEqual({ ok: false, reason: "none" });
    expect(chooseBinding([], "a")).toEqual({ ok: false, reason: "none" });
  });
  it("takes the only binding when no agent is named", () => {
    expect(chooseBinding([a])).toEqual({ ok: true, binding: a });
  });
  it("asks for a choice among several", () => {
    expect(chooseBinding([a, b])).toEqual({ ok: false, reason: "ambiguous" });
    expect(chooseBinding([a, b], "b")).toEqual({ ok: true, binding: b });
  });
  it("never lets a caller pick an agent it isn't bound to", () => {
    expect(chooseBinding([a], "other")).toEqual({ ok: false, reason: "notBound" });
    expect(chooseBinding([a, b], "other")).toEqual({ ok: false, reason: "notBound" });
  });
});

describe("consentHolds", () => {
  const bound = new Date("2026-01-01T10:00:00Z");
  it("holds while the consent is older than the binding", () => {
    expect(consentHolds(bound, new Date("2026-01-01T09:00:00Z"))).toBe(true);
    expect(consentHolds(bound, new Date("2026-01-01T10:00:00.900Z"))).toBe(true);
  });
  it("ends when the consent was given again after the binding, or is gone", () => {
    expect(consentHolds(bound, new Date("2026-01-01T10:00:05Z"))).toBe(false);
    expect(consentHolds(bound, null)).toBe(false);
  });
});

describe("setup text", () => {
  it("names the MCP server after the agent", () => {
    expect(mcpServerName("Code Reviewer!")).toBe("leafdesk-code-reviewer");
    expect(mcpServerName("???")).toBe("leafdesk");
    expect(claudeCodeAddCommand("Builder", "https://x.test/mcp")).toBe("claude mcp add --transport http leafdesk-builder https://x.test/mcp");
  });
  it("cuts a mention to one short line", () => {
    expect(mentionExcerpt("  a\n\n b  ")).toBe("a b");
    expect(mentionExcerpt("x".repeat(5000))).toHaveLength(MENTION_EXCERPT_CHARS);
  });
});
