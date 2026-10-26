import { describe, expect, it } from "vitest";
import { proseTexts, tagsInBlocks } from "./tag-blocks";

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", props: {}, content, children: [] });

describe("tagsInBlocks", () => {
  it("counts each tag by key, keeping the first spelling", () => {
    const tags = tagsInBlocks([paragraph(text("#Home and #home again, #work")), paragraph(text("#HOME"))]);
    expect([...tags]).toEqual([
      ["home", { label: "Home", count: 3 }],
      ["work", { label: "work", count: 1 }],
    ]);
  });

  it("reads a tag across styles, and nested blocks, table cells and footnotes", () => {
    const tags = tagsInBlocks([
      { ...paragraph(text("#ta", { bold: true }), text("g")), children: [paragraph(text("nested #child"))] },
      {
        type: "table",
        content: { type: "tableContent", rows: [{ cells: [[text("#cell")], { type: "tableCell", content: [text("#merged")] }] }] },
        children: [],
      },
      paragraph(text("Claim"), { type: "footnote", content: [text("#source")] }, text(" #after")),
    ]);
    expect([...tags.keys()]).toEqual(["tag", "child", "cell", "merged", "after", "source"]);
  });

  it("leaves out code, equations, diagrams, links and mentions", () => {
    const tags = tagsInBlocks([
      { type: "codeBlock", props: { language: "css" }, content: [text("#main { color: red }")], children: [] },
      { type: "math", props: {}, content: [text("#x")], children: [] },
      { type: "mermaid", props: {}, content: [text("#graph")], children: [] },
      paragraph(text("#code", { code: true }), text(" and "), { type: "link", href: "https://x.test/#anchor", content: [text("#linked")] }),
      paragraph({ type: "mention", props: { kind: "person", name: "#someone" } }, text(" "), { type: "inlineMath", content: "#m" }),
      paragraph(text("#kept")),
    ]);
    expect([...tags.keys()]).toEqual(["kept"]);
  });

  it("doesn't start a tag right after what isn't prose", () => {
    expect(tagsInBlocks([paragraph(text("x", { code: true }), text("#glued"))]).size).toBe(0);
    expect(tagsInBlocks([paragraph({ type: "mention", props: {} }, text("#glued"))]).size).toBe(0);
  });

  it("takes nothing from blocks without text, or odd input", () => {
    expect(tagsInBlocks([{ type: "image", props: { url: "https://x.test/#a" }, children: [] }, null, "x", { content: "#plain" }]).size).toBe(0);
    expect(proseTexts([])).toEqual([]);
  });
});
