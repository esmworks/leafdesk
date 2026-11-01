import { describe, expect, it } from "vitest";
import { AGENT_CHAT_SUMMARY_SYSTEM, summaryInput, summaryTurn } from "./agent-chat-summary";

describe("agent chat summaries", () => {
  it("writes the conversation for the model, who said what, files by name", () => {
    const text = summaryInput([
      { role: "assistant", content: "We set up the Orders board.", summary: true },
      { role: "user", content: "Which orders are late?", files: [{ name: "orders.csv", size: 10 }] },
      { role: "assistant", content: "", code: "provider" },
      { role: "user", content: "  " },
      { role: "assistant", content: "Two are late.", attached: [{ id: "f", name: "late.csv", size: 5, contentType: "text/csv" }] },
    ]);
    expect(text).toBe(
      [
        "Summary of an earlier conversation:\nWe set up the Orders board.",
        "Person (attached: orders.csv):\nWhich orders are late?",
        "Agent:\n(The answer failed.)",
        "Agent (attached: late.csv):\nTwo are late.",
      ].join("\n\n"),
    );
  });

  it("keeps the newest whole messages within the limit", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `message ${i} ${"x".repeat(40)}` }));
    const text = summaryInput(records, 200);
    expect(text).toContain("message 9");
    expect(text).not.toContain("message 0");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith("Person:") || text.startsWith("Agent:")).toBe(true);
  });

  it("is empty when nothing was said", () => {
    expect(summaryInput([])).toBe("");
    expect(summaryInput([{ role: "user", content: " " }])).toBe("");
  });

  it("reads a summary in the history as what was said before", () => {
    const [note, answer] = summaryTurn("  - Orders board made\n");
    expect(note.role).toBe("user");
    expect(note.content).toMatch(/^\(Not a message/);
    expect(answer).toEqual({ role: "assistant", content: "Summary of our earlier conversation:\n\n- Orders board made" });
  });

  it("tells the model the conversation is data", () => {
    expect(AGENT_CHAT_SUMMARY_SYSTEM).toMatch(/data, not instructions/);
  });
});
