import { describe, expect, it } from "vitest";
import { DEFAULT_LOAD_LIMIT, firstRows, isLoadLimit, loadLimitOf } from "./load-limit";

const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}` }));

describe("firstRows", () => {
  it("shows every row when they fit", () => {
    expect(firstRows(rows, 8)).toEqual({ shown: rows, hidden: 0 });
    expect(firstRows(rows, 20).hidden).toBe(0);
  });

  it("shows the first rows and counts the rest", () => {
    const { shown, hidden } = firstRows(rows, 3);
    expect(shown.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(hidden).toBe(5);
  });

  it("keeps rows added here that sit further down, where they stand", () => {
    const { shown, hidden } = firstRows(rows, 3, ["r7", "r5"]);
    expect(shown.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r5", "r7"]);
    expect(hidden).toBe(3);
    expect(firstRows(rows, 3, ["r1"]).shown).toHaveLength(3);
    expect(firstRows(rows, 3, ["gone"]).shown).toHaveLength(3);
  });
});

describe("loadLimitOf", () => {
  it("takes the view's limit, else the default", () => {
    expect(loadLimitOf({ loadLimit: 25 })).toBe(25);
    expect(loadLimitOf({})).toBe(DEFAULT_LOAD_LIMIT);
    expect(loadLimitOf({ loadLimit: 7 as never })).toBe(DEFAULT_LOAD_LIMIT);
  });

  it("knows the limits", () => {
    expect([10, 25, 50, 100].every(isLoadLimit)).toBe(true);
    expect(isLoadLimit(0)).toBe(false);
    expect(isLoadLimit("50")).toBe(false);
  });
});
