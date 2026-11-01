import { describe, expect, it } from "vitest";
import { searchSnippet } from "./agent-chat-search";

describe("agent chat search snippets", () => {
  it("finds the words ignoring case, keeping the text's own spelling", () => {
    expect(searchSnippet("The Invoice for March is late.", "invoice")).toEqual({ before: "The ", match: "Invoice", after: " for March is late." });
  });

  it("reads whitespace runs as one space, in the text and the query", () => {
    expect(searchSnippet("late\n\n  orders here", "late   orders")).toEqual({ before: "", match: "late orders", after: " here" });
  });

  it("cuts long text on both sides at a space, marked where it was cut", () => {
    const words = (n: number, w: string) => Array.from({ length: n }, () => w).join(" ");
    const s = searchSnippet(`${words(30, "alpha")} needle ${words(30, "omega")}`, "needle", 30);
    expect(s.match).toBe("needle");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.before.length).toBeLessThanOrEqual(31);
    expect(s.before).not.toMatch(/…\S*a{0}lph(?!a)/);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.after.length).toBeLessThanOrEqual(31);
  });

  it("treats the query as text, never a pattern", () => {
    expect(searchSnippet("cost (USD) 4.5", "(usd)").match).toBe("(USD)");
    expect(searchSnippet("a.b", ".*").match).toBe("");
  });

  it("shows the text's start when the words aren't in it", () => {
    expect(searchSnippet("Nothing to see", "zzz")).toEqual({ before: "", match: "", after: "Nothing to see" });
  });
});
