import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { cleanSummary, coverage, noteKey, summarySource } = await import("./memory-summary");

const note = (id: string, text: string, more: { details?: string; category?: "work" | "other" } = {}) => ({
  id,
  text,
  details: more.details ?? null,
  category: more.category ?? ("other" as const),
});

describe("memory summary", () => {
  it("keys a note by its id, kind, text and details", () => {
    const a = note("a", "Leads design");
    expect(noteKey(a)).toBe(noteKey({ ...a }));
    for (const changed of [{ ...a, id: "b" }, { ...a, text: "Leads sales" }, { ...a, category: "work" as const }, { ...a, details: "Since May" }]) {
      expect(noteKey(changed)).not.toBe(noteKey(a));
    }
  });

  it("marks a summary behind when notes were kept since, and holds it back when a note it was written from changed or went", () => {
    const a = note("a", "Leads design");
    const b = note("b", "Answers in Turkish");
    const sources = [noteKey(a), noteKey(b)];
    expect(coverage(sources, { here: [a], everywhere: [b] })).toEqual({ stale: false, withheld: false });
    expect(coverage(sources, { here: [a, note("c", "Works from Izmir")], everywhere: [b] })).toEqual({ stale: true, withheld: false });
    expect(coverage(sources, { here: [], everywhere: [b] })).toEqual({ stale: false, withheld: true });
    expect(coverage(sources, { here: [{ ...a, text: "Leads sales" }], everywhere: [b] })).toEqual({ stale: true, withheld: true });
  });

  it("gives the model each note with where it was kept, its kind and its details cut short", () => {
    const source = summarySource({ here: [note("a", "Leads the Q4 launch", { category: "work", details: `Due Friday\n${"x".repeat(400)}` })], everywhere: [note("b", "Answers in Turkish")] });
    const lines = source.split("\n");
    expect(lines[0]).toBe("- (this workspace, work) Leads the Q4 launch");
    expect(lines[1]).toBe("  Due Friday");
    expect(lines[2]).toMatch(/^ {2}x+$/);
    expect(lines[2].length).toBeLessThanOrEqual(2 + 300);
    expect(lines[3]).toBe("- (everywhere, other) Answers in Turkish");
  });

  it("keeps a summary tidied, out of a code fence", () => {
    expect(cleanSummary("```markdown\n## Role\n\n\n\nLeads design\n```")).toBe("## Role\n\nLeads design");
    expect(cleanSummary("  \r\n## Role  \r\nLeads design  ")).toBe("## Role\nLeads design");
  });
});
