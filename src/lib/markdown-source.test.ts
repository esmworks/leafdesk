import { describe, expect, it } from "vitest";
import { changedSyncedRegions, lineAnchors, markdownLosses, previewScrollTop } from "./markdown-source";

const paragraph = (text: string, props: Record<string, unknown> = {}, styles: Record<string, unknown> = {}) => ({
  type: "paragraph",
  props: { textColor: "default", backgroundColor: "default", textAlignment: "left", ...props },
  content: [{ type: "text", text, styles }],
  children: [],
});

describe("markdownLosses", () => {
  it("finds nothing when the blocks come back as they were, whatever their ids", () => {
    const before = [{ ...paragraph("One"), id: "a" }, { ...paragraph("Two"), id: "b" }];
    const after = [{ ...paragraph("One"), id: "x" }, { ...paragraph("Two"), id: "y" }];
    expect(markdownLosses(before, after)).toEqual([]);
  });

  it("names lost block colors and alignment", () => {
    expect(markdownLosses([paragraph("Red", { textColor: "red" })], [paragraph("Red")])).toEqual(["textColor"]);
    expect(markdownLosses([paragraph("Hi", { backgroundColor: "blue", textAlignment: "center" })], [paragraph("Hi")])).toEqual([
      "backgroundColor",
      "alignment",
    ]);
  });

  it("names lost text styles, colors apart from the rest", () => {
    expect(markdownLosses([paragraph("Under", {}, { underline: true })], [paragraph("Under")])).toEqual(["textStyle"]);
    expect(markdownLosses([paragraph("Mark", {}, { backgroundColor: "yellow" })], [paragraph("Mark")])).toEqual(["backgroundColor"]);
    // Bold survives Markdown: nothing lost.
    expect(markdownLosses([paragraph("Bold", {}, { bold: true })], [paragraph("Bold", {}, { bold: true })])).toEqual([]);
  });

  it("names image widths and callout settings", () => {
    const image = (props: Record<string, unknown>) => ({ type: "image", props: { url: "u", ...props }, children: [] });
    expect(markdownLosses([image({ previewWidth: 240 })], [image({ previewWidth: 512 })])).toEqual(["mediaSize"]);
    const callout = (props: Record<string, unknown>) => ({ type: "callout", props, content: [{ type: "text", text: "Hi", styles: {} }], children: [] });
    expect(markdownLosses([callout({ backgroundColor: "purple", icon: "🧪" })], [callout({ backgroundColor: "gray", icon: "🧪" })])).toEqual([
      "callout",
    ]);
  });

  it("names table layout apart from cell text", () => {
    const table = (widths: unknown[], cellColor: string, text: string) => ({
      type: "table",
      props: {},
      content: {
        type: "tableContent",
        columnWidths: widths,
        rows: [{ cells: [{ type: "tableCell", props: { backgroundColor: cellColor }, content: [{ type: "text", text, styles: {} }] }] }],
      },
      children: [],
    });
    expect(markdownLosses([table([120], "default", "A")], [table([null], "default", "A")])).toEqual(["table"]);
    expect(markdownLosses([table([null], "red", "A")], [table([null], "default", "A")])).toEqual(["table"]);
    expect(markdownLosses([table([null], "default", "A")], [table([null], "default", "B")])).toEqual(["content"]);
  });

  it("names merged cells as table layout when their text comes back in place", () => {
    const cell = (text: string, colspan = 1, rowspan = 1) => ({ type: "tableCell", props: { colspan, rowspan }, content: text ? [{ type: "text", text, styles: {} }] : [] });
    const table = (rows: ReturnType<typeof cell>[][]) => ({ type: "table", props: {}, content: { type: "tableContent", rows: rows.map((cells) => ({ cells })) }, children: [] });
    const merged = table([[cell("Wide", 2), cell("C")], [cell("Tall", 1, 2), cell("b1"), cell("c1")], [cell("b2"), cell("c2")]]);
    const flat = table([[cell("Wide"), cell(""), cell("C")], [cell("Tall"), cell("b1"), cell("c1")], [cell(""), cell("b2"), cell("c2")]]);
    expect(markdownLosses([merged], [flat])).toEqual(["table"]);
    // Text that would land where a merged cell was is content all the same.
    const moved = table([[cell("Wide"), cell("x"), cell("C")], [cell("Tall"), cell("b1"), cell("c1")], [cell(""), cell("b2"), cell("c2")]]);
    expect(markdownLosses([merged], [moved])).toEqual(["table", "content"]);
  });

  it("counts a missing block as lost content without blaming the blocks around it", () => {
    const before = [paragraph("One"), { type: "audio", props: {}, children: [] }, paragraph("Three", { textColor: "default" })];
    const after = [paragraph("One"), paragraph("Three")];
    expect(markdownLosses(before, after)).toEqual(["content"]);
  });

  it("compares nested blocks and inline nodes", () => {
    const withChild = (child: ReturnType<typeof paragraph>) => ({ ...paragraph("Parent"), children: [child] });
    expect(markdownLosses([withChild(paragraph("Kid", { textColor: "red" }))], [withChild(paragraph("Kid"))])).toEqual(["textColor"]);
    const mention = (id: string) => ({ type: "paragraph", props: {}, content: [{ type: "mention", props: { kind: "user", id } }], children: [] });
    expect(markdownLosses([mention("m1")], [mention("m1")])).toEqual([]);
    expect(markdownLosses([mention("m1")], [mention("m2")])).toEqual(["content"]);
  });

  it("treats a link's target as content", () => {
    const link = (href: string) => ({ type: "paragraph", props: {}, content: [{ type: "link", href, content: [{ type: "text", text: "go", styles: {} }] }], children: [] });
    expect(markdownLosses([link("https://a.test")], [link("https://a.test")])).toEqual([]);
    expect(markdownLosses([link("https://a.test")], [link("https://b.test")])).toEqual(["content"]);
  });
});

describe("changedSyncedRegions", () => {
  const region = (inner: string, syncId = "s1") =>
    `Intro\n\n<!-- leafdesk:synced-block p1 ${syncId} -->\n\n${inner}\n\n<!-- leafdesk:synced-block-end -->\n\nOutro`;

  const readOnly = ["p1:s1", "p1:s2"];

  it("counts synced blocks the reader can't edit whose lines were edited", () => {
    expect(changedSyncedRegions(region("Shared"), region("Shared"), readOnly)).toBe(0);
    expect(changedSyncedRegions(region("Shared"), region("Changed"), readOnly)).toBe(1);
    expect(changedSyncedRegions(region("Shared"), region("Shared").replace("Outro", "Other"), readOnly)).toBe(0);
  });

  it("doesn't count synced blocks the save writes to", () => {
    expect(changedSyncedRegions(region("Shared"), region("Changed"), [])).toBe(0);
  });

  it("leaves out synced blocks that were removed or added", () => {
    expect(changedSyncedRegions(region("Shared"), "Intro\n\nOutro", readOnly)).toBe(0);
    expect(changedSyncedRegions("Intro", region("New", "s2"), readOnly)).toBe(0);
  });
});

describe("lineAnchors", () => {
  it("pairs blocks with the source blocks that hold their text", () => {
    const starts = [
      { line: 0, text: "# Title" },
      { line: 2, text: "Some **bold** text" },
      { line: 4, text: "- First item" },
      { line: 5, text: "- Second item" },
      { line: 7, text: "[^1]: A note." },
    ];
    expect(lineAnchors(starts, ["Title", "Some bold text", "First item", "Second item"])).toEqual([
      { block: 0, line: 0 },
      { block: 1, line: 2 },
      { block: 2, line: 4 },
      { block: 3, line: 5 },
    ]);
  });

  it("reads links by their text and skips footnote marks and comments", () => {
    const starts = [
      { line: 0, text: "See [the docs](https://example.com/a) now[^1]" },
      { line: 2, text: "<!-- leafdesk:no-print -->\n> [!NOTE]\n> Careful here" },
    ];
    expect(lineAnchors(starts, ["See the docs now", "Careful here"])).toEqual([
      { block: 0, line: 0 },
      { block: 1, line: 2 },
    ]);
  });

  it("pairs blocks without text by position between matches", () => {
    const starts = [
      { line: 0, text: "Before" },
      { line: 2, text: "![](a.png)" },
      { line: 4, text: "---" },
      { line: 6, text: "After" },
    ];
    expect(lineAnchors(starts, ["Before", "", "", "After"])).toEqual([
      { block: 0, line: 0 },
      { block: 1, line: 2 },
      { block: 2, line: 4 },
      { block: 3, line: 6 },
    ]);
  });

  it("leaves out what it can't place, in order", () => {
    const starts = [
      { line: 0, text: "Alpha" },
      { line: 2, text: "<!-- leafdesk:columns -->" },
      { line: 3, text: "Beta" },
    ];
    // Two blocks without text against one source block: not placed. Beta still is.
    expect(lineAnchors(starts, ["Alpha", "", "", "Beta"])).toEqual([
      { block: 0, line: 0 },
      { block: 3, line: 3 },
    ]);
    // Repeated text goes to the next match, never back.
    expect(lineAnchors([{ line: 0, text: "Same" }, { line: 2, text: "Same" }], ["Same", "Same"])).toEqual([
      { block: 0, line: 0 },
      { block: 1, line: 2 },
    ]);
  });
});

describe("previewScrollTop", () => {
  const anchors = [
    { line: 10, top: 500 },
    { line: 20, top: 700 },
  ];
  const end = { line: 40, top: 1500 };

  it("interpolates between the anchors around the line", () => {
    expect(previewScrollTop(anchors, 10, end)).toBe(500);
    expect(previewScrollTop(anchors, 15, end)).toBe(600);
    expect(previewScrollTop(anchors, 30, end)).toBe(1100);
  });

  it("starts at the top and ends at the end", () => {
    expect(previewScrollTop(anchors, 0, end)).toBe(0);
    expect(previewScrollTop(anchors, 5, end)).toBe(250);
    expect(previewScrollTop(anchors, 40, end)).toBe(1500);
    expect(previewScrollTop(anchors, 50, end)).toBe(1500);
  });

  it("skips anchors that would scroll back up", () => {
    expect(previewScrollTop([{ line: 10, top: 500 }, { line: 20, top: 300 }], 20, end)).toBe(500 + (10 / 30) * 1000);
  });

  it("is a straight line without anchors", () => {
    expect(previewScrollTop([], 20, end)).toBe(750);
  });
});
