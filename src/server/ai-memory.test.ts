import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
const noteSimilarities = vi.fn(async (..._args: unknown[]): Promise<Map<string, number> | null> => null);
vi.mock("@/server/memory-embeddings", () => ({ noteSimilarities }));

const { fitNotes, MEMORY_SEARCH_LIMIT, searchNotes } = await import("./ai-memory");

const note = (id: string, text: string, kind?: "correction") => ({ id, text, ...(kind ? { kind } : {}) });
/** A note's line in the prompt, and its room with the line break. */
const line = (id: string, text: string, kind?: "correction") => `- (memory_id ${id}) ${kind ? "(correction) " : ""}${text}`;
const room = (...lines: string[]) => lines.reduce((sum, l) => sum + l.length + 1, 0);

describe("fitNotes", () => {
  it("keeps every note, oldest first, when they fit", () => {
    const fitted = fitNotes([note("a", "One"), note("b", "Two")], 1000, "(more)");
    expect(fitted).toEqual({ text: `${line("a", "One")}\n${line("b", "Two")}`, count: 2, shown: 2, details: false });
  });

  it("takes the newest that fit, keeps their order and says there are more", () => {
    const fitted = fitNotes([note("a", "Oldest"), note("b", "Middle"), note("c", "Newest")], room(line("b", "Middle"), line("c", "Newest")), "(more)");
    expect(fitted).toEqual({ text: `(more)\n${line("b", "Middle")}\n${line("c", "Newest")}`, count: 3, shown: 2, details: false });
  });

  it("takes corrections before newer notes", () => {
    const fitted = fitNotes([note("a", "Fix", "correction"), note("b", "Newest")], room(line("a", "Fix", "correction")), "(more)");
    expect(fitted).toEqual({ text: `(more)\n${line("a", "Fix", "correction")}`, count: 2, shown: 1, details: false });
  });

  it("says what a note is about, except for other", () => {
    const fitted = fitNotes(
      [
        { id: "a", text: "Answers in Turkish", category: "preference" as const },
        { id: "b", text: "Leads the Q3 launch", category: "work" as const },
        { id: "c", text: "Likes tea", category: "other" as const },
      ],
      1000,
      "(more)",
    );
    expect(fitted.text).toBe(`${line("a", "[preference] Answers in Turkish")}\n${line("b", "[work] Leads the Q3 launch")}\n${line("c", "Likes tea")}`);
  });

  it("shows only the overflow line when nothing fits", () => {
    expect(fitNotes([note("a", "Too long for the room")], 3, "(more)")).toEqual({ text: "(more)", count: 1, shown: 0, details: false });
  });
});

describe("details", () => {
  const notes = [
    { id: "a", text: "Q4 budget review", category: "work" as const, details: "Due December 12.\nSend the draft to Finance first." },
    { id: "b", text: "Wants short answers", category: "preference" as const, details: null },
  ];

  it("marks a note with details in the prompt and says so, unless asked not to", () => {
    const fitted = fitNotes(notes, 1000, "(more)");
    expect(fitted.text).toBe(`${line("a", "[work] Q4 budget review (has details)")}\n${line("b", "[preference] Wants short answers")}`);
    expect(fitted.details).toBe(true);
    expect(fitted.text).not.toContain("Finance");
    const plain = fitNotes(notes, 1000, "(more)", { markDetails: false });
    expect(plain.text).not.toContain("has details");
    expect(plain.details).toBe(false);
  });

  it("reads one note in full by its memory_id", async () => {
    expect((await searchNotes(notes, { memory_id: "a" })).content).toBe(`${line("a", "[work] Q4 budget review")}\n    Due December 12.\n    Send the draft to Finance first.`);
    expect((await searchNotes(notes, { memory_id: "zz" })).isError).toBe(true);
  });

  it("ranks notes by the words they have, the line before the details, newer first on a tie", async () => {
    const many = [
      { id: "1", text: "Budget owner is Finance", details: null },
      { id: "2", text: "Launch moved to Friday", details: "The budget for it is in the Q4 sheet." },
      { id: "3", text: "Q4 budget review", details: null },
      { id: "4", text: "Likes tea", details: null },
    ];
    const found = (await searchNotes(many, { query: "Q4 budget" })).content.split("\n").filter((l) => l.startsWith("- "));
    expect(found.map((l) => /memory_id (\w+)/.exec(l)![1])).toEqual(["3", "2", "1"]);
    expect((await searchNotes(many, { query: "coffee" })).content).toBe("No kept note matches that.");
    // No words: every note's line, oldest first.
    expect((await searchNotes(many, {})).content.split("\n")).toHaveLength(4);
  });

  it("finds notes by meaning too when the workspace has an embeddings model, only notes of a table", async () => {
    const many = [
      { id: "1", text: "Budget owner is Finance", store: "ai_memory" as const },
      { id: "2", text: "Prefers green tea", store: "account_memory" as const },
      { id: "3", text: "Office plant", layer: "x" },
    ];
    noteSimilarities.mockResolvedValueOnce(new Map([["2", 0.7]]));
    const by = { userId: "u1", workspaceId: "w1" };
    const content = (await searchNotes(many, { query: "favourite drink" }, by)).content;
    expect(content).toContain("memory_id 2");
    const [embeddable, query, who] = noteSimilarities.mock.calls.at(-1)!;
    expect((embeddable as { id: string }[]).map((n) => n.id)).toEqual(["1", "2"]);
    expect([query, who]).toEqual(["favourite drink", by]);
    // Without a model (null), the words alone.
    expect((await searchNotes(many, { query: "favourite drink" }, by)).content).toBe("No kept note matches that.");
  });

  it("answers a search with at most a few notes and cuts long details", async () => {
    const lots = Array.from({ length: MEMORY_SEARCH_LIMIT + 5 }, (_, i) => ({ id: `n${i}`, text: `Project note ${i}`, details: "x".repeat(1000) }));
    const content = (await searchNotes(lots, { query: "project" })).content;
    expect(content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(MEMORY_SEARCH_LIMIT);
    expect(content).toContain("(more: read_memory with this memory_id)");
  });
});
