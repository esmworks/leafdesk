import { describe, expect, it } from "vitest";
import { holdsNothing, isPageVisibility, pageVisibilityOf, rowPageSections, type PageVisibility } from "./page-visibility";

const prop = (id: string, pageVisibility?: PageVisibility) => ({ id, options: pageVisibility ? { pageVisibility } : {} });

describe("page visibility", () => {
  it("knows the three settings and defaults to showing", () => {
    expect(["show", "hide_empty", "hide"].every(isPageVisibility)).toBe(true);
    expect(isPageVisibility("hidden")).toBe(false);
    expect(isPageVisibility(undefined)).toBe(false);
    expect(pageVisibilityOf(prop("a"))).toBe("show");
    expect(pageVisibilityOf(prop("a", "hide_empty"))).toBe("hide_empty");
    expect(pageVisibilityOf({ options: { pageVisibility: "bogus" as PageVisibility } })).toBe("show");
  });

  it("moves always-hidden properties, and empty hidden-when-empty ones, behind more properties", () => {
    const props = [prop("a"), prop("b", "hide_empty"), prop("c", "hide"), prop("d", "hide_empty"), prop("e", "show")];
    const empty = new Set(["a", "b", "c"]);
    const { shown, more } = rowPageSections(props, (p) => empty.has(p.id));
    expect(shown.map((p) => p.id)).toEqual(["a", "d", "e"]);
    expect(more.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("tells stored values that hold nothing", () => {
    expect([null, undefined, "", false, []].every(holdsNothing)).toBe(true);
    expect([0, "a", true, ["x"]].some(holdsNothing)).toBe(false);
  });

  it("shows everything when nothing is set", () => {
    const { shown, more } = rowPageSections([prop("a"), prop("b")], () => true);
    expect(shown).toHaveLength(2);
    expect(more).toEqual([]);
  });
});
