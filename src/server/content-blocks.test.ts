import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { alertKindForColor, colorForAlertKind, leadingEmoji } from "@/lib/content-blocks";
import { flattenBlocks } from "@/lib/page-diff";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));

/** Blocks as the collab service would store them and read them back. */
const stored = (blocks: unknown[]) => read(docFrom(blocks));

/** Markdown → blocks → Y.Doc → blocks → Markdown. */
async function roundTrip(markdown: string) {
  const blocks = stored(await markdownToBlocks(markdown));
  return { blocks, markdown: (await blocksToMarkdown(blocks)).trim() };
}

const text = (value: string) => ({ type: "text", text: value, styles: {} });

const sample = [
  { type: "callout", props: { icon: "🔥", backgroundColor: "red" }, content: [text("Careful: "), { type: "inlineMath", content: "x^2" }] },
  { type: "math", content: "\\int_0^1 x_1 \\, dx" },
  { type: "mermaid", content: "graph TD\n  A-->B" },
  { type: "tableOfContents" },
  { type: "breadcrumb" },
  { type: "paragraph", content: [text("Euler: "), { type: "inlineMath", content: "e^{i\\pi} + 1 = 0" }, text(" done")] },
];

describe("content blocks in the server schema", () => {
  it("are all known to the schema, with the equation inline", () => {
    for (const type of ["callout", "math", "mermaid", "tableOfContents", "breadcrumb"]) {
      expect(pageSchema.blockSchema).toHaveProperty(type);
    }
    expect(pageSchema.inlineContentSchema).toHaveProperty("inlineMath");
  });

  it("round-trip through the Yjs document without losing anything", () => {
    const blocks = stored(sample);
    expect(blocks.map((b) => b.type)).toEqual(["callout", "math", "mermaid", "tableOfContents", "breadcrumb", "paragraph"]);
    expect(blocks[0].props).toMatchObject({ icon: "🔥", backgroundColor: "red" });
    expect(blocks[0].content).toEqual([
      { type: "text", text: "Careful: ", styles: {} },
      { type: "inlineMath", props: {}, content: "x^2" },
    ]);
    expect(blocksToPlainText([blocks[1]])).toBe("\\int_0^1 x_1 \\, dx");
    expect(blocksToPlainText([blocks[2]])).toBe("graph TD\n  A-->B");
    expect(blocks[5].content).toContainEqual({ type: "inlineMath", props: {}, content: "e^{i\\pi} + 1 = 0" });
    // And again: what was read back writes the same document.
    expect(stored(blocks)).toEqual(blocks);
  });

  it("keep sources out of formatting: equations and diagrams are plain text", () => {
    const [math] = stored([{ type: "math", content: [{ type: "text", text: "a*b", styles: { bold: true } }] }]);
    expect(math.content).toEqual([{ type: "text", text: "a*b", styles: {} }]);
  });

  it("show up in the history diff with their sources", () => {
    const flat = flattenBlocks(stored(sample));
    expect(flat.map((b) => b.type)).toEqual(["callout", "math", "mermaid", "tableOfContents", "breadcrumb", "paragraph"]);
    expect(flat[1].text).toBe("\\int_0^1 x_1 \\, dx");
    expect(flat[0].icon).toBe("🔥");
  });
});

describe("content blocks in Markdown", () => {
  it("write their Markdown forms", async () => {
    const markdown = (await blocksToMarkdown(stored(sample))).trim();
    expect(markdown).toBe(
      [
        "> [!CAUTION]",
        "> 🔥 Careful: $x^2$",
        "",
        "$$",
        "\\int_0^1 x_1 \\, dx",
        "$$",
        "",
        "```mermaid",
        "graph TD",
        "  A-->B",
        "```",
        "",
        "<!-- leafdesk:toc -->",
        "",
        "<!-- leafdesk:breadcrumb -->",
        "",
        "Euler: $e^{i\\pi} + 1 = 0$ done",
      ].join("\n"),
    );
  });

  it("read them back into the same blocks", async () => {
    const markdown = (await blocksToMarkdown(stored(sample))).trim();
    const again = await roundTrip(markdown);
    expect(again.markdown).toBe(markdown);
    const blocks = again.blocks;
    expect(blocks.map((b) => b.type)).toEqual(["callout", "math", "mermaid", "tableOfContents", "breadcrumb", "paragraph"]);
    expect(blocks[0].props).toMatchObject({ icon: "🔥", backgroundColor: "red" });
    expect(blocks[0].content).toEqual([
      { type: "text", text: "Careful: ", styles: {} },
      { type: "inlineMath", props: {}, content: "x^2" },
    ]);
    expect(blocksToPlainText([blocks[1]])).toBe("\\int_0^1 x_1 \\, dx");
    expect(blocksToPlainText([blocks[2]])).toBe("graph TD\n  A-->B");
  });

  it("read callouts as GitHub alerts, with the kind as color and a leading emoji as icon", async () => {
    const { blocks, markdown } = await roundTrip(
      ["> [!TIP]", "> ✅ **Bold** tip", "", "> [!warning]", "> No icon here", "", "> Just a quote"].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["callout", "callout", "quote"]);
    expect(blocks[0].props).toMatchObject({ icon: "✅", backgroundColor: "green" });
    expect(blocks[0].content).toEqual([
      { type: "text", text: "Bold", styles: { bold: true } },
      { type: "text", text: " tip", styles: {} },
    ]);
    expect(blocks[1].props).toMatchObject({ icon: "", backgroundColor: "yellow" });
    expect(markdown).toContain("> [!WARNING]\n> No icon here");
  });

  it("read equations with Pandoc's rules, and never inside code", async () => {
    const { blocks } = await roundTrip(
      [
        "Costs $5 and $10, not math. But $a_1 + b_1$ is.",
        "",
        "Code `$x$` stays, \\$y\\$ is escaped.",
        "",
        "```",
        "$$",
        "not math",
        "$$",
        "```",
        "",
        "$$ \\frac{1}{2} $$",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "codeBlock", "math"]);
    const first = blocks[0].content as { type: string; text?: string; content?: string }[];
    expect(first.filter((n) => n.type === "inlineMath")).toEqual([{ type: "inlineMath", props: {}, content: "a_1 + b_1" }]);
    expect(blocksToPlainText([blocks[0]])).toBe("Costs $5 and $10, not math. But a_1 + b_1 is.");
    expect(blocksToPlainText([blocks[1]])).toBe("Code $x$ stays, $y$ is escaped.");
    expect(blocksToPlainText([blocks[2]])).toBe("$$\nnot math\n$$");
    expect(blocksToPlainText([blocks[3]])).toBe("\\frac{1}{2}");
  });

  it("write dollar signs of text escaped, so they come back as text", async () => {
    const blocks = stored([
      {
        type: "paragraph",
        content: [text("Price $x$ and "), { type: "text", text: "$y$", styles: { code: true } }, text(" and "), { type: "inlineMath", content: "z" }],
      },
      { type: "codeBlock", props: { language: "sh" }, content: "echo $HOME" },
    ]);
    const markdown = await blocksToMarkdown(blocks);
    expect(markdown).toContain("Price \\$x\\$ and `$y$` and $z$");
    expect(markdown).toContain("echo $HOME");
    const back = stored(await markdownToBlocks(markdown));
    expect(back[0].content).toEqual(blocks[0].content);
    expect(blocksToPlainText([back[1]])).toBe("echo $HOME");
  });

  it("read a mermaid fence as a diagram and other fences as code", async () => {
    const { blocks } = await roundTrip("```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\n```js\nlet a = 1;\n```");
    expect(blocks.map((b) => b.type)).toEqual(["mermaid", "codeBlock"]);
    expect(blocksToPlainText([blocks[0]])).toBe("sequenceDiagram\n  A->>B: hi");
    // The code's language comes along, and goes back out as the fence's.
    expect((blocks[1].props as { language?: string }).language).toBe("js");
    expect(await blocksToMarkdown(blocks)).toContain("```js\nlet a = 1;\n```");
  });

  it("keep nested blocks under callouts and equations inside lists", async () => {
    const blocks = stored([
      { type: "callout", props: { icon: "💡", backgroundColor: "gray" }, content: "Top", children: [{ type: "paragraph", content: "Nested" }] },
      { type: "bulletListItem", content: [text("Item "), { type: "inlineMath", content: "n" }] },
    ]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toContain("> [!NOTE]\n> 💡 Top");
    expect(markdown).toContain("Nested");
    expect(markdown).toContain("* Item $n$");
  });

  it("map alert kinds and colors", () => {
    expect(alertKindForColor("default")).toBe("NOTE");
    expect(alertKindForColor("orange")).toBe("WARNING");
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const) {
      expect(alertKindForColor(colorForAlertKind(kind))).toBe(kind);
    }
    expect(leadingEmoji("👩‍💻 dev")).toBe("👩‍💻");
    expect(leadingEmoji("⚠️ careful")).toBe("⚠️");
    expect(leadingEmoji("plain")).toBeNull();
  });
});

describe("content blocks on published pages", () => {
  it("render equations with KaTeX, never trusting their source", async () => {
    const doc = docFrom([
      { type: "math", content: "\\href{javascript:alert(1)}{x} \\frac{a}{b}" },
      { type: "paragraph", content: [text("Inline "), { type: "inlineMath", content: "<img src=x onerror=alert(1)>" }] },
    ]);
    const [segment] = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    const html = segment.kind === "html" ? segment.html : "";
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("<mfrac>");
    // \href is refused: its target only survives as the escaped source text KaTeX annotates.
    expect(html).not.toMatch(/href=|<img|<a[\s>]|<script/);
    expect(html).toContain("&lt;img");
  });

  it("draw callouts with their icon and color", async () => {
    const doc = docFrom([{ type: "callout", props: { icon: "🔥", backgroundColor: "red" }, content: "Hot" }]);
    const [segment] = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    const html = segment.kind === "html" ? segment.html : "";
    expect(html).toContain('data-background-color="red"');
    expect(html).toContain("🔥");
    expect(html).toContain("Hot");
  });

  it("split out diagrams, tables of contents and breadcrumbs, with anchors on the headings", async () => {
    const doc = docFrom([
      { type: "breadcrumb" },
      { type: "tableOfContents" },
      { type: "heading", props: { level: 1 }, content: "One" },
      { type: "mermaid", content: "graph TD\n  A-->B" },
      { type: "bulletListItem", content: "Item", children: [{ type: "heading", props: { level: 2 }, content: "Two <b>" }] },
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => s.kind)).toEqual(["breadcrumb", "toc", "html", "mermaid", "html"]);
    expect(segments[1]).toEqual({
      kind: "toc",
      headings: [
        { anchor: "heading-1", level: 1, text: "One" },
        { anchor: "heading-2", level: 2, text: "Two <b>" },
      ],
    });
    expect(segments[3]).toEqual({ kind: "mermaid", source: "graph TD\n  A-->B" });
    const html = segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).toMatch(/<h1 id="heading-1"[^>]*>One<\/h1>/);
    expect(html).toMatch(/<h2 id="heading-2"[^>]*>Two &lt;b&gt;<\/h2>/);
  });
});
