import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { flattenBlocks } from "@/lib/page-diff";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));
const text = (value: string) => ({ type: "text", text: value, styles: {} });

const bookmark = {
  type: "bookmark",
  props: {
    url: "https://example.com/post",
    title: "A [bracketed] *post*",
    description: "What it is about",
    image: "https://example.com/card.png",
    favicon: "https://example.com/favicon.ico",
    siteName: "Example",
    fetchedAt: "2026-09-27T10:00:00.000Z",
    width: 60,
  },
};
const embed = { type: "webEmbed", props: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } };

describe("web blocks in the server schema", () => {
  it("are known to the schema", () => {
    expect(pageSchema.blockSchema).toHaveProperty("bookmark");
    expect(pageSchema.blockSchema).toHaveProperty("webEmbed");
  });

  it("round-trip through the Yjs document with every prop", () => {
    const blocks = stored([bookmark, embed, { type: "paragraph", content: [text("after")] }]);
    expect(blocks.map((b) => b.type)).toEqual(["bookmark", "webEmbed", "paragraph"]);
    expect(blocks[0].props).toEqual(bookmark.props);
    expect(blocks[1].props).toEqual(embed.props);
    expect(stored(blocks)).toEqual(blocks);
  });

  it("are searchable and show in the history by title or URL", () => {
    const blocks = stored([bookmark, embed]);
    expect(blocksToPlainText(blocks)).toBe("A [bracketed] *post* What it is about");
    expect(flattenBlocks(blocks).map((b) => b.text)).toEqual(["A [bracketed] *post*", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  });
});

describe("web blocks in Markdown", () => {
  it("write a bookmark as a link line and an embed as a link with a marker", async () => {
    const markdown = await blocksToMarkdown(stored([bookmark, embed]));
    expect(markdown.trim().split(/\n+/)).toEqual([
      "[A \\[bracketed\\] \\*post\\*](https://example.com/post)",
      "[https://www.youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ) <!-- leafdesk:embed -->",
    ]);
  });

  it("read an embed line back as an embed", async () => {
    const blocks = stored(await markdownToBlocks("Intro\n\n[video](https://youtu.be/dQw4w9WgXcQ) <!-- leafdesk:embed -->\n\nhttps://vimeo.com/1 <!-- leafdesk:embed -->"));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "webEmbed", "webEmbed"]);
    expect(blocks[1].props).toEqual({ url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(blocks[2].props).toEqual({ url: "https://vimeo.com/1" });
  });

  it("read a marked link as a new bookmark without details yet", async () => {
    const blocks = stored(await markdownToBlocks("[Docs](https://example.com/docs) <!-- leafdesk:bookmark -->"));
    expect(blocks[0].type).toBe("bookmark");
    expect(blocks[0].props).toMatchObject({ url: "https://example.com/docs", title: "Docs", fetchedAt: "" });
  });

  it("leave a marker with an unsafe URL as text, and markers inside code alone", async () => {
    const blocks = stored(await markdownToBlocks("[x](javascript:alert(1)) <!-- leafdesk:embed -->\n\n```\n[a](https://a.example) <!-- leafdesk:embed -->\n```"));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "codeBlock"]);
  });

  it("keep a lone link a link on a page without bookmarks", async () => {
    const blocks = stored(await markdownToBlocks("[Docs](https://example.com/docs)"));
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toMatchObject([{ type: "link", href: "https://example.com/docs" }]);
  });

  it("give a rewritten page its bookmarks back, details included (MCP read, edit, write)", async () => {
    const page = stored([bookmark, { type: "paragraph", content: [text("Notes")] }, embed]);
    const markdown = await blocksToMarkdown(page);
    const edited = `${markdown.trim()}\n\nA new line`;
    const blocks = stored(await markdownToBlocks(edited, page));
    expect(blocks.map((b) => b.type)).toEqual(["bookmark", "paragraph", "webEmbed", "paragraph"]);
    expect(blocks[0].props).toEqual(bookmark.props);
    expect(blocks[2].props).toEqual(embed.props);
    // And the Markdown is stable.
    expect((await blocksToMarkdown(blocks)).trim()).toBe(edited);
  });

  it("don't turn appended links into bookmarks", async () => {
    const page = stored([bookmark]);
    const blocks = stored(await markdownToBlocks("[again](https://example.com/post)", page, { keepMissingInline: false }));
    expect(blocks[0].type).toBe("paragraph");
  });

  it("round-trip URLs with parentheses", async () => {
    const page = stored([{ type: "bookmark", props: { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" } }]);
    const markdown = (await blocksToMarkdown(page)).trim();
    expect(markdown).toBe("[Foo](<https://en.wikipedia.org/wiki/Foo_(bar)>)");
    const blocks = stored(await markdownToBlocks(markdown, page));
    expect(blocks[0]).toMatchObject({ type: "bookmark", props: { url: "https://en.wikipedia.org/wiki/Foo_(bar)" } });
  });
});

describe("web blocks on published pages", () => {
  it("come back as bookmark and iframe segments, iframes only for allowlisted providers", async () => {
    const doc = docFrom([
      { type: "paragraph", content: [text("Before")] },
      bookmark,
      embed,
      { type: "webEmbed", props: { url: "https://unknown.example/video" } },
      { type: "bookmark", props: { url: "javascript:alert(1)", title: "Evil" } },
      { type: "bookmark", props: { url: "https://example.com/", image: "javascript:alert(1)", favicon: "data:x" } },
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => s.kind)).toEqual(["html", "bookmark", "webEmbed", "bookmark", "bookmark"]);
    expect(segments[1]).toMatchObject({ kind: "bookmark", bookmark: { url: "https://example.com/post", title: bookmark.props.title, width: 60 } });
    expect(segments[2]).toMatchObject({
      kind: "webEmbed",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      embed: { src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
    });
    expect(segments[3]).toMatchObject({ kind: "bookmark", bookmark: { url: "https://unknown.example/video" } });
    expect(segments[4]).toMatchObject({ kind: "bookmark", bookmark: { url: "https://example.com/", image: "", favicon: "", width: null } });
  });
});
