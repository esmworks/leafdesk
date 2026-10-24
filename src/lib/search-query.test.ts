import { describe, expect, it } from "vitest";
import { hasSearchFilters, parseSearchQuery } from "./search-query";

describe("parseSearchQuery", () => {
  it("leaves plain text as it is", () => {
    expect(parseSearchQuery("  launch   plan ")).toEqual({ text: "launch plan", within: [], kinds: [], verified: false, phrases: [] });
  });

  it("takes in: filters, quoted or not, anywhere in the query", () => {
    expect(parseSearchQuery('budget in:Projects in:"Launch plan" q3')).toEqual({
      text: "budget q3",
      within: ["Projects", "Launch plan"],
      kinds: [],
      verified: false,
      phrases: [],
    });
    expect(parseSearchQuery("in:projects IN:Projects").within).toEqual(["projects"]);
  });

  it("takes type: filters and their plurals", () => {
    expect(parseSearchQuery("type:Database type:rows type:db type:page").kinds).toEqual(["database", "row", "page"]);
  });

  it("takes type:journal (and daily) for daily notes", () => {
    expect(parseSearchQuery("standup type:journal type:Daily")).toEqual({ text: "standup", within: [], kinds: ["journal"], verified: false, phrases: [] });
  });

  it("searches unknown filters, empty values and phrases as text", () => {
    expect(parseSearchQuery('foo:bar type:folder in: "a phrase" key:"two words"')).toEqual({
      text: "foo:bar type:folder in: a phrase two words",
      within: [],
      kinds: [],
      verified: false,
      phrases: ["a phrase"],
    });
  });

  it("takes is:verified, and searches other is: values as text", () => {
    expect(parseSearchQuery("onboarding IS:Verified")).toEqual({ text: "onboarding", within: [], kinds: [], verified: true, phrases: [] });
    expect(parseSearchQuery("is:done").text).toBe("is:done");
  });

  it("lets a quote run to the end", () => {
    expect(parseSearchQuery('in:"Open quote').within).toEqual(["Open quote"]);
    expect(parseSearchQuery('"unclosed phrase').text).toBe("unclosed phrase");
  });

  it("keeps closed quotes as phrases, their words in the text too", () => {
    const parsed = parseSearchQuery('budget "launch   plan" in:"Q3 work" "launch plan" "--"');
    expect(parsed.phrases).toEqual(["launch plan"]);
    expect(parsed.text).toBe("budget launch plan launch plan --");
    expect(parsed.within).toEqual(["Q3 work"]);
    expect(parseSearchQuery('"会議 資料" 東京').phrases).toEqual(["会議 資料"]);
    expect(parseSearchQuery('"plan"').phrases).toEqual(["plan"]);
  });

  it("searches a quote still being typed as words", () => {
    expect(parseSearchQuery('"launch pl').phrases).toEqual([]);
    expect(parseSearchQuery('"launch pl').text).toBe("launch pl");
  });

  it("splits long input in one pass", () => {
    const long = `${"a:".repeat(20_000)}" ${"in:x ".repeat(2_000)}`;
    const started = performance.now();
    const parsed = parseSearchQuery(long);
    expect(performance.now() - started).toBeLessThan(500);
    expect(parsed.within).toEqual(["x"]);
  });

  it("tells whether a query has filters", () => {
    expect(hasSearchFilters(parseSearchQuery("text"))).toBe(false);
    expect(hasSearchFilters(parseSearchQuery("type:row"))).toBe(true);
    expect(hasSearchFilters(parseSearchQuery("is:verified"))).toBe(true);
  });
});
