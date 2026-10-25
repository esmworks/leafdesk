import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { codeCaptionLine, readCodeCaptionLine } from "@/lib/code-caption";
import { blocksToMarkdown, markdownToBlocks, serverEditor } from "./blocknote";

/** Blocks as the collab service would store them and read them back. */
function stored(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
}

const code = (text: string, props: Record<string, unknown> = {}) => ({ type: "codeBlock", props: { language: "js", ...props }, content: [{ type: "text", text, styles: {} }], children: [] });

describe("code captions", () => {
  it("keep their caption through the Yjs document", () => {
    const [captioned, plain] = stored([code("let a = 1;", { caption: "Setting a" }), code("b()")]);
    expect(captioned.props).toMatchObject({ caption: "Setting a", language: "js" });
    expect(plain.props).toMatchObject({ caption: "" });
  });

  it("write a marker line before a captioned block in Markdown and read it back", async () => {
    const blocks = stored([code("let a = 1;", { caption: "Setting a --> b" }), code("b()")]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(["<!-- leafdesk:caption Setting a --\\> b -->", "", "```js", "let a = 1;", "```", "", "```js", "b()", "```"].join("\n"));
    const again = stored(await markdownToBlocks(markdown));
    expect(again.map((b) => [b.type, (b.props as { caption?: string }).caption])).toEqual([
      ["codeBlock", "Setting a --> b"],
      ["codeBlock", ""],
    ]);
    expect((await blocksToMarkdown(again)).trim()).toBe(markdown);
  });

  it("leave the marker as a line when no code block follows it", async () => {
    const blocks = await markdownToBlocks("<!-- leafdesk:caption Lonely -->\n\nText");
    expect(blocks.some((b) => (b.props as { caption?: string }).caption)).toBe(false);
  });

  it("show under the code in HTML", async () => {
    const html = await serverEditor.blocksToHTMLLossy(stored([code("x", { caption: "The x" }), code("y")]) as never);
    expect(html).toMatch(/<figure class="code-figure"[^>]*>.*<pre><code[^>]*>x<\/code><\/pre>.*<figcaption>The x<\/figcaption><\/figure>/);
    expect(html.match(/figcaption>/g)).toHaveLength(2);
  });

  it("read and write the marker line", () => {
    expect(readCodeCaptionLine(codeCaptionLine("  Two\\n lines  "))).toBe("Two\\n lines");
    expect(readCodeCaptionLine("<!-- leafdesk:caption  -->")).toBeNull();
    expect(readCodeCaptionLine("Text")).toBeNull();
  });
});
