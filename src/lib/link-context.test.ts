import { describe, expect, it } from "vitest";
import { excerpt, findTitle, LINK_PLACEHOLDER as P, linkContexts, linkTitle } from "./link-context";

const text = (value: string, styles = {}) => ({ type: "text", text: value, styles });
const mention = (pageId: string) => ({ type: "mention", props: { kind: "page", pageId } });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content, children: [] as unknown[] });

describe("findTitle", () => {
  it("finds a title as whole words, without case", () => {
    expect(findTitle("See the launch plan today", "Launch plan")).toEqual({ start: 8, end: 19 });
    expect(findTitle("Planning ahead", "Plan")).toBeNull();
    expect(findTitle("Replan, then Plan.", "Plan")).toEqual({ start: 13, end: 17 });
  });

  it("treats the Turkish dotted and dotless i alike", () => {
    expect(findTitle("içe aktarma notları", "İçe aktarma")).toEqual({ start: 0, end: 11 });
    expect(findTitle("ISPARTA ziyareti", "Isparta")).toEqual({ start: 0, end: 7 });
    expect(findTitle("Gezi: ıspanak", "Ispanak")).toEqual({ start: 6, end: 13 });
  });

  it("checks word edges only where the title has a word character", () => {
    expect(findTitle("We use C++ here", "C++")).toEqual({ start: 7, end: 10 });
    expect(findTitle("Use C++17", "C++")).toEqual({ start: 4, end: 7 });
  });

  it("skips titles too short to look for", () => {
    expect(findTitle("a b c", "a")).toBeNull();
    expect(findTitle("anything", "  ")).toBeNull();
  });
});

describe("excerpt", () => {
  it("keeps to the line and marks what it cut", () => {
    const long = `${"word ".repeat(40)}Target ${"more ".repeat(40)}`;
    const at = long.indexOf("Target");
    const cut = excerpt(`first line\n${long}\nlast`, at + 11, at + 17);
    expect(cut.match).toBe("Target");
    expect(cut.before.startsWith("…word")).toBe(true);
    expect(cut.after.endsWith("more…")).toBe(true);
    expect(excerpt("a\nb Target c\nd", 4, 10)).toEqual({ before: "b ", match: "Target", after: " c" });
  });
});

describe("linkContexts", () => {
  it("keeps the text around each page's first mention, without other pages' titles", () => {
    const blocks = [
      paragraph(text("Before "), mention("a"), text(" and "), mention("b"), text(" after")),
      paragraph(text("Again "), mention("a")),
      { type: "pageLink", props: { pageId: "c" }, children: [] },
      paragraph(mention("d")),
    ];
    const contexts = linkContexts(blocks);
    expect(contexts.get("a")).toBe(`Before ${P} and  after`);
    expect(contexts.get("b")).toBe(`Before  and ${P} after`);
    expect(contexts.has("c")).toBe(false);
    expect(contexts.has("d")).toBe(false);
  });

  it("finds mentions in nested blocks and tables, and drops placeholder characters from the text", () => {
    const blocks = [
      { type: "paragraph", content: [text("Top")], children: [paragraph(text(`Inner ${P} `), mention("a"))] },
      {
        type: "table",
        content: { type: "tableContent", rows: [{ cells: [[text("Cell")], [mention("b"), text(" here")]] }] },
        children: [],
      },
    ];
    const contexts = linkContexts(blocks);
    expect(contexts.get("a")).toBe(`Inner  ${P}`);
    expect(contexts.get("b")).toBe(`Cell ${P} here`);
  });
});

describe("linkTitle", () => {
  it("turns the first plain occurrence into a mention, keeping the styles around it", () => {
    const bold = { bold: true };
    const blocks = [
      { type: "codeBlock", content: [text("Roadmap in code")], children: [] },
      paragraph({ type: "link", href: "https://x.test", content: [text("Roadmap")] }, text("See the roadmap now", bold)),
    ];
    expect(linkTitle(blocks, "Roadmap", "p1")).toBe(true);
    expect(blocks[0].content).toEqual([text("Roadmap in code")]);
    expect(blocks[1].content.slice(1)).toEqual([
      text("See the ", bold),
      { type: "mention", props: expect.objectContaining({ kind: "page", pageId: "p1" }) },
      text(" now", bold),
    ]);
  });

  it("looks in table cells and nested blocks, and says when the title isn't there", () => {
    const table = {
      type: "table",
      content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [text("Roadmap")] }] }] },
      children: [],
    };
    expect(linkTitle([table], "roadmap", "p1")).toBe(true);
    expect(table.content.rows[0].cells[0].content).toEqual([expect.objectContaining({ type: "mention" })]);
    const nested = [{ type: "paragraph", content: [], children: [paragraph(text("İçe aktarma"))] }];
    expect(linkTitle(nested, "içe aktarma", "p2")).toBe(true);
    expect(linkTitle([paragraph(text("Roadmaps"))], "Roadmap", "p1")).toBe(false);
  });
});
