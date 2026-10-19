import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { noteParts } from "@/lib/footnotes";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor } from "./blocknote";
import { bodySegmentsFromBlocks, bodySegmentsFromYdoc, type BodySegment } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

/** Blocks as the collab service would store them and read them back. */
const stored = (blocks: unknown[]) => serverEditor.yXmlFragmentToBlocks(docFrom(blocks).getXmlFragment(COLLAB_FRAGMENT));

const text = (value: string) => ({ type: "text", text: value, styles: {} });
const note = (value: string) => ({ type: "footnote", props: {}, content: value });

const html = (segments: BodySegment[]): string =>
  segments.map((s) => (s.kind === "html" ? s.html : s.kind === "columns" ? s.columns.map((c) => html(c.segments)).join("") : "")).join("");

describe("footnotes in the page body", () => {
  it("are known to the schema and keep their note through the Yjs document, as plain text", () => {
    expect(pageSchema.inlineContentSchema).toHaveProperty("footnote");
    const [block] = stored([
      {
        type: "paragraph",
        content: [text("Claim"), { type: "footnote", content: [{ type: "text", text: "The source.", styles: { bold: true } }] }, text(" more")],
      },
    ]);
    expect(block.content).toEqual([text("Claim"), note("The source."), text(" more")]);
    expect(stored([block])).toEqual([block]);
  });

  it("read as text apart from the sentence they mark", () => {
    const blocks = stored([{ type: "paragraph", content: [text("Claim"), note("The source."), text(" more")] }]);
    expect(blocksToPlainText(blocks).replace(/\s+/g, " ")).toBe("Claim The source. more");
  });
});

describe("footnotes in Markdown", () => {
  it("are numbered in the order the Markdown has them, with their notes at the end", async () => {
    const blocks = stored([
      // The callout's nested blocks are prepared before its text, but written after it.
      { type: "callout", props: { icon: "", backgroundColor: "gray" }, content: [text("First"), note("One")], children: [{ type: "paragraph", content: [text("Second"), note("Two")] }] },
      { type: "paragraph", content: [text("Third"), note("Three\nlines"), text(" and an empty one"), note("")] },
      { type: "heading", props: { level: 2 }, content: [text("Heading"), note("Four with *stars* and $5")] },
    ]);
    expect((await blocksToMarkdown(blocks)).trim()).toBe(
      [
        "> [!NOTE]",
        "> First[^1]",
        ">",
        "> Second[^2]",
        "",
        "Third[^3] and an empty one",
        "",
        "## Heading[^4]",
        "",
        "[^1]: One",
        "[^2]: Two",
        "[^3]: Three lines",
        "[^4]: Four with *stars* and $5",
      ].join("\n"),
    );
  });

  it("read back into the same footnotes, wherever their notes are", async () => {
    const markdown = [
      "Claim[^a] and again[^a], [unknown][^none] and `code [^a]`.",
      "",
      "[^a]: The source,",
      "    continued on a second line.",
      "",
      "| Cell[^b] |",
      "| --- |",
      "",
      "[A link[^b]](https://example.com)",
      "",
      "> [!TIP]",
      "> In a callout[^b]",
      "",
      "```",
      "[^b] stays in code",
      "```",
      "",
      "[^b]: Second note.",
      "[^unused]: Nothing refers to me.",
    ].join("\n");
    const blocks = await markdownToBlocks(markdown);
    expect(blocks[0].content).toEqual([
      text("Claim"),
      note("The source, continued on a second line."),
      text(" and again"),
      note("The source, continued on a second line."),
      text(", [unknown][^none] and "),
      { type: "text", text: "code [^a]", styles: { code: true } },
      text("."),
    ]);
    const table = blocks.find((b) => b.type === "table")!;
    expect(JSON.stringify(table.content)).toContain(JSON.stringify(note("Second note.")));
    // A link's text can't hold a footnote: the reference stays as it was.
    const link = blocks.find((b) => JSON.stringify(b.content).includes('"link"'))!;
    expect(link.content).toEqual([{ type: "link", href: "https://example.com", content: [text("A link[^b]")] }]);
    const callout = blocks.find((b) => b.type === "callout")!;
    expect(callout.content).toEqual([text("In a callout"), note("Second note.")]);
    const code = blocks.find((b) => b.type === "codeBlock")!;
    expect(code.content).toEqual([text("[^b] stays in code")]);
    // A note nothing refers to stays as text; the others leave the body.
    const rest = blocksToPlainText(blocks);
    expect(rest).toContain("[^unused]: Nothing refers to me.");
    expect(rest).not.toContain("[^a]:");
    expect(rest).not.toContain("[^b]:");
  });

  it("write the same Markdown after a round trip", async () => {
    const markdown = ["Claim[^1] and more[^2].", "", "* In a list[^3]", "", "[^1]: One", "[^2]: Two https://example.com/a_(b)", "[^3]: Three"].join("\n");
    const blocks = stored(await markdownToBlocks(markdown));
    expect((await blocksToMarkdown(blocks)).trim()).toBe(markdown);
  });
});

describe("callouts hidden in print", () => {
  const hidden = { type: "callout", props: { icon: "🔒", backgroundColor: "yellow", hideInPrint: true }, content: "Internal: up to 12% off" };

  it("keep the setting through the Yjs document", () => {
    const [block] = stored([hidden]);
    expect(block.props).toMatchObject({ hideInPrint: true });
    expect(stored([{ ...hidden, props: { icon: "" } }])[0].props).toMatchObject({ hideInPrint: false });
  });

  it("are written with a marker line right before them, and read back hidden", async () => {
    const blocks = stored([
      hidden,
      { type: "callout", props: { icon: "", backgroundColor: "gray" }, content: "Outer", children: [{ ...hidden, content: "Nested" }] },
      { type: "callout", props: { icon: "", backgroundColor: "gray" }, content: "Shown" },
    ]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(
      [
        "<!-- leafdesk:no-print -->",
        "> [!WARNING]",
        "> 🔒 Internal: up to 12% off",
        "",
        "> [!NOTE]",
        "> Outer",
        ">",
        "> <!-- leafdesk:no-print -->",
        "> > [!WARNING]",
        "> > 🔒 Nested",
        "",
        "> [!NOTE]",
        "> Shown",
      ].join("\n"),
    );
    const again = stored(await markdownToBlocks(markdown));
    expect(again[0].props).toMatchObject({ hideInPrint: true, icon: "🔒" });
    expect(again[1].children[0].props).toMatchObject({ hideInPrint: true });
    expect(again[2].props).toMatchObject({ hideInPrint: false });
    expect((await blocksToMarkdown(again)).trim()).toBe(markdown);
  });

  it("leave the marker as it is when no callout follows it", async () => {
    const blocks = await markdownToBlocks("<!-- leafdesk:no-print -->\n\nText");
    expect(blocks.some((b) => b.type === "callout")).toBe(false);
  });
});

describe("footnotes and hidden callouts on published pages", () => {
  it("number footnotes across the body, columns included, and list their notes at the end", async () => {
    const doc = docFrom([
      { type: "paragraph", content: [text("One"), note('Note "1" <b>'), text(" empty"), note("")] },
      {
        type: "columnList",
        children: [
          { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [text("Two"), note("Note 2")] }] },
          { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [text("Three"), note("Note 3")] }] },
        ],
      },
      { type: "mermaid", content: "graph TD\n  A-->B" },
      { type: "paragraph", content: [text("Four"), note("Note 4")] },
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => s.kind)).toEqual(["html", "columns", "mermaid", "html", "footnotes"]);
    expect(segments.at(-1)).toEqual({
      kind: "footnotes",
      notes: [1, 2, 3, 4].map((n) => ({
        anchor: `footnote-${n}`,
        refAnchor: `footnote-ref-${n}`,
        text: n === 1 ? 'Note "1" <b>' : `Note ${n}`,
      })),
    });
    const body = html(segments);
    expect(body).toContain('<sup id="footnote-ref-1" data-footnote-ref=""><a href="#footnote-1" title="Note &quot;1&quot; <b>">1</a></sup>');
    expect(body).toContain('<a href="#footnote-3" title="Note 3">3</a>');
    expect(body).not.toContain("data-leafdesk-footnote");
  });

  it("give the anchors a prefix, and leave out callouts hidden in print in the print view", async () => {
    const blocks = stored([
      { type: "callout", props: { icon: "", backgroundColor: "gray", hideInPrint: true }, content: [text("Hidden"), note("Gone")], children: [{ type: "paragraph", content: "Under it" }] },
      { type: "paragraph", content: [text("Kept"), note("Shown")] },
    ]);
    const screen = await bodySegmentsFromBlocks(blocks);
    expect(html(screen)).toContain('data-hide-in-print="true"');
    expect(html(screen)).toContain("Under it");
    const print = await bodySegmentsFromBlocks(blocks, { print: true, anchorPrefix: "p2-" });
    expect(html(print)).not.toContain("Hidden");
    expect(html(print)).not.toContain("Under it");
    expect(print.at(-1)).toEqual({ kind: "footnotes", notes: [{ anchor: "p2-footnote-1", refAnchor: "p2-footnote-ref-1", text: "Shown" }] });
  });
});

describe("a note's addresses", () => {
  it("become links without the punctuation after them", () => {
    expect(noteParts("See https://example.com/a. Or (https://w.org/Foo_(bar)), done")).toEqual([
      { text: "See " },
      { url: "https://example.com/a" },
      { text: ". Or (" },
      { url: "https://w.org/Foo_(bar)" },
      { text: "), done" },
    ]);
    expect(noteParts("No address here, nor in javascript:alert(1) or https://")).toEqual([
      { text: "No address here, nor in javascript:alert(1) or https://" },
    ]);
  });
});
