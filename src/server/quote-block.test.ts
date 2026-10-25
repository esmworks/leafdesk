import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { blocksToMarkdown, markdownToBlocks, serverEditor } from "./blocknote";

/** Blocks as the collab service would store them and read them back. */
function stored(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
}

const quote = (text: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type: "quote",
  props,
  content: [{ type: "text", text, styles: {} }],
  children,
});

describe("quote sizes", () => {
  it("keep their size through the Yjs document", () => {
    const [large, plain] = stored([quote("Big", { size: "large" }), quote("Small")]);
    expect(large.props).toMatchObject({ size: "large" });
    expect(plain.props).toMatchObject({ size: "default" });
  });

  it("write a marker line before a large quote in Markdown and read it back", async () => {
    const blocks = stored([
      quote("Big words", { size: "large" }),
      quote("Plain"),
      quote("Big with more", { size: "large" }, [{ type: "paragraph", content: [{ type: "text", text: "nested", styles: {} }] }]),
    ]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(
      ["<!-- leafdesk:large-quote -->", "> Big words", "", "> Plain", "", "<!-- leafdesk:large-quote -->", "> Big with more", ">", "> nested"].join("\n"),
    );
    const again = stored(await markdownToBlocks(markdown));
    expect(again.map((b) => [b.type, (b.props as { size?: string }).size])).toEqual([
      ["quote", "large"],
      ["quote", "default"],
      ["quote", "large"],
    ]);
    expect(again[2].children[0]).toMatchObject({ type: "paragraph" });
    expect((await blocksToMarkdown(again)).trim()).toBe(markdown);
  });

  it("leave the marker as a line when no quote follows it", async () => {
    const blocks = await markdownToBlocks("<!-- leafdesk:large-quote -->\n\nText");
    expect(blocks.some((b) => b.type === "quote")).toBe(false);
  });

  it("show as large in HTML", async () => {
    const html = await serverEditor.blocksToHTMLLossy(stored([quote("Big", { size: "large" }), quote("Small")]) as never);
    expect(html).toContain('<blockquote data-size="large"');
    expect(html.match(/data-size/g)).toHaveLength(1);
  });
});
