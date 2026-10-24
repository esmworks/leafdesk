import { describe, expect, it } from "vitest";
import { serverEditor } from "@/server/blocknote";
import { currentHeading, headingsOfDoc, sameHeadings } from "./page-outline";

const docOf = (blocks: unknown[]) => serverEditor._blocksToProsemirrorNode(blocks as any);

describe("headingsOfDoc", () => {
  it("lists every heading in document order, nested and in columns too", () => {
    const blocks = [
      { id: "h1", type: "heading", props: { level: 1 }, content: "Intro" },
      { id: "p", type: "paragraph", content: "Text", children: [{ id: "h3", type: "heading", props: { level: 3 }, content: "Nested" }] },
      {
        id: "cols",
        type: "columnList",
        children: [
          { id: "c1", type: "column", children: [{ id: "h2", type: "heading", props: { level: 2 }, content: "In a column" }] },
          { id: "c2", type: "column", children: [{ id: "p2", type: "paragraph", content: "Beside" }] },
        ],
      },
      { id: "t", type: "heading", props: { level: 2, isToggleable: true }, content: "Toggle", children: [{ id: "h4", type: "heading", props: { level: 1 }, content: "" }] },
    ];
    const doc = docOf(blocks);
    expect(headingsOfDoc(doc)).toEqual([
      { key: "h1", level: 1, text: "Intro" },
      { key: "h3", level: 3, text: "Nested" },
      { key: "h2", level: 2, text: "In a column" },
      { key: "t", level: 2, text: "Toggle" },
      { key: "h4", level: 1, text: "" },
    ]);
  });

  it("tells unchanged lists apart from changed ones", () => {
    const a = [{ key: "a", level: 1, text: "A" }];
    expect(sameHeadings(a, [{ key: "a", level: 1, text: "A" }])).toBe(true);
    expect(sameHeadings(a, [{ key: "a", level: 2, text: "A" }])).toBe(false);
    expect(sameHeadings(a, [])).toBe(false);
  });
});

describe("currentHeading", () => {
  it("is the last heading above the reading line", () => {
    expect(currentHeading([200, 600, 1200], 150)).toBe(-1);
    expect(currentHeading([-400, 100, 900], 150)).toBe(1);
    expect(currentHeading([-900, -500, -100], 150)).toBe(2);
  });

  it("skips headings that aren't shown", () => {
    expect(currentHeading([-400, null, 900], 150)).toBe(0);
  });
});
