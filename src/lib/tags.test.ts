import { describe, expect, it } from "vitest";
import { findTags, MAX_TAG_LENGTH, searchedTag, tagAt, tagKey, typedTag } from "./tags";

const labels = (text: string) => findTags(text).map((tag) => tag.label);

describe("findTags", () => {
  it("finds tags at the start, after spaces and after opening brackets and quotes", () => {
    expect(labels("#start middle #mid and\t#tab\n#line")).toEqual(["start", "mid", "tab", "line"]);
    expect(labels('(#paren) [#square] {#brace} "#quote" \'#single\' “#curly” «#guillemet» ¿#question')).toEqual([
      "paren",
      "square",
      "brace",
      "quote",
      "single",
      "curly",
      "guillemet",
      "question",
    ]);
  });

  it("gives where each tag is, with its # and without what ends it", () => {
    const [tag] = findTags("see #home/renovation, then");
    expect(tag).toEqual({ start: 4, end: 20, label: "home/renovation", key: "home/renovation" });
    expect("see #home/renovation, then".slice(tag.start, tag.end)).toBe("#home/renovation");
  });

  it("takes letters, digits, underscores, hyphens and slashes", () => {
    expect(labels("#q3_launch-plan #2026/goals #v2")).toEqual(["q3_launch-plan", "2026/goals", "v2"]);
  });

  it("ends at punctuation, and leaves a trailing slash or hyphen out", () => {
    expect(labels("#done. #why? #list, #a:b #home/ #draft- #x--")).toEqual(["done", "why", "list", "a", "home", "draft", "x"]);
    expect(labels("#tag's #tag@x #a#b")).toEqual(["tag", "tag", "a"]);
  });

  it("ends at a double slash", () => {
    expect(labels("#a//b #c///")).toEqual(["a", "c"]);
  });

  it("needs a letter, and starts with a letter, digit or underscore", () => {
    expect(labels("#1 #123 #2026 #_ #-x #/x # space ## double")).toEqual([]);
    expect(labels("#_private #1st")).toEqual(["_private", "1st"]);
  });

  it("isn't the markdown heading marker", () => {
    expect(labels("# Title")).toEqual([]);
    expect(labels("## Section")).toEqual([]);
    expect(labels("### #real")).toEqual(["real"]);
  });

  it("needs whitespace or an opening bracket or quote before it", () => {
    expect(labels("C# F#minor issue#12 https://x.test/#anchor a.#b x)#y")).toEqual([]);
  });

  it("isn't a hex color with a digit in it", () => {
    expect(labels("#ff0000 #1a2 #0f0 #12345678 #c0ffee")).toEqual([]);
    expect(labels("#add #bad #cafe #beef #ff00zz")).toEqual(["add", "bad", "cafe", "beef", "ff00zz"]);
  });

  it("reads letters of every script", () => {
    expect(labels("#şehir #İstanbul #ışık #東京 #日本語/メモ #서울 #москва #עברית #عربي #हिंदी #café")).toEqual([
      "şehir",
      "İstanbul",
      "ışık",
      "東京",
      "日本語/メモ",
      "서울",
      "москва",
      "עברית",
      "عربي",
      "हिंदी",
      "café",
    ]);
  });

  it("reads letters outside the basic plane whole", () => {
    expect(labels("#𠀋𠀋 #a𝒳")).toEqual(["𠀋𠀋", "a𝒳"]);
  });

  it("leaves out runs too long to be a tag", () => {
    expect(labels(`#${"a".repeat(MAX_TAG_LENGTH)}`)).toHaveLength(1);
    expect(labels(`#${"a".repeat(MAX_TAG_LENGTH + 1)}`)).toEqual([]);
  });

  it("is quick on long text", () => {
    const text = "#a ".repeat(50_000) + "#".repeat(50_000);
    const started = performance.now();
    expect(findTags(text)).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("tagKey", () => {
  it("compares without case or accents", () => {
    expect(tagKey("Café")).toBe("cafe");
    expect(tagKey("CAFE")).toBe("cafe");
    expect(tagKey("Şehir/Çarşı")).toBe("sehir/carsi");
    expect(tagKey("İstanbul")).toBe("istanbul");
    expect(tagKey("IŞIK")).toBe("isik");
    expect(tagKey("ışık")).toBe("isik");
  });

  it("keeps scripts whose marks are letters", () => {
    expect(tagKey("東京")).toBe("東京");
    expect(tagKey("が")).toBe("が");
    expect(tagKey("서울")).toBe("서울");
    expect(tagKey("हिंदी")).toBe("हिंदी");
  });
});

describe("tagAt", () => {
  it("reads the tag of one #", () => {
    expect(tagAt("x #a y", 2)?.label).toBe("a");
    expect(tagAt("x #a y", 0)).toBeNull();
    expect(tagAt("x#a", 1)).toBeNull();
  });
});

describe("searchedTag", () => {
  it("takes a whole tag, a trailing slash or hyphen aside", () => {
    expect(searchedTag("Home/Renovation")?.key).toBe("home/renovation");
    expect(searchedTag("home/")?.key).toBe("home");
    expect(searchedTag("home-")?.key).toBe("home");
  });

  it("refuses what isn't one tag", () => {
    expect(searchedTag("")).toBeNull();
    expect(searchedTag("123")).toBeNull();
    expect(searchedTag("a.b")).toBeNull();
    expect(searchedTag("a b")).toBeNull();
    expect(searchedTag("a//b")).toBeNull();
    expect(searchedTag("#a")).toBeNull();
  });
});

describe("typedTag", () => {
  it("finds the tag the caret is at the end of", () => {
    expect(typedTag("notes #ho")).toEqual({ start: 6, query: "ho" });
    expect(typedTag("#home/")).toEqual({ start: 0, query: "home/" });
    expect(typedTag("#to-")).toEqual({ start: 0, query: "to-" });
  });

  it("is nothing before a letter, after the tag ends, or where no tag starts", () => {
    expect(typedTag("#")).toBeNull();
    expect(typedTag("# ")).toBeNull();
    expect(typedTag("#1")).toBeNull();
    expect(typedTag("#home ")).toBeNull();
    expect(typedTag("#home.")).toBeNull();
    expect(typedTag("C#x")).toBeNull();
    expect(typedTag("#a//")).toBeNull();
    expect(typedTag("plain")).toBeNull();
  });
});
