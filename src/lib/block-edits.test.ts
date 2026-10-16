import { describe, expect, it } from "vitest";
import { applyBlockEdits, blockEditProblem, listedBlocks, stripBlockMarkers } from "./block-edits";
import type { ReviewBlock } from "./page-review";

const p = (id: string, text: string, children: ReviewBlock[] = []): ReviewBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: text ? [{ type: "text", text, styles: {} }] : [],
  children,
});
const texts = (blocks: readonly ReviewBlock[]): string[] =>
  blocks.flatMap((b) => [
    ...(Array.isArray(b.content) ? [b.content.map((n) => (n as { text?: string }).text ?? "").join("")] : []),
    ...texts(b.children ?? []),
  ]);
const body = () => [p("a", "One"), p("b", "Two", [p("b1", "Two and a half")]), p("c", "Three")];

describe("applyBlockEdits", () => {
  it("replaces, inserts after, appends and deletes, in order", () => {
    const made = applyBlockEdits(body(), [
      { op: "replace", blockId: "a", blocks: [p("x", "First"), p("y", "Second")] },
      { op: "insert_after", blockId: "b1", blocks: [p("z", "Nested new")] },
      { op: "delete", blockId: "c", blocks: [] },
      { op: "append", blocks: [p("w", "Last")] },
    ]);
    expect("blocks" in made && texts(made.blocks)).toEqual(["First", "Second", "Two", "Two and a half", "Nested new", "Last"]);
  });

  it("names the first block it can't find, and changes nothing then", () => {
    const before = body();
    expect(applyBlockEdits(before, [{ op: "delete", blockId: "a", blocks: [] }, { op: "replace", blockId: "a", blocks: [p("x", "Again")] }])).toEqual({ missing: "a" });
    expect(texts(before)).toEqual(["One", "Two", "Two and a half", "Three"]);
  });

  it("appends after the empty paragraph a new page has, in its place", () => {
    const made = applyBlockEdits([p("e", "")], [{ op: "append", blocks: [p("x", "Hello")] }]);
    expect("blocks" in made && made.blocks.map((b) => b.id)).toEqual(["x"]);
  });

  it("leaves one empty paragraph when everything is deleted", () => {
    const made = applyBlockEdits([p("a", "One")], [{ op: "delete", blockId: "a", blocks: [] }]);
    expect("blocks" in made && made.blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("lists blocks inside columns", () => {
    const blocks: ReviewBlock[] = [
      p("a", "One"),
      { id: "cl", type: "columnList", props: {}, children: [
        { id: "c1", type: "column", props: {}, children: [p("x", "Left")] },
        { id: "c2", type: "column", props: {}, children: [p("y", "Right")] },
      ] },
    ];
    expect(listedBlocks(blocks).map((b) => b.id)).toEqual(["a", "x", "y"]);
  });
});

describe("checking edits", () => {
  it("asks for what each op needs", () => {
    expect(blockEditProblem({ op: "replace", markdown: "x" })).toMatch(/block_id/);
    expect(blockEditProblem({ op: "insert_after", blockId: "a" })).toMatch(/markdown/);
    expect(blockEditProblem({ op: "append", markdown: "<!-- block a -->\n" })).toMatch(/markdown/);
    expect(blockEditProblem({ op: "delete", blockId: "a" })).toBeNull();
    expect(blockEditProblem({ op: "move" as never, blockId: "a" })).toMatch(/op must be/);
  });

  it("drops block lines copied back from a read with block ids", () => {
    expect(stripBlockMarkers("<!-- block abc-1 -->\n# Title\n\n<!-- block d2 -->\nText")).toBe("# Title\n\nText");
  });
});
