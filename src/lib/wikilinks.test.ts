import { describe, expect, it } from "vitest";
import { linkWikilinks, titleKey, wikilinkTitles } from "./wikilinks";

const text = (value: string, styles = {}) => ({ type: "text", text: value, styles });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content, children: [] as unknown[] });
const mention = (pageId: string) => ({ type: "mention", props: expect.objectContaining({ kind: "page", pageId }) });

describe("wikilinkTitles", () => {
  it("lists the titles named in plain text, not in code or links", () => {
    const blocks = [
      paragraph(text("See [[Roadmap]] and [[ Budget ]], again [[Roadmap]]")),
      paragraph(text("[[In code]]", { code: true }), { type: "link", href: "https://x.test", content: [text("[[In link]]")] }),
      { type: "codeBlock", content: [text("[[Code block]]")], children: [] },
      { type: "paragraph", content: [], children: [paragraph(text("[[Nested]] [[]] [[a\nb]]"))] },
    ];
    expect(wikilinkTitles(blocks)).toEqual(["Roadmap", "Budget", "Nested"]);
  });
});

describe("linkWikilinks", () => {
  it("links the titles it knows and leaves the rest as text, keeping styles", () => {
    const bold = { bold: true };
    const pages = new Map([[titleKey("Roadmap"), "p1"], [titleKey("Işık"), "p2"]]);
    const blocks = [paragraph(text("See [[roadmap]], [[Nowhere]] and [[ışık]].", bold))];
    expect(linkWikilinks(blocks, (title) => pages.get(titleKey(title)))).toBe(2);
    expect(blocks[0].content).toEqual([
      text("See ", bold),
      mention("p1"),
      text(", [[Nowhere]] and ", bold),
      mention("p2"),
      text(".", bold),
    ]);
  });

  it("links every node of a list and in table cells", () => {
    const table = {
      type: "table",
      content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [text("[[A]]")] }] }] },
      children: [],
    };
    const blocks = [paragraph(text("[[A]]"), text(" mid "), text("[[A]] end")), table];
    expect(linkWikilinks(blocks, (title) => (title === "A" ? "a" : undefined))).toBe(3);
    expect(blocks[0].content).toEqual([mention("a"), text(" mid "), mention("a"), text(" end")]);
    expect(table.content.rows[0].cells[0].content).toEqual([mention("a")]);
  });
});
