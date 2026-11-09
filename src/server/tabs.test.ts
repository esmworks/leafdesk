import { EditorState, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { ySyncPluginKey, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { listedBlocks } from "@/lib/block-edits";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { flattenBlocks } from "@/lib/page-diff";
import { tidyColumns } from "@/lib/page-review";
import { TAB_EDIT, tabGuard } from "@/lib/tab-guard";
import { groupTabs, parseTabMarker, TAB_MARKER_BLOCK, tabMarkerBlock, tabMarkerLine, tabTitle } from "@/lib/tabs";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor, type PageBlock } from "./blocknote";
import { bodyHtmlFromYdoc, bodySegmentsFromYdoc, type BodySegment } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));

/** Block types as a compact tree: "tabList(tab(paragraph),tab(heading))". */
const shape = (blocks: PageBlock[]): string => blocks.map((b) => b.type + (b.children?.length ? `(${shape(b.children)})` : "")).join(",");

const P = (text: string) => ({ type: "paragraph", content: text });
const tabs = (...list: { title?: string; blocks: unknown[] }[]) => ({
  type: "tabList",
  children: list.map((t) => ({ type: "tab", props: t.title === undefined ? {} : { title: t.title }, children: t.blocks })),
});

const sample = [
  P("Intro"),
  tabs(
    { title: "Overview", blocks: [{ type: "heading", props: { level: 2 }, content: "Goals" }, { type: "bulletListItem", content: "one" }] },
    { title: 'Say "hi" --> <b>', blocks: [P("Second")] },
  ),
  P("After"),
];

const SAMPLE_MARKDOWN = [
  "Intro",
  "",
  "<!-- leafdesk:tabs -->",
  "",
  '<!-- leafdesk:tab "Overview" -->',
  "",
  "## Goals",
  "",
  "* one",
  "",
  '<!-- leafdesk:tab "Say \\"hi\\" \\u002d\\u002d\\u003e \\u003cb\\u003e" -->',
  "",
  "Second",
  "",
  "<!-- leafdesk:/tabs -->",
  "",
  "After",
].join("\n");

describe("tabs in the server schema", () => {
  it("are known to the schema", () => {
    expect(pageSchema.blockSchema).toHaveProperty("tabList");
    expect(pageSchema.blockSchema).toHaveProperty("tab");
  });

  it("round-trip through the Yjs document with their titles", () => {
    const blocks = stored(sample);
    expect(shape(blocks)).toBe("paragraph,tabList(tab(heading,bulletListItem),tab(paragraph)),paragraph");
    expect(blocks[1].children.map((t) => t.props)).toEqual([{ title: "Overview" }, { title: 'Say "hi" --> <b>' }]);
    expect(stored(blocks)).toEqual(blocks);
  });

  it("keep every tab's text searchable, and read as plain blocks to the history and to block edits", () => {
    const blocks = stored(sample);
    expect(blocksToPlainText(blocks)).toBe("Intro\nGoals\none\nSecond\nAfter");
    expect(flattenBlocks(blocks).map((b) => `${b.type}@${b.depth}`)).toEqual(["paragraph@0", "heading@0", "bulletListItem@0", "paragraph@0", "paragraph@0"]);
    expect(listedBlocks(blocks as never).map((b) => b.type)).toEqual(["paragraph", "heading", "bulletListItem", "paragraph", "paragraph"]);
  });

  it("drop tabs left empty after an undo, and the list when no tab is left", () => {
    const out = tidyColumns([
      { type: "tabList", children: [{ type: "tab", props: { title: "A" }, children: [] }, { type: "tab", children: [P("b")] }] },
      { type: "tabList", children: [{ type: "tab", children: [] }] },
    ] as never);
    expect(out.map((b) => b.type)).toEqual(["tabList"]);
    expect(out[0].children).toHaveLength(1);
  });
});

describe("tabs in Markdown", () => {
  it("are written as marker comments around their blocks, titles escaped", async () => {
    expect((await blocksToMarkdown(stored(sample))).trim()).toBe(SAMPLE_MARKDOWN);
  });

  it("read back to the same tabs, and write the same Markdown again", async () => {
    const blocks = stored(await markdownToBlocks(SAMPLE_MARKDOWN));
    expect(shape(blocks)).toBe("paragraph,tabList(tab(heading,bulletListItem),tab(paragraph)),paragraph");
    expect(blocks[1].children.map((t) => t.props)).toEqual([{ title: "Overview" }, { title: 'Say "hi" --> <b>' }]);
    expect((await blocksToMarkdown(blocks)).trim()).toBe(SAMPLE_MARKDOWN);
  });

  it("hold columns, and in a column become their blocks", async () => {
    const markdown = [
      "<!-- leafdesk:tabs -->",
      '<!-- leafdesk:tab "A" -->',
      "<!-- leafdesk:columns -->",
      "<!-- leafdesk:column -->",
      "left",
      "<!-- leafdesk:column -->",
      "right",
      "<!-- leafdesk:/columns -->",
      "<!-- leafdesk:/tabs -->",
      "<!-- leafdesk:columns -->",
      "<!-- leafdesk:column -->",
      "<!-- leafdesk:tabs -->",
      "<!-- leafdesk:tab -->",
      "inside",
      "<!-- leafdesk:/tabs -->",
      "<!-- leafdesk:column -->",
      "beside",
      "<!-- leafdesk:/columns -->",
    ].join("\n");
    const blocks = stored(await markdownToBlocks(markdown));
    expect(shape(blocks)).toBe("tabList(tab(columnList(column(paragraph),column(paragraph)))),columnList(column(paragraph),column(paragraph))");
    expect(shape(stored(await markdownToBlocks(await blocksToMarkdown(blocks))))).toBe(shape(blocks));
  });

  it("are read leniently", async () => {
    // Blocks before the first "tab" make an untitled tab; no "/tabs" runs to the end; nested tabs flatten.
    let blocks = stored(
      await markdownToBlocks('<!-- leafdesk:tabs -->\nA\n<!-- leafdesk:tab "B" -->\nB\n<!-- leafdesk:tabs -->\n<!-- leafdesk:tab "C" -->\nC'),
    );
    expect(shape(blocks)).toBe("tabList(tab(paragraph),tab(paragraph),tab(paragraph))");
    expect(blocks[0].children.map((t) => (t.props as { title?: string }).title)).toEqual(["", "B", "C"]);
    // A tab without blocks gets an empty line; stray markers are dropped.
    blocks = stored(await markdownToBlocks('<!-- leafdesk:tab "x" -->\nX\n<!-- leafdesk:tabs -->\n<!-- leafdesk:tab -->\n<!-- leafdesk:/tabs -->\nZ'));
    expect(shape(blocks)).toBe("paragraph,tabList(tab(paragraph)),paragraph");
    // At most twelve tabs: the rest joins the twelfth.
    const many = ["<!-- leafdesk:tabs -->", ...Array.from({ length: 14 }, (_, n) => [`<!-- leafdesk:tab "T${n}" -->`, `B${n}`]).flat()];
    blocks = stored(await markdownToBlocks(many.join("\n")));
    expect(blocks[0].children).toHaveLength(12);
    expect(blocksToPlainText(blocks[0].children[11].children)).toBe("B11\nB12\nB13");
    // Inside fenced code the markers are just text.
    expect(shape(stored(await markdownToBlocks("```\n<!-- leafdesk:tabs -->\n```")))).toBe("codeBlock");
  });

  it("parse and write marker lines", () => {
    expect(parseTabMarker("<!-- leafdesk:tabs -->")).toEqual({ kind: "tabs" });
    expect(parseTabMarker("  <!--leafdesk:tab-->")).toEqual({ kind: "tab", title: "" });
    expect(parseTabMarker('<!-- leafdesk:tab "A  b" -->')).toEqual({ kind: "tab", title: "A b" });
    expect(parseTabMarker('<!-- leafdesk:tab "\\u00" -->')).toEqual({ kind: "tab", title: "" });
    expect(parseTabMarker("<!-- leafdesk:tab title -->")).toBeNull();
    expect(parseTabMarker("<!-- leafdesk:/tabs -->")).toEqual({ kind: "end" });
    expect(parseTabMarker("text <!-- leafdesk:tabs -->")).toBeNull();
    expect(tabMarkerLine({ kind: "tab", title: "  " })).toBe("<!-- leafdesk:tab -->");
    expect(parseTabMarker(tabMarkerLine({ kind: "tab", title: "a-->b" }))).toEqual({ kind: "tab", title: "a-->b" });
    expect(tabTitle("x".repeat(200))).toHaveLength(80);
    expect(tabTitle(5)).toBe("");
    // A long run of escapes or quotes never makes the reader retry (no catastrophic backtracking).
    const started = Date.now();
    parseTabMarker(`<!-- leafdesk:tab "${"\\".repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("group markers at any depth and leave no marker behind", () => {
    const out = groupTabs([{ type: "bulletListItem", children: [tabMarkerBlock({ kind: "tabs" }), P("a"), tabMarkerBlock({ kind: "tab", title: "b" }), P("b")] }] as never[]) as {
      type: string;
      children?: { type: string }[];
    }[];
    expect(out[0].children?.map((b) => b.type)).toEqual(["tabList"]);
    expect(JSON.stringify(out)).not.toContain(TAB_MARKER_BLOCK);
  });
});

/** Segment kinds as a compact tree: "html,tabs[html|mermaid,html]". */
const kinds = (segments: BodySegment[]): string =>
  segments
    .map((s) =>
      s.kind === "tabs"
        ? `tabs[${s.tabs.map((t) => kinds(t.segments)).join("|")}]`
        : s.kind === "columns"
          ? `columns[${s.columns.map((c) => kinds(c.segments)).join("|")}]`
          : s.kind,
    )
    .join(",");

describe("tabs on published pages", () => {
  it("come back as a tabs segment with each tab's title and segments", async () => {
    const doc = docFrom([
      { type: "tableOfContents" },
      tabs({ title: "One", blocks: [{ type: "heading", props: { level: 2 }, content: "First" }] }, { blocks: [{ type: "mermaid", content: "graph TD\n  A-->B" }, P("x")] }),
      P("After"),
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(kinds(segments)).toBe("toc,tabs[html|mermaid,html],html");
    const tabList = segments[1].kind === "tabs" ? segments[1].tabs : [];
    expect(tabList.map((t) => t.title)).toEqual(["One", ""]);
    expect(segments[0].kind === "toc" && segments[0].headings.map((h) => h.text)).toEqual(["First"]);
    expect(JSON.stringify(segments)).not.toMatch(/data-node-type=\\"tab|leafdesk-tab/);
  });

  it("join every tab's HTML for the plain body", async () => {
    const doc = docFrom([tabs({ blocks: [P("alpha")] }, { blocks: [P("beta")] })]);
    const html = await bodyHtmlFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });
});

describe("the editor's tab guard", () => {
  const editorState = () => {
    const doc = docFrom([P("Intro"), tabs({ title: "A", blocks: [P("alpha")] }, { title: "B", blocks: [P("beta")] }, { title: "C", blocks: [P("gamma")] }), P("After")]);
    return EditorState.create({ doc: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(COLLAB_FRAGMENT), serverEditor.editor.pmSchema), plugins: [tabGuard] });
  };
  /** Where the text `text` starts (or ends) in the document. */
  const at = (state: EditorState, text: string, edge: "start" | "end" = "start") => {
    let found = -1;
    state.doc.descendants((node, pos) => {
      if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + (edge === "end" ? node.content.size : 0);
      return found < 0;
    });
    return found;
  };
  const titles = (state: EditorState) => {
    const out: string[] = [];
    state.doc.descendants((node) => {
      if (node.type.name !== "tab") return true;
      out.push(String(node.attrs.title));
      return false;
    });
    return out;
  };
  const apply = (state: EditorState, change: (state: EditorState) => Transaction) => state.applyTransaction(change(state)).state;

  it("refuses an edit that deletes tabs it doesn't show, or joins two", () => {
    const state = editorState();
    // Without the guard these edits do take tabs out.
    const bare = EditorState.create({ doc: state.doc });
    expect(titles(apply(bare, (s) => s.tr.delete(at(s, "alpha", "end"), at(s, "After"))))).toEqual(["A"]);
    expect(titles(apply(bare, (s) => s.tr.delete(at(s, "alpha") + 2, at(s, "beta") + 2)))).toEqual(["A", "C"]);
    // The browser joining "After" with the tab that shows, across the hidden ones.
    expect(titles(apply(state, (s) => s.tr.delete(at(s, "alpha", "end"), at(s, "After"))))).toEqual(["A", "B", "C"]);
    // A selection from one tab's text into the next one's.
    expect(titles(apply(state, (s) => s.tr.delete(at(s, "alpha") + 2, at(s, "beta") + 2)))).toEqual(["A", "B", "C"]);
    expect(apply(state, (s) => s.tr.delete(at(s, "alpha", "end"), at(s, "After"))).doc.eq(state.doc)).toBe(true);
  });

  it("lets through typing, the strip's own changes, a whole list going, and others' changes", () => {
    const state = editorState();
    expect(apply(state, (s) => s.tr.insertText("!", at(s, "beta", "end"))).doc.textContent).toContain("beta!");
    const tabB = at(state, "beta") - 3;
    expect(state.doc.nodeAt(tabB)?.type.name).toBe("tab");
    const removeB = (s: EditorState) => s.tr.delete(tabB, tabB + s.doc.nodeAt(tabB)!.nodeSize);
    expect(titles(apply(state, (s) => removeB(s).setMeta(TAB_EDIT, true)))).toEqual(["A", "C"]);
    expect(titles(apply(state, (s) => removeB(s).setMeta(ySyncPluginKey, { isChangeOrigin: true })))).toEqual(["A", "C"]);
    expect(titles(apply(state, removeB))).toEqual(["A", "B", "C"]);
    const list = tabB - 1 - state.doc.nodeAt(at(state, "alpha") - 3)!.nodeSize;
    expect(state.doc.nodeAt(list)?.type.name).toBe("tabList");
    expect(titles(apply(state, (s) => s.tr.delete(list, list + s.doc.nodeAt(list)!.nodeSize)))).toEqual([]);
  });
});
