import { describe, expect, it } from "vitest";
import { isDatabaseErrorCode } from "./properties";
import { MAX_PAGE_DEPTH, pageTooDeepError, treeHeight } from "./page-depth";

describe("MAX_PAGE_DEPTH", () => {
  it("stays below the 64 steps the access rule walks up", () => {
    expect(MAX_PAGE_DEPTH).toBeLessThan(64);
  });
});

describe("pageTooDeepError", () => {
  it("carries a code the actions translate, with the limit", () => {
    const error = pageTooDeepError();
    expect(isDatabaseErrorCode(error.code)).toBe(true);
    expect(error.params).toEqual({ max: String(MAX_PAGE_DEPTH) });
  });
});

describe("treeHeight", () => {
  it("is 0 for a page alone", () => {
    expect(treeHeight([{ id: "a", parentId: "elsewhere" }], "a")).toBe(0);
  });

  it("counts the longest way down from the root", () => {
    const pages = [
      { id: "a", parentId: "elsewhere" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
      { id: "d", parentId: "a" },
    ];
    expect(treeHeight(pages, "a")).toBe(2);
    // The order of the list doesn't matter.
    expect(treeHeight([...pages].reverse(), "a")).toBe(2);
  });

  it("doesn't loop on a cycle in the data", () => {
    const pages = [
      { id: "a", parentId: null },
      { id: "b", parentId: "c" },
      { id: "c", parentId: "b" },
    ];
    expect(treeHeight(pages, "a")).toBeLessThanOrEqual(2);
  });
});
