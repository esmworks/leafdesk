import { describe, expect, it } from "vitest";
import { excerpt, findTitle, LINK_PLACEHOLDER as P, linkContexts, linkPlaces, linkTitle, MAX_LINK_PLACES } from "./link-context";

const text = (value: string, styles = {}) => ({ type: "text", text: value, styles });
const mention = (pageId: string) => ({ type: "mention", props: { kind: "page", pageId } });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content, children: [] as unknown[] });

describe("findTitle", () => {
  it("finds a title as whole words, without case", () => {
    expect(findTitle("See the launch plan today", "Launch plan")).toEqual({ start: 8, end: 19 });
    expect(findTitle("Planning ahead", "Plan")).toBeNull();
    expect(findTitle("Replan, then Plan.", "Plan")).toEqual({ start: 13, end: 17 });
  });

  it("finds a Japanese, Chinese or Korean title inside a sentence, which has no spaces between words", () => {
    expect(findTitle("明日の会議について", "会議")).toEqual({ start: 3, end: 5 });
    expect(findTitle("上周的会议纪要", "会议纪要")).toEqual({ start: 3, end: 7 });
    expect(findTitle("회의를 시작합니다", "회의")).toEqual({ start: 0, end: 2 });
    expect(findTitle("Leafdesk会議の資料", "会議")).toEqual({ start: 8, end: 10 });
    // A Latin edge still needs a word boundary.
    expect(findTitle("Leafdesk会議", "desk会議")).toBeNull();
  });

  it("doesn't find such a title inside a longer word", () => {
    // Chinese characters next to Chinese characters, katakana next to katakana, a Korean word's start.
    expect(findTitle("国会議員が来ます", "会議")).toBeNull();
    expect(findTitle("メモリーを増やす", "メモ")).toBeNull();
    expect(findTitle("국회의원 선거", "회의")).toBeNull();
    expect(findTitle("上周的会议纪要", "会议")).toBeNull();
    // Next to a Chinese function word a Chinese word ends, but not in Japanese, which has kana.
    expect(findTitle("这是会议", "会议")).toEqual({ start: 2, end: 4 });
    expect(findTitle("現在会議の準備", "在会議")).toBeNull();
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

  it("matches letters written with combining marks", () => {
    const decomposed = "Yeni Mu\u0308s\u0327teri dosyası".normalize("NFD");
    const found = findTitle(decomposed, "Müşteri");
    expect(found).not.toBeNull();
    expect(decomposed.slice(found!.start, found!.end).normalize("NFC")).toBe("Müşteri");
    expect(findTitle("Müşteri listesi", "Mu\u0308s\u0327teri")).toEqual({ start: 0, end: 7 });
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

describe("linkPlaces", () => {
  const withId = <T extends object>(id: string, block: T) => ({ id, ...block });

  it("lists every block linking to each page, in document order, with the text around the link", () => {
    const blocks = [
      withId("b1", paragraph(text("Before "), mention("a"), text(" and "), mention("b"))),
      withId("b2", { type: "paragraph", content: [text("Top")], children: [withId("b3", paragraph(text("Again "), mention("a"), mention("a")))] }),
      withId("b4", { type: "pageLink", props: { pageId: "a" }, children: [] }),
      withId("b5", paragraph(mention("a"))),
      paragraph(text("No id "), mention("a")),
    ];
    const places = linkPlaces(blocks);
    expect(places.get("a")).toEqual([
      { block: "b1", context: `Before ${P} and` },
      { block: "b3", context: `Again ${P}${P}` },
      { block: "b4", context: null },
      { block: "b5", context: null },
    ]);
    expect(places.get("b")).toEqual([{ block: "b1", context: `Before  and ${P}` }]);
  });

  it("keeps the first MAX_LINK_PLACES blocks of a page", () => {
    const blocks = Array.from({ length: MAX_LINK_PLACES + 5 }, (_, i) => withId(`b${i}`, paragraph(text(`Line ${i} `), mention("a"))));
    const places = linkPlaces(blocks).get("a")!;
    expect(places).toHaveLength(MAX_LINK_PLACES);
    expect(places[0].block).toBe("b0");
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
    expect(linkTitle([paragraph(text("Roadmap", { code: true }))], "Roadmap", "p1")).toBe(false);
  });
});
