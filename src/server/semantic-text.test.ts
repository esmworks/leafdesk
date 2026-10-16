import { describe, expect, it } from "vitest";
import { fakeEmbedding, fakeTokens } from "./ai/fake-openai";
import {
  bestChunkForTerms,
  blockTexts,
  CHUNK_MAX,
  CHUNKER_VERSION,
  chunkContext,
  chunkPage,
  CONTEXT_MAX,
  cosineSimilarity,
  MAX_CHUNKS_PER_PAGE,
  passageOf,
  reciprocalRankFusion,
  rowPropertyLines,
  sha256,
  snippetOf,
  sourceHash,
  splitLong,
  vectorLiteral,
} from "./semantic-text";

const para = (id: string, text: string) => ({ id, type: "paragraph", content: [{ type: "text", text }], children: [] });

describe("what a page's text is for semantic search", () => {
  it("takes each block's own text, children after their parent, with ids", () => {
    const blocks = [
      { ...para("a", "Parent"), children: [para("b", "Child")] },
      para("c", "   "),
      { id: "d", type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "x" }], [{ type: "text", text: "y" }]] }] } },
      { id: "h", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Risks" }], children: [] },
    ];
    expect(blockTexts(blocks as never)).toEqual([
      { id: "a", text: "Parent" },
      { id: "b", text: "Child" },
      { id: "d", text: "x y" },
      { id: "h", text: "Risks", heading: true },
    ]);
  });

  it("writes a row's own values as lines, leaving out relations, people and derived values", () => {
    const props = [
      { id: "t", name: "Notes", type: "text", options: {} },
      { id: "s", name: "Status", type: "status", options: { options: [{ id: "o1", name: "Done", color: "green" }] } },
      { id: "m", name: "Tags", type: "multi_select", options: { options: [{ id: "x", name: "Red", color: "red" }, { id: "y", name: "Blue", color: "blue" }] } },
      { id: "n", name: "Price", type: "number", options: {} },
      { id: "r", name: "Customer", type: "relation", options: {} },
      { id: "p", name: "Owner", type: "person", options: {} },
      { id: "f", name: "Total", type: "formula", options: {} },
      { id: "c", name: "Paid", type: "checkbox", options: {} },
      { id: "e", name: "Empty", type: "text", options: {} },
    ];
    const values = { t: "Call  back\nsoon", s: "o1", m: ["y", "x"], n: 12.5, r: ["row-1"], p: ["user-1"], f: 3, c: true, e: "" };
    expect(rowPropertyLines(props as never, values)).toEqual(["Notes: Call back soon", "Status: Done", "Tags: Blue, Red", "Price: 12.5"]);
  });
});

describe("chunks", () => {
  it("puts the title in front of every chunk and whole blocks together up to the target size", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, text: `${"word ".repeat(59)}block${i}` }));
    const chunks = chunkPage({ title: "Plans", blocks }, { target: 700, max: 1400 });
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.text.startsWith("Plans\n"))).toBe(true);
    expect(chunks.map((c) => c.blockId)).toEqual(["b0", "b2", "b4"]);
    expect(chunks.map((c) => c.position)).toEqual([0, 1, 2]);
    expect(chunks[0].hash).toBe(sha256(chunks[0].text));
  });

  it("opens with a row's values, and a page with only a title is one chunk", () => {
    const row = chunkPage({ title: "Acme", properties: ["Status: Done"], blocks: [{ id: "x", text: "Body" }] });
    expect(row).toHaveLength(1);
    expect(row[0].text).toBe("Acme\n\nStatus: Done\nBody");
    expect(row[0].blockId).toBeNull();
    expect(chunkPage({ title: "  Just a   title ", blocks: [] }).map((c) => c.text)).toEqual(["Just a title\n\n"]);
    expect(chunkPage({ title: "", blocks: [] })).toEqual([]);
  });

  it("splits long blocks at sentence ends and drops repeated chunks", () => {
    const sentence = "This sentence is exactly fifty characters long ok. ";
    const long = sentence.repeat(60);
    const parts = splitLong(long, CHUNK_MAX);
    expect(parts.every((p) => p.length <= CHUNK_MAX)).toBe(true);
    expect(parts.every((p) => p.endsWith("."))).toBe(true);
    expect(parts.join(" ")).toBe(long.trim());
    const same = chunkPage({ title: "T", blocks: [{ id: "a", text: "x".repeat(1000) }, { id: "b", text: "x".repeat(1000) }] });
    expect(same).toHaveLength(1);
    // A word longer than the limit is cut anyway.
    expect(splitLong("y".repeat(3000), 1000).map((p) => p.length)).toEqual([1000, 1000, 1000]);
  });

  it("stops at MAX_CHUNKS_PER_PAGE", () => {
    const blocks = Array.from({ length: MAX_CHUNKS_PER_PAGE + 50 }, (_, i) => ({ id: `b${i}`, text: `${i} ${"z".repeat(1000)}` }));
    expect(chunkPage({ title: "Big", blocks })).toHaveLength(MAX_CHUNKS_PER_PAGE);
  });

  it("puts the pages above, the title and the heading a chunk lies under in front of it", () => {
    const blocks = [
      { id: "p0", text: "Intro to the plan." },
      { id: "h1", text: "Risks", heading: true as const },
      { id: "p1", text: "Suppliers may be late." },
      { id: "p2", text: "Prices may rise." },
    ];
    const chunks = chunkPage({ title: "2026 plan", path: ["Sales"], blocks }, { target: 40, max: 1400 });
    expect(chunks.map((c) => [c.blockId, c.text])).toEqual([
      // A heading starts a new chunk.
      ["p0", "Sales › 2026 plan\n\nIntro to the plan."],
      // Starting at the heading: it's in the text already.
      ["h1", "Sales › 2026 plan\n\nRisks\nSuppliers may be late."],
      ["p2", "Sales › 2026 plan\nRisks\n\nPrices may rise."],
    ]);
    expect(chunks.map((c) => passageOf(c.text, "2026 plan"))).toEqual(["Intro to the plan.", "Risks\nSuppliers may be late.", "Prices may rise."]);
    // A row: its database is the page above it.
    const row = chunkPage({ title: "Acme", path: ["Wiki", "Customers"], properties: ["Status: Done"], blocks: [] });
    expect(row.map((c) => c.text)).toEqual(["Wiki › Customers › Acme\n\nStatus: Done"]);
    // Untitled pages above and below are left out of the path.
    expect(chunkPage({ title: "", path: ["", "Notes"], blocks: [{ id: "a", text: "x" }] })[0].text).toBe("Notes\n\nx");
    expect(chunkPage({ title: "", blocks: [{ id: "a", text: "x" }] })[0].text).toBe("x");
  });

  it("keeps where a chunk is short, leaving out the pages farthest up first", () => {
    const path = Array.from({ length: 8 }, (_, i) => `Section number ${i} of the handbook`);
    const context = chunkContext(path, "Travel policy", "Booking flights");
    expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX);
    expect(context).toMatch(/^… › .* › Section number 7 of the handbook › Travel policy\nBooking flights$/);
    expect(context).not.toContain("Section number 0");
    const long = chunkContext(["x".repeat(500)], "y".repeat(500), "z".repeat(500));
    expect(long.length).toBeLessThanOrEqual(CONTEXT_MAX);
    expect(long.split("\n")).toHaveLength(2);
    // A blank line inside a block can't end the context early.
    const [chunk] = chunkPage({ title: "T", blocks: [{ id: "c", text: "line 1\n\n\nline 2" }] });
    expect(passageOf(chunk.text, "T")).toBe("line 1\nline 2");
  });

  it("is the second chunker, so pages indexed with the first are indexed again", () => {
    expect(CHUNKER_VERSION).toBe(2);
  });

  it("fingerprints chunks with the model, so another model indexes again", () => {
    const chunks = chunkPage({ title: "T", blocks: [{ id: "a", text: "one" }] });
    expect(sourceHash("m1", chunks)).toBe(sourceHash("m1", chunkPage({ title: "T", blocks: [{ id: "a", text: "one" }] })));
    expect(sourceHash("m1", chunks)).not.toBe(sourceHash("m2", chunks));
    // A moved passage (another block) counts as a change: its link would be wrong.
    expect(sourceHash("m1", chunks)).not.toBe(sourceHash("m1", chunkPage({ title: "T", blocks: [{ id: "b", text: "one" }] })));
  });

  it("shows a passage without where it is", () => {
    expect(passageOf("Sales › Plans\nRisks\n\nWe go north.\nThen east.", "Plans")).toBe("We go north.\nThen east.");
    expect(passageOf("Sales › Plans\n\n", "Plans")).toBe("");
    expect(passageOf("We go north.", "")).toBe("We go north.");
    // Indexed by the first chunker: only the title line in front.
    expect(passageOf("Plans\nWe go north.", "Plans")).toBe("We go north.");
    expect(passageOf("Other\nWe go north.", "Plans")).toBe("Other\nWe go north.");
    expect(passageOf("Plans", "Plans")).toBe("");
    expect(snippetOf("a\n  b ".repeat(3))).toBe("a b a b a b");
    expect(snippetOf("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("the passage the text search found a page for", () => {
  const chunk = (position: number, passage: string, blockId = `b${position}`) => ({ position, blockId, text: `Wiki › Plans\nGoals\n\n${passage}` });

  it("takes the chunk with the most of the query's words, matched as word starts", () => {
    const chunks = [chunk(0, "We grow the team."), chunk(1, "Supplier risks: late deliveries."), chunk(2, "Risks of the budget and supplier prices.")];
    expect(bestChunkForTerms(chunks, ["supplier", "risks"], "Plans")?.blockId).toBe("b1");
    expect(bestChunkForTerms(chunks, ["budge", "suppl"], "Plans")?.blockId).toBe("b2");
    // More matches of the same words win, then the earlier chunk.
    expect(bestChunkForTerms([chunk(0, "risk"), chunk(1, "risk and risk")], ["risk"], "Plans")?.blockId).toBe("b1");
    expect(bestChunkForTerms([chunk(3, "risk"), chunk(1, "risk")], ["risk"], "Plans")?.blockId).toBe("b1");
  });

  it("doesn't count words of where a chunk is, nor parts of words", () => {
    const chunks = [chunk(0, "Nothing here."), chunk(1, "We reach our goals.")];
    // "Goals" is the heading in front of every chunk; "each" is inside "reach".
    expect(bestChunkForTerms(chunks, ["goals"], "Plans")?.blockId).toBe("b1");
    expect(bestChunkForTerms(chunks, ["each"], "Plans")?.blockId).toBe("b0");
  });

  it("matches Turkish letters whatever their case, and falls back to the first chunk", () => {
    const chunks = [chunk(0, "Giriş."), chunk(1, "İSTANBUL ofisi ışıkları")];
    expect(bestChunkForTerms(chunks, ["istanbul"], "Plans")?.blockId).toBe("b1");
    expect(bestChunkForTerms(chunks, ["Işık"], "Plans")?.blockId).toBe("b1");
    expect(bestChunkForTerms(chunks, ["nowhere"], "Plans")?.blockId).toBe("b0");
    expect(bestChunkForTerms([], ["x"], "Plans")).toBeNull();
  });
});

describe("ranking", () => {
  it("merges rankings by reciprocal rank fusion", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["c", "d", "a"],
    ]);
    // a: 1/61 + 1/63, c: 1/63 + 1/61 (tie: a came first), b: 1/62, d: 1/62 (tie: b first).
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63);
    expect(reciprocalRankFusion([[], ["x"]]).map((f) => f.id)).toEqual(["x"]);
  });

  it("computes cosine similarity like the SQL function", () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  it("only puts finite numbers into SQL vector literals", () => {
    expect(vectorLiteral([1, -0.5, 2e-3])).toBe("{1,-0.5,0.002}");
    expect(() => vectorLiteral([])).toThrow();
    expect(() => vectorLiteral([1, Number.NaN])).toThrow();
    expect(() => vectorLiteral([1, "2); drop table page; --" as unknown as number])).toThrow();
  });
});

describe("the fake embeddings model of the e2e scripts", () => {
  it("is deterministic and folds synonyms, so meaning can be tested without a model", () => {
    expect(fakeEmbedding("Cars and dogs")).toEqual(fakeEmbedding("cars and dogs"));
    expect(fakeTokens("An automobile for the puppy")).toEqual(["car", "dog"]);
    const car = fakeEmbedding("Our car needs new tyres");
    expect(cosineSimilarity(fakeEmbedding("automobile tyres"), car)).toBeGreaterThan(0.5);
    expect(cosineSimilarity(fakeEmbedding("holiday plans"), car)).toBeLessThan(0.2);
  });
});
