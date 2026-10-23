import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { serverEditor } from "@/server/blocknote";
import { findMatches, foldCase, foldForSearch, matchIndexAt, matchRanges, replaceAllMatches, replaceMatch, SKIPPED, stepIndex } from "./find-replace";

// Page bodies in the page schema (BlockNote's blocks plus the database blocks).
const docOf = (blocks: unknown[]) => serverEditor._blocksToProsemirrorNode(blocks as any);
const stateOf = (blocks: unknown[]) => EditorState.create({ doc: docOf(blocks) });
const texts = (state: EditorState) => {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    out.push(node.textContent);
    return false;
  });
  return out;
};

describe("findMatches", () => {
  it("finds text that runs across formatting within a block", () => {
    const doc = docOf([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", styles: {} },
          { type: "text", text: "wor", styles: { bold: true } },
          { type: "text", text: "ld and world", styles: {} },
        ],
      },
    ]);
    const matches = findMatches(doc, "world");
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => doc.textBetween(m.from, m.to))).toEqual(["world", "world"]);
    expect(matches[0].from).toBeLessThan(matches[1].from);
  });

  it("never matches across block boundaries", () => {
    const doc = docOf([
      { type: "paragraph", content: "foo" },
      { type: "paragraph", content: "bar" },
      { type: "heading", content: "foo bar" },
    ]);
    expect(findMatches(doc, "foobar")).toEqual([]);
    expect(findMatches(doc, "oob")).toEqual([]);
    const matches = findMatches(doc, "foo");
    expect(matches).toHaveLength(2);
    expect(findMatches(doc, "o b").map((m) => doc.textBetween(m.from, m.to))).toEqual(["o b"]);
  });

  it("searches nested blocks, list items and table cells", () => {
    const doc = docOf([
      { type: "bulletListItem", content: "parent needle", children: [{ type: "paragraph", content: "child needle" }] },
      {
        type: "table",
        content: { type: "tableContent", rows: [{ cells: ["needle", "x"] }, { cells: ["y", "needle here"] }] },
      },
      { type: "codeBlock", content: "const needle = 1;" },
    ]);
    const matches = findMatches(doc, "needle");
    expect(matches).toHaveLength(5);
    for (const m of matches) expect(doc.textBetween(m.from, m.to)).toBe("needle");
  });

  it("ignores case unless asked, folding the way the reader's language does", () => {
    const doc = docOf([{ type: "paragraph", content: "Apple apple APPLE İSTANBUL IRMAK" }]);
    expect(findMatches(doc, "apple")).toHaveLength(3);
    expect(findMatches(doc, "apple", { caseSensitive: true })).toHaveLength(1);
    expect(findMatches(doc, "APPLE", { caseSensitive: true })).toHaveLength(1);
    // "İ" folds to a plain "i" in every language, so positions stay put.
    const [istanbul] = findMatches(doc, "istanbul", { locale: "en" });
    expect(doc.textBetween(istanbul.from, istanbul.to)).toBe("İSTANBUL");
    expect(findMatches(doc, "istanbul", { locale: "tr" })).toHaveLength(1);
    // Turkish pairs "I" with the dotless "ı" (with accents mattering, "ı" and "i" stay apart).
    expect(findMatches(doc, "ırmak", { locale: "tr", matchAccents: true })).toHaveLength(1);
    expect(findMatches(doc, "ırmak", { locale: "en", matchAccents: true })).toHaveLength(0);
  });

  it("keeps character positions when folding", () => {
    expect(foldCase("İstanbul", "en")).toBe("istanbul");
    expect(foldCase("IŞIK", "tr")).toBe("ışık");
    expect(foldCase("İstanbul").length).toBe("İstanbul".length);
  });

  it("does not overlap matches and ignores an empty query", () => {
    const doc = docOf([{ type: "paragraph", content: "aaaaa" }]);
    expect(findMatches(doc, "aa")).toHaveLength(2);
    expect(findMatches(doc, "")).toEqual([]);
  });

  it("does not run across line breaks", () => {
    const doc = docOf([{ type: "paragraph", content: "one\ntwo" }]);
    expect(findMatches(doc, "onetwo")).toEqual([]);
    const [two] = findMatches(doc, "two");
    expect(doc.textBetween(two.from, two.to)).toBe("two");
  });
});

describe("accents", () => {
  const textOf = (doc: ReturnType<typeof docOf>, query: string, options = {}) =>
    findMatches(doc, query, options).map((m) => doc.textBetween(m.from, m.to));

  it("matches letters whatever accents they carry, unless accents matter", () => {
    const doc = docOf([{ type: "paragraph", content: "Café cafe naïve naive Ångström" }]);
    expect(textOf(doc, "cafe")).toEqual(["Café", "cafe"]);
    expect(textOf(doc, "café")).toEqual(["Café", "cafe"]);
    expect(textOf(doc, "naive")).toEqual(["naïve", "naive"]);
    expect(textOf(doc, "angstrom")).toEqual(["Ångström"]);
    expect(textOf(doc, "cafe", { matchAccents: true })).toEqual(["cafe"]);
    expect(textOf(doc, "café", { matchAccents: true })).toEqual(["Café"]);
  });

  it("folds the Turkish letters to their plain ones", () => {
    const doc = docOf([{ type: "paragraph", content: "Çiğdem Şükrü Öğüt ışık" }]);
    expect(textOf(doc, "cigdem")).toEqual(["Çiğdem"]);
    expect(textOf(doc, "sukru")).toEqual(["Şükrü"]);
    expect(textOf(doc, "ogut")).toEqual(["Öğüt"]);
    expect(textOf(doc, "isik")).toEqual(["ışık"]);
    expect(textOf(doc, "CIGDEM", { locale: "tr" })).toEqual(["Çiğdem"]);
    expect(textOf(doc, "cigdem", { matchAccents: true })).toEqual([]);
    expect(textOf(doc, "çiğdem", { matchAccents: true })).toEqual(["Çiğdem"]);
  });

  it("keeps the Turkish case rule when accents matter, and lets ı meet i when they don't", () => {
    const doc = docOf([{ type: "paragraph", content: "IRMAK irmak ırmak" }]);
    // Accents matter: Turkish pairs "I" with "ı" only; English pairs "I" with "i" only.
    expect(textOf(doc, "ırmak", { locale: "tr", matchAccents: true })).toEqual(["IRMAK", "ırmak"]);
    expect(textOf(doc, "irmak", { locale: "tr", matchAccents: true })).toEqual(["irmak"]);
    expect(textOf(doc, "irmak", { locale: "en", matchAccents: true })).toEqual(["IRMAK", "irmak"]);
    expect(textOf(doc, "ırmak", { locale: "en", matchAccents: true })).toEqual(["ırmak"]);
    // Accents don't matter: all three are the same word in either language.
    expect(textOf(doc, "irmak", { locale: "tr" })).toEqual(["IRMAK", "irmak", "ırmak"]);
    expect(textOf(doc, "ırmak", { locale: "en" })).toEqual(["IRMAK", "irmak", "ırmak"]);
    // "İ" still folds to a plain "i".
    expect(foldForSearch("İSTANBUL", { locale: "en" })).toBe("istanbul");
  });

  it("folds accents but not case when case matters", () => {
    const doc = docOf([{ type: "paragraph", content: "Élan élan" }]);
    expect(textOf(doc, "Elan", { caseSensitive: true })).toEqual(["Élan"]);
    expect(textOf(doc, "elan", { caseSensitive: true })).toEqual(["élan"]);
    expect(textOf(doc, "elan", { caseSensitive: true, matchAccents: true })).toEqual([]);
  });

  it("keeps every character where it was", () => {
    const samples = ["Çağrı İŞÇİ", "naïve café", "été", "😀 café 👍🏽", "한국어 がぎ", "ﬁne Ǆ"];
    for (const text of samples) {
      for (const options of [{}, { locale: "tr" }, { caseSensitive: true }, { matchAccents: true }]) {
        expect(foldForSearch(text, options).length).toBe(text.length);
      }
    }
    // Letters that don't come apart into a letter and accents stay as they are.
    expect(foldForSearch("한국어 がぎ ﬁ")).toBe("한국어 がぎ ﬁ");
    expect(foldForSearch("😀 Ç")).toBe("😀 c");
  });

  it("skips accents written on their own after their letter", () => {
    // "e" followed by a combining acute, as decomposed text holds it.
    expect(foldForSearch("café")).toBe(`cafe${SKIPPED}`);
    expect(matchRanges(foldForSearch("café x"), "cafe")).toEqual([[0, 5]]);
    expect(matchRanges(foldForSearch("résumé"), "resume")).toEqual([[0, 8]]);
    // A query with them skips them too; a query of accents alone finds nothing.
    expect(matchRanges("resume", foldForSearch("résumé"))).toEqual([[0, 6]]);
    expect(matchRanges("abc", foldForSearch("́"))).toEqual([]);

    const doc = docOf([{ type: "paragraph", content: "a café and a café" }]);
    const matches = findMatches(doc, "café");
    expect(matches.map((m) => doc.textBetween(m.from, m.to))).toEqual(["café", "café"]);
    // The decomposed one is a character longer, and the second match starts where it should.
    expect(matches[0].to - matches[0].from).toBe(5);
    expect(matches[1].to - matches[1].from).toBe(4);
    // With accents mattering, the marks are ordinary characters again.
    expect(textOf(doc, "cafe", { matchAccents: true })).toEqual(["cafe"]);
  });

  it("keeps offsets after emoji and other surrogate pairs", () => {
    const doc = docOf([{ type: "paragraph", content: "😀👍🏽 Ölçü 𝒳 olcu" }]);
    const matches = findMatches(doc, "olcu");
    expect(matches.map((m) => doc.textBetween(m.from, m.to))).toEqual(["Ölçü", "olcu"]);
    expect(textOf(doc, "👍🏽")).toEqual(["👍🏽"]);
    expect(textOf(doc, "𝒳")).toEqual(["𝒳"]);
  });

  it("replaces folded matches, the accents written on their own included", () => {
    const state = stateOf([{ type: "paragraph", content: "Şeker, seker and sekeré" }]);
    const matches = findMatches(state.doc, "seker");
    expect(matches).toHaveLength(3);
    const next = state.apply(replaceAllMatches(state.tr, matches, "şeker"));
    expect(texts(next)).toEqual(["şeker, şeker and şekeré"]);

    const decomposed = stateOf([{ type: "paragraph", content: "un café noir" }]);
    const [match] = findMatches(decomposed.doc, "cafe");
    const replaced = decomposed.apply(replaceMatch(decomposed.tr, match, "thé"));
    // The accent went with its letter: none is left hanging on the next character.
    expect(texts(replaced)).toEqual(["un thé noir"]);
  });
});

describe("match navigation", () => {
  const matches = [
    { from: 5, to: 8 },
    { from: 20, to: 23 },
    { from: 40, to: 43 },
  ];

  it("starts at the first match at or after a position, wrapping to the first", () => {
    expect(matchIndexAt(matches, 0)).toBe(0);
    expect(matchIndexAt(matches, 5)).toBe(0);
    expect(matchIndexAt(matches, 6)).toBe(1);
    expect(matchIndexAt(matches, 41)).toBe(0);
    expect(matchIndexAt([], 3)).toBe(-1);
  });

  it("steps forward and back around the ends", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("replacing", () => {
  it("replaces one match, keeping the formatting of its first character", () => {
    const state = stateOf([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "say ", styles: {} },
          { type: "text", text: "hel", styles: { bold: true } },
          { type: "text", text: "lo there", styles: {} },
        ],
      },
    ]);
    const [match] = findMatches(state.doc, "hello");
    const next = state.apply(replaceMatch(state.tr, match, "goodbye"));
    expect(texts(next)).toEqual(["say goodbye there"]);
    const [replaced] = findMatches(next.doc, "goodbye");
    let bold = true;
    next.doc.nodesBetween(replaced.from, replaced.to, (node) => {
      if (node.isText && !node.marks.some((m) => m.type.name === "bold")) bold = false;
    });
    expect(bold).toBe(true);
  });

  it("keeps a link when its whole text is replaced", () => {
    const state = stateOf([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see ", styles: {} },
          { type: "link", href: "https://example.com", content: "docs" },
          { type: "text", text: " now", styles: {} },
        ],
      },
    ]);
    const [match] = findMatches(state.doc, "docs");
    const next = state.apply(replaceMatch(state.tr, match, "guide"));
    const [replaced] = findMatches(next.doc, "guide");
    const node = next.doc.nodeAt(replaced.from);
    expect(node?.marks.map((m) => m.type.name)).toContain("link");
  });

  it("replaces every match in one transaction", () => {
    const state = stateOf([
      { type: "paragraph", content: "cat and cat" },
      { type: "bulletListItem", content: "Cat", children: [{ type: "paragraph", content: "concat" }] },
    ]);
    const matches = findMatches(state.doc, "cat");
    expect(matches).toHaveLength(4);
    const tr = replaceAllMatches(state.tr, matches, "dog");
    expect(tr.steps).toHaveLength(4);
    const next = state.apply(tr);
    expect(texts(next)).toEqual(["dog and dog", "dog", "condog"]);
  });

  it("copes with a replacement that contains the query", () => {
    const state = stateOf([{ type: "paragraph", content: "a b a" }]);
    const next = state.apply(replaceAllMatches(state.tr, findMatches(state.doc, "a"), "aa"));
    expect(texts(next)).toEqual(["aa b aa"]);
  });

  it("deletes matches for an empty replacement without removing their blocks", () => {
    const state = stateOf([
      { type: "paragraph", content: "remove" },
      { type: "paragraph", content: "keep remove keep" },
    ]);
    const next = state.apply(replaceAllMatches(state.tr, findMatches(state.doc, "remove"), ""));
    expect(texts(next)).toEqual(["", "keep  keep"]);
  });
});
