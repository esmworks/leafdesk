import { describe, expect, it } from "vitest";
import { listMarker, listStyleAt } from "./list-markers";

describe("list markers", () => {
  it("alternates numbers, letters and roman numerals by level", () => {
    expect([0, 1, 2, 3, 4, 5].map(listStyleAt)).toEqual(["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"]);
  });

  it("writes letters past z as aa, ab …", () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map((n) => listMarker(n, "lower-alpha"))).toEqual([
      "a", "b", "z", "aa", "ab", "az", "ba", "zz", "aaa",
    ]);
  });

  it("writes roman numerals", () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map((n) => listMarker(n, "lower-roman"))).toEqual([
      "i", "iv", "ix", "xiv", "xl", "xc", "cd", "mcmxciv", "mmmcmxcix",
    ]);
  });

  it("falls back to numbers where letters can't say it", () => {
    expect(listMarker(0, "lower-alpha")).toBe("0");
    expect(listMarker(4000, "lower-roman")).toBe("4000");
    expect(listMarker(7, "decimal")).toBe("7");
  });
});
