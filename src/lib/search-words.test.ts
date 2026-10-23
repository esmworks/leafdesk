import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anyWordTerms, anyWordTsQuery, CJK_RANGES, cjkTsQuery, isCjkTerm, searchQueryParts } from "./search-words";

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

  it("drops the question words of the other interface languages, not Turkish words that look alike", () => {
    expect(anyWordTerms("Was ist der Stand der Rechnung?")).toEqual(["Stand", "Rechn"]);
    expect(anyWordTerms("¿Dónde está la factura de octubre?")).toEqual(["factu", "octub"]);
    expect(anyWordTerms("Где счёт за октябрь?")).toEqual(["счёт", "октяб"]);
    expect(anyWordTerms("أين فاتورة أكتوبر؟")).toEqual(["فاتورة", "أكتوبر"]);
    expect(anyWordTerms("para transferi")).toEqual(["para", "trans"]);
    expect(anyWordTerms("Di mana tagihan untuk bulan Oktober?")).toEqual(["mana", "tagih", "bulan", "Oktob"]);
    expect(anyWordTerms("Hóa đơn tháng mười ở đâu?")).toEqual(["Hóa", "đơn", "tháng", "mười"]);
  });

  it("lets nothing but letters and digits through, each word once", () => {
    expect(anyWordTerms("a'b & c | d:* !(x) '); drop--")).toEqual(["drop"]);
    expect(anyWordTerms("2026 ödeme Ödeme ÖDEME")).toEqual(["2026", "ödeme"]);
    expect(anyWordTerms("")).toEqual([]);
  });

  it("takes the words of Japanese and Chinese questions, without particles and function words", () => {
    expect(anyWordTerms("明日の会議について")).toEqual(["明日", "会議"]);
    expect(anyWordTerms("上周的会议纪要在哪里")).toEqual(["上周", "会议纪要"]);
    // A single character can be what is asked about; function words alone give nothing.
    expect(anyWordTerms("车在哪里")).toEqual(["车"]);
    expect(anyWordTerms("什么")).toEqual([]);
    // A word written in hiragana alone stays whole; in a Japanese question 都 is part of a word.
    expect(anyWordTerms("ありがとう")).toEqual(["ありがとう"]);
    expect(anyWordTerms("東京都の会議")).toEqual(["東京都", "会議"]);
    expect(anyWordTerms("Leafdesk会議")).toEqual(["Leafd", "会議"]);
  });

  it("takes Korean words from two syllables, without a particle at their end", () => {
    expect(anyWordTerms("회의록은 어디에 있어요")).toEqual(["회의록"]);
    expect(anyWordTerms("회의를 메모")).toEqual(["회의", "메모"]);
  });

  it("finds Japanese and Chinese words by their pieces, side by side", () => {
    expect(anyWordTsQuery(["会議", "plan"])).toBe("会議 | plan:*");
    expect(anyWordTsQuery(["会议纪要", "车"])).toBe("(会议 <-> 议纪 <-> 纪要) | 车:*");
  });
});

describe("Chinese and Japanese query text", () => {
  it("keeps the pieces of a word side by side, and only requires the pieces with particles", () => {
    expect(cjkTsQuery("東京都")).toBe("(東京 <-> 京都)");
    expect(cjkTsQuery("明日の会議")).toBe("(明日 & 日の & の会 & 会議)");
    expect(cjkTsQuery("会議室の予約")).toBe("((会議 <-> 議室) & 室の & の予 & 予約)");
    expect(cjkTsQuery("上周的会议纪要")).toBe("(上周 & 周的 & 的会 & (会议 <-> 议纪 <-> 纪要))");
    expect(cjkTsQuery("会議")).toBe("会議");
    expect(cjkTsQuery("会")).toBe("会:*");
  });

  it("splits a query into the parser's words and the Chinese and Japanese runs", () => {
    expect(searchQueryParts("会議 plan")).toEqual({ words: "plan", cjk: ["会議"] });
    expect(searchQueryParts("Q3の会議")).toEqual({ words: "Q3", cjk: ["(の会 & 会議)"] });
    expect(searchQueryParts("회의를 kond e-posta")).toEqual({ words: "회의를 kond e-posta", cjk: [] });
    expect(searchQueryParts("コーヒー・カップ")).toEqual({ words: "・", cjk: ["(コー <-> ーヒ <-> ヒー)", "(カッ <-> ップ)"] });
    expect(searchQueryParts("")).toEqual({ words: "", cjk: [] });
  });

  it("tells which terms are Chinese or Japanese text", () => {
    expect(isCjkTerm("会議") && isCjkTerm("カード") && isCjkTerm("二〇二六") && isCjkTerm("𠮷野家")).toBe(true);
    expect(isCjkTerm("plan") || isCjkTerm("회의") || isCjkTerm("会議plan") || isCjkTerm("・") || isCjkTerm("")).toBe(false);
  });

  it("uses the character ranges of the index's cjk_bigrams", () => {
    // The last migration that writes the function is the one the database runs.
    const dir = new URL("../../drizzle/", import.meta.url);
    const file = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(new URL(name, dir), "utf8"))
      .filter((sql) => sql.includes("FUNCTION cjk_bigrams"))
      .at(-1)!;
    const sqlRanges = /regexp_matches\(.*'\[([^\]]+)\]\+'/.exec(file)?.[1] ?? "";
    expect(codePoints(sqlRanges)).toEqual(codePoints(CJK_RANGES));
  });
});

/** The code-point ranges of a character class written in \uXXXX, \u{X} and \UXXXXXXXX escapes, in order. */
function codePoints(ranges: string): [number, number][] {
  const point = String.raw`\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))`;
  const range = new RegExp(`${point}(?:-${point})?`, "g");
  expect(ranges.replace(range, "")).toBe("");
  return [...ranges.matchAll(range)]
    .map((m): [number, number] => {
      const start = parseInt(m[1] ?? m[2] ?? m[3], 16);
      const end = m[4] ?? m[5] ?? m[6];
      return [start, end ? parseInt(end, 16) : start];
    })
    .sort((a, b) => a[0] - b[0]);
}
