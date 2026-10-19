import { describe, expect, it } from "vitest";
import { serverEditor } from "@/server/blocknote";
import { editorBlocksToMarkdown, editorMarkdownToBlocks } from "./editor-markdown";

// The server's editor has the page schema the browser's has; its Markdown side answers in promises.
const editor = serverEditor as unknown as Parameters<typeof editorBlocksToMarkdown>[0];

const text = (value: string) => ({ type: "text", text: value, styles: {} });
const note = (value: string) => ({ type: "footnote", props: {}, content: value });
const math = (latex: string) => ({ type: "inlineMath", props: {}, content: latex });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });

describe("Markdown of the editor's blocks (AI assistant, voice notes)", () => {
  it("writes footnotes as references with their notes at the end, and equations as $…$", async () => {
    const markdown = await editorBlocksToMarkdown(editor, [
      paragraph(text("Energy"), note("Einstein, 1905."), text(" is "), math("E = mc^2"), text(" for $5.")),
      paragraph(text("Second"), note("Another source.")),
    ]);
    expect(markdown.trim()).toBe(
      ["Energy[^1] is $E = mc^2$ for \\$5.", "", "Second[^2]", "", "[^1]: Einstein, 1905.", "[^2]: Another source."].join("\n"),
    );
  });

  it("reads them back from the Markdown it wrote", async () => {
    const blocks = [
      paragraph(text("Energy"), note("Einstein, 1905."), text(" is "), math("E = mc^2"), text(" for $5 and $10.")),
      { type: "callout", props: { icon: "", backgroundColor: "blue" }, content: [text("Noted"), note("In a callout.")] },
    ];
    const back = await editorMarkdownToBlocks(editor, await editorBlocksToMarkdown(editor, blocks));
    expect(back[0].content).toEqual(blocks[0].content);
    expect(back[1]).toMatchObject({ type: "callout", content: blocks[1].content });
  });

  it("reads footnotes in an answer that rewrote the text around them", async () => {
    const answer = ["A shorter claim[^1] with a new one[^2].", "", "[^1]: Einstein, 1905.", "[^2]: A note the answer added."].join("\n");
    const [block, ...rest] = await editorMarkdownToBlocks(editor, answer);
    expect(block.content).toEqual([text("A shorter claim"), note("Einstein, 1905."), text(" with a new one"), note("A note the answer added."), text(".")]);
    expect(rest).toEqual([]);
  });

  it("leaves a reference whose note the answer dropped as it is", async () => {
    const [block] = await editorMarkdownToBlocks(editor, "A claim[^1].");
    expect(block.content).toEqual([text("A claim[^1].")]);
  });

  it("adds no dashboard for a dashboard line the answer repeats", async () => {
    const dashboard = (await editorBlocksToMarkdown(editor, [{ id: "dash1", type: "dashboard", props: {}, children: [] }])).trim();
    expect(dashboard).toContain("dash1");
    expect(await editorMarkdownToBlocks(editor, `${dashboard}\n\nText after it.`)).toMatchObject([paragraph(text("Text after it."))]);
  });

  it("keeps footnotes and equations in the editor's own HTML, which replacing a selection pastes", async () => {
    const blocks = await editorMarkdownToBlocks(editor, ["Energy[^1] is $E = mc^2$.", "", "[^1]: Einstein, 1905."].join("\n"));
    const pasted = await serverEditor.tryParseHTMLToBlocks(await serverEditor.blocksToFullHTML(blocks as never));
    expect(pasted[0].content).toEqual([text("Energy"), note("Einstein, 1905."), text(" is "), math("E = mc^2"), text(".")]);
  });
});
