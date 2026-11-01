import { describe, expect, it } from "vitest";
import type { AgentChatQueuedRecord } from "./agent-chat";
import { MAX_QUEUED, mergeTurnQuestions, queuedTurn, queueView, turnPrompt } from "./agent-chat-queue";

const item = (id: string, content: string, extra: Partial<AgentChatQueuedRecord> = {}): AgentChatQueuedRecord => ({ id, content, at: "2026-11-01T10:00:00.000Z", ...extra });

describe("agent chat queue", () => {
  it("keeps five messages waiting at most", () => {
    expect(MAX_QUEUED).toBe(5);
  });

  it("joins the messages of a turn in order, leaving out empty ones", () => {
    expect(turnPrompt(["  First ", "", "Second"])).toBe("First\n\nSecond");
  });

  it("shows queued messages with their files' names and sizes, never their text", () => {
    const [view] = queueView([item("q1", "See this", { files: [{ name: "a.csv", size: 4, text: "a,b\n" }], fromApp: true })]);
    expect(view).toEqual({ id: "q1", content: "See this", at: "2026-11-01T10:00:00.000Z", files: [{ name: "a.csv", size: 4 }] });
  });

  it("makes one turn of the queue: questions after the answer, one prompt, files named apart", () => {
    const at = Date.parse("2026-11-01T10:05:00.000Z");
    const turn = queuedTurn(
      [
        item("q1", "Also check orders", { files: [{ name: "list.csv", size: 3, text: "a,b" }], timeZone: "Europe/Istanbul" }),
        item("q2", "And the invoices", { files: [{ name: "list.csv", size: 2, text: "c" }], via: "telegram" }),
      ],
      "run-2",
      at,
    );
    expect(turn.prompt).toBe("Also check orders\n\nAnd the invoices");
    expect(turn.records.map((r) => [r.role, r.content, r.runId, r.at])).toEqual([
      ["user", "Also check orders", "run-2", "2026-11-01T10:05:00.001Z"],
      ["user", "And the invoices", "run-2", "2026-11-01T10:05:00.002Z"],
    ]);
    expect(turn.files.map((f) => f.name)).toEqual(["list.csv", "list (2).csv"]);
    expect(turn.records[1].files).toEqual([{ name: "list (2).csv", size: 2 }]);
    expect(turn).toMatchObject({ fromApp: false, telegram: true, otherApp: false, timeZone: "Europe/Istanbul" });
  });

  it("keeps the web session only when every message of the turn came from that one", () => {
    expect(queuedTurn([item("q1", "a", { sessionId: "s1" }), item("q2", "b", { sessionId: "s1" })], "r", 0).sessionId).toBe("s1");
    expect(queuedTurn([item("q1", "a", { sessionId: "s1" }), item("q2", "b", { sessionId: "s2" })], "r", 0).sessionId).toBeUndefined();
    // A message from Telegram (or another app) has none: the turn has none either.
    expect(queuedTurn([item("q1", "a", { sessionId: "s1" }), item("q2", "b", { fromApp: true, via: "telegram" })], "r", 0).sessionId).toBeUndefined();
    expect(queuedTurn([], "r", 0).sessionId).toBeUndefined();
  });

  it("takes the turn as one from a connected app when one of its messages was", () => {
    expect(queuedTurn([item("q1", "a"), item("q2", "b", { fromApp: true })], "r", 0).fromApp).toBe(true);
  });

  it("marks a turn holding another app's message apart from the Telegram bot's own", () => {
    const flags = (queue: AgentChatQueuedRecord[]) => {
      const { fromApp, telegram, otherApp } = queuedTurn(queue, "r", 0);
      return { fromApp, telegram, otherApp };
    };
    expect(flags([item("q1", "a")])).toEqual({ fromApp: false, telegram: false, otherApp: false });
    expect(flags([item("q1", "a", { fromApp: true, via: "telegram" })])).toEqual({ fromApp: true, telegram: true, otherApp: false });
    expect(flags([item("q1", "a", { fromApp: true })])).toEqual({ fromApp: true, telegram: false, otherApp: true });
    // One message from another app and one from Telegram: the turn isn't only the person's words.
    expect(flags([item("q1", "a", { fromApp: true }), item("q2", "b", { fromApp: true, via: "telegram" })])).toEqual({ fromApp: true, telegram: true, otherApp: true });
  });

  it("merges a turn's questions for the history, but not a summary or another run's", () => {
    const merged = mergeTurnQuestions([
      { role: "assistant" as const, content: "Summary", runId: "", summary: true as const },
      { role: "user" as const, content: "One", runId: "r1", files: [{ name: "a.md", size: 1 }] },
      { role: "user" as const, content: "Two", runId: "r1", files: [{ name: "b.md", size: 2 }] },
      { role: "assistant" as const, content: "Done", runId: "r1" },
      { role: "user" as const, content: "Three", runId: "r2" },
    ]);
    expect(merged.map((m) => m.content)).toEqual(["Summary", "One\n\nTwo", "Done", "Three"]);
    expect(merged[1].files).toEqual([
      { name: "a.md", size: 1 },
      { name: "b.md", size: 2 },
    ]);
  });
});
