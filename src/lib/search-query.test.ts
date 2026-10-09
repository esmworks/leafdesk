import { describe, expect, it } from "vitest";
import { hasSearchFilters, parseSearchQuery } from "./search-query";

describe("parseSearchQuery", () => {
  it("leaves plain text as it is", () => {
    expect(parseSearchQuery("  launch   plan ")).toEqual({ text: "launch plan", within: [], kinds: [] });
  });

  it("takes in: filters, quoted or not, anywhere in the query", () => {
    expect(parseSearchQuery('budget in:Projects in:"Launch plan" q3')).toEqual({
      text: "budget q3",
      within: ["Projects", "Launch plan"],
      kinds: [],
    });
    expect(parseSearchQuery("in:projects IN:Projects").within).toEqual(["projects"]);
  });

  it("takes type: filters and their plurals", () => {
    expect(parseSearchQuery("type:Database type:rows type:db type:page").kinds).toEqual(["database", "row", "page"]);
  });

  it("searches unknown filters, empty values and phrases as text", () => {
    expect(parseSearchQuery('foo:bar type:folder in: "a phrase" key:"two words"')).toEqual({
      text: "foo:bar type:folder in: a phrase two words",
      within: [],
      kinds: [],
    });
  });

  it("lets a quote run to the end", () => {
    expect(parseSearchQuery('in:"Open quote').within).toEqual(["Open quote"]);
    expect(parseSearchQuery('"unclosed phrase').text).toBe("unclosed phrase");
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
  });
});
