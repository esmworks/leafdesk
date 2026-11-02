import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { fitNotes } = await import("./ai-memory");

const note = (id: string, text: string, kind?: "correction") => ({ id, text, ...(kind ? { kind } : {}) });
/** A note's line in the prompt, and its room with the line break. */
const line = (id: string, text: string, kind?: "correction") => `- (memory_id ${id}) ${kind ? "(correction) " : ""}${text}`;
const room = (...lines: string[]) => lines.reduce((sum, l) => sum + l.length + 1, 0);

describe("fitNotes", () => {
  it("keeps every note, oldest first, when they fit", () => {
    const fitted = fitNotes([note("a", "One"), note("b", "Two")], 1000, "(more)");
    expect(fitted).toEqual({ text: `${line("a", "One")}\n${line("b", "Two")}`, count: 2, shown: 2 });
  });

  it("takes the newest that fit, keeps their order and says there are more", () => {
    const fitted = fitNotes([note("a", "Oldest"), note("b", "Middle"), note("c", "Newest")], room(line("b", "Middle"), line("c", "Newest")), "(more)");
    expect(fitted).toEqual({ text: `(more)\n${line("b", "Middle")}\n${line("c", "Newest")}`, count: 3, shown: 2 });
  });

  it("takes corrections before newer notes", () => {
    const fitted = fitNotes([note("a", "Fix", "correction"), note("b", "Newest")], room(line("a", "Fix", "correction")), "(more)");
    expect(fitted).toEqual({ text: `(more)\n${line("a", "Fix", "correction")}`, count: 2, shown: 1 });
  });

  it("shows only the overflow line when nothing fits", () => {
    expect(fitNotes([note("a", "Too long for the room")], 3, "(more)")).toEqual({ text: "(more)", count: 1, shown: 0 });
  });
});
