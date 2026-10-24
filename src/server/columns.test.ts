import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { COLUMN_MARKER_BLOCK, columnMarkerBlock, columnMarkerLine, columnWidth, groupColumns, parseColumnMarker } from "@/lib/columns";
import { referenceLine } from "@/lib/embed-blocks";
import { flattenBlocks } from "@/lib/page-diff";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor, type PageBlock } from "./blocknote";
import { bodyHtmlFromYdoc, bodySegmentsFromYdoc, type BodySegment } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));

/** Block types as a compact tree: "columnList(column(paragraph),column(heading,paragraph))". */
const shape = (blocks: PageBlock[]): string =>
  blocks.map((b) => b.type + (b.children?.length ? `(${shape(b.children)})` : "")).join(",");

const P = (text: string) => ({ type: "paragraph", content: text });
const columns = (...cols: { width?: number; blocks: unknown[] }[]) => ({
  type: "columnList",
  children: cols.map((c) => ({ type: "column", props: c.width ? { width: c.width } : {}, children: c.blocks })),
});

const sample = [
  P("Intro"),
  columns(
    { blocks: [{ type: "heading", props: { level: 2 }, content: "Left" }, { type: "bulletListItem", content: "one" }, { type: "bulletListItem", content: "two" }] },
    { width: 2, blocks: [P("Right $5"), { type: "callout", props: { icon: "💡", backgroundColor: "gray" }, content: "Note" }] },
  ),
  P("After"),
];

const SAMPLE_MARKDOWN = [
  "Intro",
  "",
  "<!-- leafdesk:columns -->",
  "",
  "<!-- leafdesk:column -->",
  "",
  "## Left",
  "",
  "* one",
  "* two",
  "",
  "<!-- leafdesk:column width=2 -->",
  "",
  "Right \\$5",
  "",
  "> [!NOTE]",
  "> 💡 Note",
  "",
  "<!-- leafdesk:/columns -->",
  "",
  "After",
].join("\n");

describe("columns in the server schema", () => {
  it("are known to the schema", () => {
    expect(pageSchema.blockSchema).toHaveProperty("columnList");
    expect(pageSchema.blockSchema).toHaveProperty("column");
  });

  it("round-trip through the Yjs document with their widths", () => {
    const blocks = stored(sample);
    expect(shape(blocks)).toBe("paragraph,columnList(column(heading,bulletListItem,bulletListItem),column(paragraph,callout)),paragraph");
    const [left, right] = blocks[1].children;
    expect(left.props).toEqual({ width: 1 });
    expect(right.props).toEqual({ width: 2 });
    expect(stored(blocks)).toEqual(blocks);
  });

  it("keep their text searchable and out of the way of the history diff", () => {
    const blocks = stored(sample);
    expect(blocksToPlainText(blocks)).toBe("Intro\nLeft\none\ntwo\nRight $5\nNote\nAfter");
    // The columns themselves aren't blocks to compare: their blocks read as if in sequence.
    expect(flattenBlocks(blocks).map((b) => `${b.type}@${b.depth}`)).toEqual([
      "paragraph@0",
      "heading@0",
      "bulletListItem@0",
      "bulletListItem@0",
      "paragraph@0",
      "callout@0",
      "paragraph@0",
    ]);
  });
});

describe("columns in Markdown", () => {
  it("are written as marker comments around their blocks", async () => {
    expect((await blocksToMarkdown(stored(sample))).trim()).toBe(SAMPLE_MARKDOWN);
  });

  it("read back to the same columns, and write the same Markdown again", async () => {
    const blocks = stored(await markdownToBlocks(SAMPLE_MARKDOWN));
    expect(shape(blocks)).toBe("paragraph,columnList(column(heading,bulletListItem,bulletListItem),column(paragraph,callout)),paragraph");
    expect(blocks[1].children.map((c) => c.props)).toEqual([{ width: 1 }, { width: 2 }]);
    expect(blocks[1].children[1].children[1].props).toMatchObject({ icon: "💡", backgroundColor: "gray" });
    expect((await blocksToMarkdown(blocks)).trim()).toBe(SAMPLE_MARKDOWN);
  });

  it("keep how wide a list reaches, in the document and in Markdown", async () => {
    const wide = { ...columns({ blocks: [P("a")] }, { blocks: [P("b")] }), props: { wide: 0.5 } };
    const blocks = stored([wide]);
    expect(blocks[0].props).toEqual({ wide: 0.5 });
    const markdown = await blocksToMarkdown(blocks);
    expect(markdown).toContain("<!-- leafdesk:columns wide=0.5 -->");
    expect(stored(await markdownToBlocks(markdown))[0].props).toEqual({ wide: 0.5 });
    expect(stored(sample)[1].props).toEqual({ wide: 0 });
  });

  it("keep an empty column, and a database block inside a column", async () => {
    const markdown = [
      "<!-- leafdesk:columns -->",
      "<!-- leafdesk:column -->",
      referenceLine("database", "db-1"),
      "Below the database",
      "<!-- leafdesk:column -->",
      "<!-- leafdesk:/columns -->",
    ].join("\n");
    const blocks = stored(await markdownToBlocks(markdown));
    expect(shape(blocks)).toBe("columnList(column(database,paragraph),column(paragraph))");
    expect(blocks[0].children[0].children[0].props).toMatchObject({ databaseId: "db-1" });
    const again = (await blocksToMarkdown(blocks)).trim();
    expect(again).toContain(`<!-- leafdesk:column -->\n\n${referenceLine("database", "db-1")}`);
    expect(shape(stored(await markdownToBlocks(again)))).toBe(shape(blocks));
  });

  it("are read leniently", async () => {
    // No "/columns": the list runs to the end; blocks before the first "column" join the first.
    let blocks = stored(await markdownToBlocks("<!-- leafdesk:columns -->\nA\n<!-- leafdesk:column -->\nB\n<!-- leafdesk:column -->\nC"));
    expect(shape(blocks)).toBe("columnList(column(paragraph,paragraph),column(paragraph))");
    // One column is no columns: just its blocks. Stray markers are dropped.
    blocks = stored(await markdownToBlocks("<!-- leafdesk:column -->\nX\n<!-- leafdesk:columns -->\n<!-- leafdesk:column -->\nY\n<!-- leafdesk:/columns -->\nZ"));
    expect(shape(blocks)).toBe("paragraph,paragraph,paragraph");
    expect(blocksToPlainText(blocks)).toBe("X\nY\nZ");
    // At most five columns: the rest joins the fifth.
    const six = ["<!-- leafdesk:columns -->", ...[1, 2, 3, 4, 5, 6].flatMap((n) => ["<!-- leafdesk:column -->", `C${n}`]), "<!-- leafdesk:/columns -->"];
    blocks = stored(await markdownToBlocks(six.join("\n")));
    expect(blocks[0].children).toHaveLength(5);
    expect(blocksToPlainText(blocks[0].children[4].children)).toBe("C5\nC6");
    // Inside fenced code the markers are just text.
    blocks = stored(await markdownToBlocks("```\n<!-- leafdesk:columns -->\n```"));
    expect(shape(blocks)).toBe("codeBlock");
  });

  it("parse and write marker lines", () => {
    expect(parseColumnMarker("<!-- leafdesk:columns -->")).toEqual({ kind: "columns" });
    expect(parseColumnMarker("  <!--leafdesk:column width=1.5-->")).toEqual({ kind: "column", width: 1.5 });
    expect(parseColumnMarker("<!-- leafdesk:/columns -->")).toEqual({ kind: "end" });
    expect(parseColumnMarker("<!-- leafdesk:column width=abc -->")).toBeNull();
    expect(parseColumnMarker("text <!-- leafdesk:columns -->")).toBeNull();
    expect(columnMarkerLine({ kind: "column", width: 1 })).toBe("<!-- leafdesk:column -->");
    expect(columnMarkerLine({ kind: "column", width: 0.004 })).toBe("<!-- leafdesk:column width=0.1 -->");
    expect(parseColumnMarker("<!-- leafdesk:columns wide=1 -->")).toEqual({ kind: "columns", wide: 1 });
    expect(parseColumnMarker("<!-- leafdesk:columns wide=0 -->")).toEqual({ kind: "columns" });
    expect(columnMarkerLine({ kind: "columns", wide: 3 })).toBe("<!-- leafdesk:columns wide=1 -->");
    expect(columnWidth("junk")).toBe(1);
    expect(columnWidth(99)).toBe(10);
  });

  it("group markers at any depth and leave no marker behind", () => {
    const out = groupColumns([
      { type: "bulletListItem", children: [columnMarkerBlock({ kind: "columns" }), P("a"), columnMarkerBlock({ kind: "column", width: 1 }), columnMarkerBlock({ kind: "column", width: 1 }), P("b")] },
    ] as never[]) as { type: string; children?: { type: string }[] }[];
    expect(out[0].children?.map((b) => b.type)).toEqual(["columnList"]);
    expect(JSON.stringify(out)).not.toContain(COLUMN_MARKER_BLOCK);
  });
});

/** Segment kinds as a compact tree: "html,columns[html|mermaid,html]". */
const kinds = (segments: BodySegment[]): string =>
  segments.map((s) => (s.kind === "columns" ? `columns[${s.columns.map((c) => kinds(c.segments)).join("|")}]` : s.kind)).join(",");

describe("columns on published pages", () => {
  it("come back as a columns segment with each column's own segments", async () => {
    const doc = docFrom([
      { type: "tableOfContents" },
      { type: "heading", props: { level: 1 }, content: "Top" },
      columns(
        { blocks: [{ type: "heading", props: { level: 2 }, content: "Left" }, P("Left text")] },
        { width: 1.5, blocks: [{ type: "mermaid", content: "graph TD\n  A-->B" }, { type: "heading", props: { level: 2 }, content: "Right" }] },
      ),
      P("After"),
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(kinds(segments)).toBe("toc,html,columns[html|mermaid,html],html");
    const cols = segments[2].kind === "columns" ? segments[2].columns : [];
    expect(cols.map((c) => c.width)).toEqual([1, 1.5]);
    // Headings in columns get anchors in reading order, and the table of contents lists them.
    const left = cols[0].segments[0];
    expect(left.kind === "html" && left.html).toContain('<h2 id="heading-2"');
    const right = cols[1].segments[1];
    expect(right.kind === "html" && right.html).toContain('<h2 id="heading-3"');
    expect(segments[0].kind === "toc" && segments[0].headings.map((h) => h.text)).toEqual(["Top", "Left", "Right"]);
    // No column markup of the editor leaks into the published HTML.
    expect(JSON.stringify(segments)).not.toMatch(/data-node-type=\\"column|leafdesk-column/);
  });

  it("clean links inside columns like everywhere else, and join their HTML for the plain body", async () => {
    const doc = docFrom([
      columns(
        { blocks: [{ type: "paragraph", content: [{ type: "link", href: "javascript:alert(1)", content: "bad" }] }] },
        { blocks: [{ type: "paragraph", content: [{ type: "link", href: "https://example.com", content: "good" }] }] },
      ),
    ]);
    const html = await bodyHtmlFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
    expect(html).toContain('href="https://example.com"');
  });

  it("show a column list nested under another block after that block", async () => {
    const doc = docFrom([{ type: "bulletListItem", content: "Item", children: [columns({ blocks: [P("x")] }, { blocks: [P("y")] })] }]);
    expect(kinds(await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc)))).toBe("html,columns[html|html]");
  });
});
