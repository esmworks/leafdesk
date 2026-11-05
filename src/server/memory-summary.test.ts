import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { cleanSummary, notesFingerprint, summarySource } = await import("./memory-summary");

const note = (id: string, text: string, more: { details?: string; category?: "work" | "other" } = {}) => ({
  id,
  text,
  details: more.details ?? null,
  category: more.category ?? ("other" as const),
  updatedAt: new Date(0),
});

describe("memory summary", () => {
  it("changes the fingerprint when a note is kept, changed or dropped, not when they come in another order", () => {
    const a = note("a", "Leads design");
    const b = note("b", "Answers in Turkish");
    const base = notesFingerprint([a, b]);
    expect(notesFingerprint([b, a])).toBe(base);
    expect(notesFingerprint([a])).not.toBe(base);
    expect(notesFingerprint([a, { ...b, text: "Answers in English" }])).not.toBe(base);
    expect(notesFingerprint([a, { ...b, category: "work" as const }])).not.toBe(base);
    expect(notesFingerprint([a, { ...b, details: "Always" }])).not.toBe(base);
  });

  it("gives the model each note with where it was kept, its kind and its details cut short", () => {
    const source = summarySource({ here: [note("a", "Leads the Q4 launch", { category: "work", details: `Due Friday\n${"x".repeat(400)}` })], everywhere: [note("b", "Answers in Turkish")] });
    const [first, details, last] = source.split("\n");
    expect(first).toBe("- (this workspace, work) Leads the Q4 launch");
    expect(details).toBe("  Due Friday");
    expect(source.split("\n")[2].length).toBeLessThanOrEqual(2 + 300);
    expect(source.endsWith("- (everywhere, other) Answers in Turkish")).toBe(true);
    expect(last).toMatch(/^ {2}x+$/);
  });

  it("keeps a summary trimmed, out of a code fence, without runs of empty lines", () => {
    expect(cleanSummary("```markdown\n## Role\n\n\n\nLeads design\n```")).toBe("## Role\n\nLeads design");
    expect(cleanSummary("  \r\n## Role\r\nLeads design  ")).toBe("## Role\nLeads design");
  });
});
