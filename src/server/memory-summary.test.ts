import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { cleanSummary, coverage, noteKey, pickSource, SOURCE_CHARS, summarySource } = await import("./memory-summary");

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

  it("is written from the newest notes of both lists as far as the budget goes, and only those count as behind", () => {
    const long = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => note(`${prefix}${i}`, `${prefix} ${i} ${"x".repeat(280)}`, { details: "y".repeat(300) }));
    const notes = { here: long("h", 400), everywhere: long("e", 100) };
    const picked = pickSource(notes);
    expect(summarySource(picked).length).toBeLessThanOrEqual(SOURCE_CHARS);
    // Newest first in turn: the last of each list, still oldest first.
    expect(picked.here.at(-1)!.id).toBe("h399");
    expect(picked.everywhere.at(-1)!.id).toBe("e99");
    expect(picked.here.length).toBeGreaterThan(10);
    expect(Math.abs(picked.here.length - picked.everywhere.length)).toBeLessThanOrEqual(1);
    const sources = [...picked.here, ...picked.everywhere].map(noteKey);
    // Older notes left out never mark it behind; a newer one does.
    expect(coverage(sources, notes)).toEqual({ stale: false, withheld: false });
    expect(coverage(sources, { ...notes, here: [...notes.here, note("new", "Moved to sales")] }).stale).toBe(true);
    // A small memory goes in whole.
    const few = { here: [note("a", "Leads design")], everywhere: [note("b", "Answers in Turkish")] };
    expect(pickSource(few)).toEqual(few);
  });

  it("keeps a summary tidied, out of a code fence", () => {
    expect(cleanSummary("```markdown\n## Role\n\n\n\nLeads design\n```")).toBe("## Role\n\nLeads design");
    expect(cleanSummary("  \r\n## Role  \r\nLeads design  ")).toBe("## Role\nLeads design");
  });
});
