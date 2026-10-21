import { describe, expect, it } from "vitest";
import { splitSlides, type SlideBlock } from "./slides";

type Block = SlideBlock & { id: string };

const text = (value: string) => [{ type: "text", text: value, styles: {} }];
const p = (id: string, value = id, children: Block[] = []): Block => ({ id, type: "paragraph", content: text(value), children });
const empty = (id: string): Block => ({ id, type: "paragraph", content: [], children: [] });
const h = (id: string, level: number, children: Block[] = []): Block => ({ id, type: "heading", props: { level }, content: text(id), children });
const divider = (id: string): Block => ({ id, type: "divider", children: [] });
const ids = (slides: Block[][]) => slides.map((slide) => slide.map((block) => block.id));

describe("splitSlides", () => {
  it("cuts at dividers and leaves the dividers out", () => {
    const blocks = [p("intro"), divider("d1"), h("a", 1), p("a1"), divider("d2"), p("b1"), h("b", 2), p("b2")];
    // With dividers, headings don't cut: "b" stays on the slide the second divider opened.
    expect(ids(splitSlides(blocks))).toEqual([["intro"], ["a", "a1"], ["b1", "b", "b2"]]);
  });

  it("cuts before headings of level 1 and 2 on a page without dividers", () => {
    const blocks = [p("intro"), h("a", 1), p("a1"), h("a-sub", 3), p("a2"), h("b", 2), p("b1")];
    expect(ids(splitSlides(blocks))).toEqual([["intro"], ["a", "a1", "a-sub", "a2"], ["b", "b1"]]);
  });

  it("starts with the first heading when nothing comes before it", () => {
    expect(ids(splitSlides([h("a", 1), p("a1"), h("b", 1)]))).toEqual([["a", "a1"], ["b"]]);
  });

  it("keeps nested children with their block, and doesn't cut at headings or dividers inside them", () => {
    const toggle = { id: "toggle", type: "toggleListItem", content: text("toggle"), children: [h("inner", 1), divider("inner-d")] };
    const columns = { id: "cols", type: "columnList", children: [{ id: "col", type: "column", children: [h("in-col", 1)] }] };
    const blocks = [h("a", 1, [p("child")]), toggle, columns, h("b", 2)] as Block[];
    const slides = splitSlides(blocks);
    expect(ids(slides)).toEqual([["a", "toggle", "cols"], ["b"]]);
    expect(slides[0][0].children).toEqual([p("child")]);
  });

  it("adds no slide for empty paragraphs, dividers in a row or a divider at either end", () => {
    const blocks = [divider("d0"), p("a"), divider("d1"), divider("d2"), empty("e1"), divider("d3"), p("b"), divider("d4"), empty("trailing")];
    expect(ids(splitSlides(blocks))).toEqual([["a"], ["b"]]);
  });

  it("keeps empty paragraphs between other blocks of a slide", () => {
    expect(ids(splitSlides([h("a", 1), empty("gap"), p("a1"), empty("trailing")]))).toEqual([["a", "gap", "a1", "trailing"]]);
  });

  it("treats a paragraph holding nested blocks as content", () => {
    expect(ids(splitSlides([{ id: "parent", type: "paragraph", content: [], children: [p("child")] }]))).toEqual([["parent"]]);
  });

  it("has no slides for an empty page or one with only its trailing paragraph", () => {
    expect(splitSlides([])).toEqual([]);
    expect(splitSlides([empty("trailing")])).toEqual([]);
    expect(splitSlides([divider("d"), empty("trailing")])).toEqual([]);
  });

  it("puts a page without headings or dividers on one slide", () => {
    expect(ids(splitSlides([p("a"), h("small", 3), p("b")]))).toEqual([["a", "small", "b"]]);
  });

  it("counts blocks other than paragraphs as content even when they hold no text", () => {
    const image = { id: "img", type: "image", props: { url: "/x.png" }, children: [] };
    const table = { id: "table", type: "table", content: { type: "tableContent", rows: [] }, children: [] };
    expect(ids(splitSlides([image, divider("d"), table] as Block[]))).toEqual([["img"], ["table"]]);
  });
});
