import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks, type PageBlock } from "./blocknote";

const mention = { type: "mention", props: { kind: "comment", pageId: "page1", threadId: "t1" } };
const blocks = [
  { type: "paragraph", content: [{ type: "text", text: "See ", styles: {} }, mention] },
  { type: "commentPreview", props: { pageId: "page1", threadId: "t1" } },
] as unknown as PageBlock[];

describe("comment mentions and previews in Markdown", () => {
  it("are written as links to the thread, the preview with its marker", async () => {
    const markdown = await blocksToMarkdown(blocks, { workspaceId: "ws1" });
    expect(markdown).toContain("See [page](/w/ws1/p/page1#comment-t1)");
    expect(markdown).toContain("[page](/w/ws1/p/page1#comment-t1) <!-- leafdesk:comment -->");
  });

  it("read back as the same mention and block", async () => {
    const back = await markdownToBlocks(await blocksToMarkdown(blocks, { workspaceId: "ws1" }));
    const inline = (back[0].content as { type: string; props?: Record<string, unknown> }[]).find((n) => n.type === "mention");
    expect(inline?.props).toMatchObject({ kind: "comment", pageId: "page1", threadId: "t1" });
    expect(back[1]).toMatchObject({ type: "commentPreview", props: { pageId: "page1", threadId: "t1" } });
  });
});
