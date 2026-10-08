import { describe, expect, it } from "vitest";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { blocksToMarkdown, markdownToBlocks, serverEditor, type PageBlock } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

type Text = { type: "text"; text: string; styles: Record<string, unknown> };

/** The first block's inline content as text runs, links flattened. */
function runs(blocks: PageBlock[]): Text[] {
  const content = (blocks[0]?.content ?? []) as unknown as (Text | { type: "link"; content: Text[] })[];
  return content.flatMap((node) => (node.type === "link" ? node.content : [node]));
}

const styled = (blocks: PageBlock[], style: string) =>
  runs(blocks)
    .filter((run) => run.styles[style])
    .map((run) => run.text);

describe("superscript and subscript", () => {
  it("write their text between <sup> and <sub> tags", async () => {
    const markdown = await blocksToMarkdown([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "E = mc", styles: {} },
          { type: "text", text: "2", styles: { superscript: true } },
          { type: "text", text: " and H", styles: {} },
          { type: "text", text: "2", styles: { subscript: true } },
          { type: "text", text: "O", styles: {} },
        ],
      },
    ] as never);
    expect(markdown.trim()).toBe("E = mc<sup>2</sup> and H<sub>2</sub>O");
  });

  it("put the tags inside the text's emphasis and link", async () => {
    const markdown = await blocksToMarkdown([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a", styles: { bold: true, superscript: true } },
          { type: "text", text: " see ", styles: {} },
          { type: "link", href: "https://example.com/", content: [{ type: "text", text: "1", styles: { superscript: true } }] },
        ],
      },
    ] as never);
    expect(markdown.trim()).toBe("**<sup>a</sup>** see [<sup>1</sup>](https://example.com/)");
  });

  it("read back from Markdown", async () => {
    const blocks = await markdownToBlocks("E = mc<sup>2</sup> and H<sub>2</sub>O, **bold<sup>b</sup>** and [x<sup>1</sup>](https://example.com/)");
    expect(styled(blocks, "superscript")).toEqual(["2", "b", "1"]);
    expect(styled(blocks, "subscript")).toEqual(["2"]);
    expect(runs(blocks).find((run) => run.text === "b")?.styles).toEqual({ bold: true, superscript: true });
  });

  it("come back the same from a Markdown round trip", async () => {
    const markdown = "x<sup>2</sup> + **y<sub>i</sub>** and **x<sup>a*b*</sup>**, in a list:\n\n* a<sup>b</sup>\n\n| H<sub>2</sub>O | c<sup>3</sup> |\n| --- | --- |\n| 1 | 2 |";
    const once = await blocksToMarkdown(await markdownToBlocks(markdown));
    const twice = await blocksToMarkdown(await markdownToBlocks(once));
    expect(once).toBe(twice);
    for (const part of ["x<sup>2</sup>", "**<sub>i</sub>**", "**<sup>a</sup>**", "***<sup>b</sup>***", "a<sup>b</sup>", "H<sub>2</sub>O", "c<sup>3</sup>"]) {
      expect(once).toContain(part);
    }
    const blocks = await markdownToBlocks(once);
    expect(styled(blocks, "subscript")).toEqual(["i"]);
    expect(runs(blocks).find((run) => run.text === "b")?.styles).toEqual({ bold: true, italic: true, superscript: true });
  });

  it("are never both on the same text, nor on code: setting one takes the other off", () => {
    const schema = serverEditor.editor.pmSchema;
    const sup = schema.marks.superscript.create();
    const sub = schema.marks.subscript.create();
    expect(sub.addToSet([sup])).toEqual([sub]);
    expect(sup.addToSet([sub])).toEqual([sup]);
    expect(sup.addToSet([schema.marks.code.create()]).map((mark) => mark.type.name)).toEqual(["code"]);
    // Each still excludes itself, so the shared document stores it under its plain name.
    expect(sup.type.excludes(sup.type)).toBe(true);
  });

  it("survive the shared document and show as <sup>/<sub> on published pages", async () => {
    const doc = new Y.Doc();
    doc.transact(() =>
      serverEditor.blocksToYXmlFragment(
        [{ type: "paragraph", content: [{ type: "text", text: "x", styles: {} }, { type: "text", text: "2", styles: { superscript: true } }] }] as never,
        doc.getXmlFragment(COLLAB_FRAGMENT),
      ),
    );
    const blocks = serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
    expect(styled(blocks, "superscript")).toEqual(["2"]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    const html = segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).toContain("x<sup>2</sup>");
  });

  it("erase their block's whole text in an editor without them (why a tab of an older build never loads a page)", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    doc.transact(() =>
      serverEditor.blocksToYXmlFragment(
        [
          { type: "paragraph", content: [{ type: "text", text: "Hello x", styles: {} }, { type: "text", text: "2", styles: { superscript: true } }] },
          { type: "paragraph", content: "Second" },
        ] as never,
        fragment,
      ),
    );
    let synced = false;
    doc.on("update", () => (synced = true));
    const older = ServerBlockNoteEditor.create().yXmlFragmentToBlocks(fragment);
    expect(older.map((block) => block.content)).toEqual([[], [{ type: "text", text: "Second", styles: {} }]]);
    // The deletion is a change of the shared document, which a browser would send to everyone.
    expect(synced).toBe(true);
    expect(serverEditor.yXmlFragmentToBlocks(fragment)[0].content).toEqual([]);
  });

  it("are read from pasted HTML that sets vertical-align", async () => {
    const blocks = (await serverEditor.tryParseHTMLToBlocks(
      '<p>x<span style="vertical-align: super">2</span> H<span style="vertical-align:sub">2</span>O</p>',
    )) as PageBlock[];
    expect(styled(blocks, "superscript")).toEqual(["2"]);
    expect(styled(blocks, "subscript")).toEqual(["2"]);
  });
});
