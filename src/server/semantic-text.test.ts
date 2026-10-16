import { describe, expect, it } from "vitest";
import { fakeEmbedding, fakeTokens } from "./ai/fake-openai";
import {
  blockTexts,
  CHUNK_MAX,
  chunkPage,
  cosineSimilarity,
  MAX_CHUNKS_PER_PAGE,
  MAX_FILE_CHUNKS_PER_PAGE,
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
    ];
    expect(blockTexts(blocks as never)).toEqual([
      { id: "a", text: "Parent" },
      { id: "b", text: "Child" },
      { id: "d", text: "x y" },
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
    expect(row[0].text).toBe("Acme\nStatus: Done\nBody");
    expect(row[0].blockId).toBeNull();
    expect(chunkPage({ title: "  Just a   title ", blocks: [] }).map((c) => c.text)).toEqual(["Just a title"]);
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

  it("fingerprints chunks with the model, so another model indexes again", () => {
    const chunks = chunkPage({ title: "T", blocks: [{ id: "a", text: "one" }] });
    expect(sourceHash("m1", chunks)).toBe(sourceHash("m1", chunkPage({ title: "T", blocks: [{ id: "a", text: "one" }] })));
    expect(sourceHash("m1", chunks)).not.toBe(sourceHash("m2", chunks));
    // A moved passage (another block) counts as a change: its link would be wrong.
    expect(sourceHash("m1", chunks)).not.toBe(sourceHash("m1", chunkPage({ title: "T", blocks: [{ id: "b", text: "one" }] })));
  });

  it("gives each attached document chunks of its own, after the page's, pointing at its block", () => {
    const report = { blockId: "f1", name: " Annual   report.pdf ", text: `Revenue grew.\nIn all regions.\n\n${"Costs fell. ".repeat(100)}` };
    const chunks = chunkPage(
      { title: "Plans", blocks: [{ id: "a", text: "We go north." }], files: [report, { blockId: "f2", name: "", text: "Short." }] },
      { target: 700, max: 1400 },
    );
    expect(chunks[0]).toMatchObject({ blockId: "a", text: "Plans\nWe go north." });
    const fromFiles = chunks.slice(1);
    expect(fromFiles.map((c) => c.blockId)).toEqual(["f1", "f1", "f2"]);
    expect(fromFiles.map((c) => c.position)).toEqual([1, 2, 3]);
    // Lines of a paragraph join up; paragraphs stay apart, packed together while they fit.
    expect(fromFiles[0].text.startsWith("Plans › Annual report.pdf\nRevenue grew. In all regions.")).toBe(true);
    expect(fromFiles.slice(0, 2).every((c) => c.text.startsWith("Plans › Annual report.pdf\n"))).toBe(true);
    expect(fromFiles[2].text).toBe("Plans › file\nShort.");
    // Without a title the file name leads.
    expect(chunkPage({ title: "", blocks: [], files: [{ blockId: "f", name: "a.pdf", text: "Hi." }] }).map((c) => c.text)).toEqual(["a.pdf\nHi."]);
  });

  it("gives documents their own allowance, so a long one leaves the page's text in", () => {
    const blocks = Array.from({ length: MAX_CHUNKS_PER_PAGE + 10 }, (_, i) => ({ id: `b${i}`, text: `${i} ${"z".repeat(1000)}` }));
    const text = Array.from({ length: MAX_FILE_CHUNKS_PER_PAGE + 40 }, (_, i) => `${i} ${"q".repeat(1000)}`).join("\n\n");
    const chunks = chunkPage({ title: "Big", blocks, files: [{ blockId: "f", name: "long.pdf", text }] });
    expect(chunks.filter((c) => c.blockId !== "f")).toHaveLength(MAX_CHUNKS_PER_PAGE);
    expect(chunks.filter((c) => c.blockId === "f")).toHaveLength(MAX_FILE_CHUNKS_PER_PAGE);
  });

  it("shows a passage without its title line", () => {
    expect(passageOf("Plans\nWe go north.", "Plans")).toBe("We go north.");
    expect(passageOf("Plans › report.pdf\nRevenue grew.", "Plans")).toBe("report.pdf\nRevenue grew.");
    expect(passageOf("Other\nWe go north.", "Plans")).toBe("Other\nWe go north.");
    expect(passageOf("Plans", "Plans")).toBe("");
    expect(snippetOf("a\n  b ".repeat(3))).toBe("a b a b a b");
    expect(snippetOf("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
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
