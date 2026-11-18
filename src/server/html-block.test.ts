import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { htmlAnswer, MAX_HTML_SOURCE } from "@/lib/html-block";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}
const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));

const SOURCE = `<div id="out">$5 and \`code\`</div>
<script>
  const total = [1, 2, 3].reduce((a, b) => a + b, 0);
  document.getElementById("out").textContent = "\`\`\`" + total;
</script>`;

describe("the HTML block", () => {
  it("is known to the schema and keeps its props through the Yjs document", () => {
    expect(pageSchema.blockSchema).toHaveProperty("html");
    const [block] = stored([{ type: "html", props: { source: SOURCE, title: "Totals", height: 320 } }]);
    expect(block.type).toBe("html");
    expect(block.props).toMatchObject({ source: SOURCE, title: "Totals", height: 320 });
  });

  it("is written as a marker and a fence longer than any backticks in the source, and read back", async () => {
    const blocks = stored([{ type: "html", props: { source: SOURCE, title: "Totals --> done", height: 320 } }]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown.split("\n")[0]).toBe('<!-- leafdesk:html {"title":"Totals --\\u003e done","height":320} -->');
    expect(markdown.split("\n")[1]).toBe("````html");
    expect(markdown.endsWith("````")).toBe(true);
    const back = stored(await markdownToBlocks(markdown));
    expect(back).toHaveLength(1);
    expect(back[0].type).toBe("html");
    expect(back[0].props).toMatchObject({ source: SOURCE, title: "Totals --> done", height: 320 });
    expect((await blocksToMarkdown(back)).trim()).toBe(markdown);
  });

  it("reads a bare marker before a fence, between other blocks, and leaves a marker without a fence alone", async () => {
    const blocks = stored(await markdownToBlocks("Before\n\n<!-- leafdesk:html -->\n\n```html\n<b>hi</b>\n```\n\nAfter\n\n<!-- leafdesk:html -->\n\nNo fence here"));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "html", "paragraph", "paragraph"]);
    expect(blocks[1].props).toMatchObject({ source: "<b>hi</b>", title: "", height: 0 });
  });

  it("cuts a source past its limit and clamps a height", async () => {
    const long = `<p>${"x".repeat(MAX_HTML_SOURCE)}</p>`;
    const blocks = stored(await markdownToBlocks(`<!-- leafdesk:html {"height":99999} -->\n\`\`\`html\n${long}\n\`\`\``));
    expect((blocks[0].props as { source: string }).source).toHaveLength(MAX_HTML_SOURCE);
    expect((blocks[0].props as { height: number }).height).toBe(2000);
  });

  it("writes nothing for a block without source", async () => {
    const markdown = (await blocksToMarkdown(stored([{ type: "html", props: {} }, { type: "paragraph", content: "x" }]))).trim();
    expect(markdown).toBe("x");
  });

  it("is searched by its title, never its source", () => {
    const blocks = stored([{ type: "html", props: { source: "<script>secretWord()</script>", title: "Loan calculator" } }]);
    expect(blocksToPlainText(blocks)).toBe("Loan calculator");
  });

  it("is a segment of its own in published pages, in columns too, and not part of the HTML runs", async () => {
    const doc = docFrom([
      { type: "paragraph", content: "Intro" },
      { type: "html", props: { source: "<p>app</p>", title: "App", height: 0 } },
      { type: "html", props: { source: "   " } },
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => s.kind)).toEqual(["html", "htmlApp"]);
    expect(segments[1]).toEqual({ kind: "htmlApp", source: "<p>app</p>", title: "App", height: 0 });
    const run = segments[0];
    expect(run.kind === "html" && run.html).not.toContain("<p>app</p>");
  });

  it("takes the HTML out of a model's answer, in a fence or bare", () => {
    expect(htmlAnswer("Here it is:\n```html\n<p>hi</p>\n```\nEnjoy")).toBe("<p>hi</p>");
    expect(htmlAnswer("<!doctype html><p>hi</p>")).toBe("<!doctype html><p>hi</p>");
    expect(htmlAnswer("I can't do that")).toBeNull();
    expect(htmlAnswer(`<p>${"x".repeat(MAX_HTML_SOURCE)}</p>`)).toBeNull();
  });
});
