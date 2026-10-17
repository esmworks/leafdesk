import { describe, expect, it } from "vitest";
import { anyWordTerms, anyWordTsQuery, isCjkTerm, searchQueryText } from "./search-words";

describe("any-word search terms", () => {
  it("keeps the words worth searching for, long ones cut to a prefix", () => {
    expect(anyWordTerms("Kart ekstreleri ne durumda?")).toEqual(["Kart", "ekstr", "durum"]);
    expect(anyWordTerms("Which automobile needs tyres, and who sells them?")).toEqual(["autom", "needs", "tyres", "sells"]);
    expect(anyWordTsQuery(anyWordTerms("Garanti Ekim taksit"))).toBe("Garan:* | Ekim:* | taksit:*");
  });

  it("drops stopwords whatever their case, Turkish ones included", () => {
    expect(anyWordTerms("NEDİR bu NASIL için WHAT")).toEqual([]);
    expect(anyWordTerms("Hangi kart?")).toEqual(["kart"]);
  });

  it("lets nothing but letters and digits through, each word once", () => {
    expect(anyWordTerms("a'b & c | d:* !(x) '); drop--")).toEqual(["drop"]);
    expect(anyWordTerms("2026 ödeme Ödeme ÖDEME")).toEqual(["2026", "ödeme"]);
    expect(anyWordTerms("")).toEqual([]);
  });

  it("cuts Japanese and Chinese questions into two-character pieces, without particles and function words", () => {
    // Pieces with kana (の会, 議に, つい) hold particles and endings; 明日 and 会議 are what is asked about.
    expect(anyWordTerms("明日の会議について")).toEqual(["明日", "会議"]);
    expect(anyWordTerms("ありがとう")).toEqual(["あり", "りが", "がと", "とう"]);
    expect(anyWordTerms("上周的会议纪要在哪里")).toEqual(["上周", "会议", "议纪", "纪要"]);
    expect(anyWordTerms("Leafdesk会議")).toEqual(["Leafd", "会議"]);
    expect(anyWordTsQuery(anyWordTerms("会議 plan"))).toBe("会議:* | plan:*");
  });

  it("cuts Korean words into pieces too, so a particle joined to a word doesn't hide it", () => {
    expect(anyWordTerms("회의록은 어디")).toEqual(["회의", "의록", "록은", "어디"]);
  });
});

describe("search query text", () => {
  it("turns runs of Japanese, Chinese and Korean characters into their two-character pieces", () => {
    expect(searchQueryText("明日の会議")).toBe("明日 日の の会 会議");
    expect(searchQueryText("会議 plan")).toBe("会議  plan");
    expect(searchQueryText("회의를")).toBe("회의 의를");
    expect(searchQueryText("会")).toBe("会");
  });

  it("leaves other text as it is", () => {
    expect(searchQueryText("kond plan e-posta")).toBe("kond plan e-posta");
    expect(searchQueryText("")).toBe("");
  });

  it("tells which terms are pieces of such text", () => {
    expect(isCjkTerm("会議") && isCjkTerm("회의") && isCjkTerm("カード")).toBe(true);
    expect(isCjkTerm("plan") || isCjkTerm("会議plan") || isCjkTerm("")).toBe(false);
  });
});
