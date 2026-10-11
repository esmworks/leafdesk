import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  neighbours,
  opensNewTab,
  parsePanelWidth,
  ROW_PANEL_WIDTH,
  rowFromSearch,
  stepKey,
  withRow,
} from "./row-panel";

describe("rowFromSearch", () => {
  it("reads the open row from the address", () => {
    expect(rowFromSearch("?view=v1&row=3f2a-b9")).toBe("3f2a-b9");
    expect(rowFromSearch(new URLSearchParams("row=abc"))).toBe("abc");
  });

  it("ignores a missing, empty or malformed row", () => {
    expect(rowFromSearch("?view=v1")).toBeNull();
    expect(rowFromSearch("?row=")).toBeNull();
    expect(rowFromSearch("?row=a/b")).toBeNull();
    expect(rowFromSearch(`?row=${"x".repeat(200)}`)).toBeNull();
  });
});

describe("withRow", () => {
  it("sets the row and keeps the rest of the address", () => {
    expect(withRow("/w/ws/p/db?view=v1", "r1")).toBe("/w/ws/p/db?view=v1&row=r1");
    expect(withRow("http://localhost:3000/w/ws/p/db?row=r1#top", "r2")).toBe("http://localhost:3000/w/ws/p/db?row=r2#top");
  });

  it("takes the row out", () => {
    expect(withRow("/w/ws/p/db?row=r1&view=v1", null)).toBe("/w/ws/p/db?view=v1");
    expect(withRow("http://localhost:3000/w/ws/p/db?row=r1", null)).toBe("http://localhost:3000/w/ws/p/db");
  });
});

describe("neighbours", () => {
  it("finds the rows before and after in the view's order", () => {
    expect(neighbours(["a", "b", "c"], "b")).toEqual({ previous: "a", next: "c" });
    expect(neighbours(["a", "b", "c"], "a")).toEqual({ previous: null, next: "b" });
    expect(neighbours(["a", "b", "c"], "c")).toEqual({ previous: "b", next: null });
  });

  it("counts a row shown twice once, where it first shows", () => {
    // A calendar bar over two weeks, a timeline row and its bar.
    expect(neighbours(["a", "b", "a", "c", "b"], "b")).toEqual({ previous: "a", next: "c" });
  });

  it("has none for a row the view doesn't show", () => {
    expect(neighbours(["a", "b"], "z")).toEqual({ previous: null, next: null });
    expect(neighbours([], "a")).toEqual({ previous: null, next: null });
  });
});

describe("clampPanelWidth", () => {
  it("keeps the width between its bounds", () => {
    expect(clampPanelWidth(100, 2000)).toBe(ROW_PANEL_WIDTH.min);
    expect(clampPanelWidth(5000, 4000)).toBe(ROW_PANEL_WIDTH.max);
    expect(clampPanelWidth(640.4, 2000)).toBe(640);
  });

  it("leaves the view some room on narrower windows, but never goes under the minimum", () => {
    expect(clampPanelWidth(1000, 1024)).toBe(1024 - ROW_PANEL_WIDTH.minView);
    expect(clampPanelWidth(1000, 600)).toBe(ROW_PANEL_WIDTH.min);
  });

  it("falls back to the default for a width that isn't a number", () => {
    expect(clampPanelWidth(Number.NaN, 2000)).toBe(ROW_PANEL_WIDTH.default);
  });
});

describe("parsePanelWidth", () => {
  it("reads a saved width, else the default", () => {
    expect(parsePanelWidth("720")).toBe(720);
    expect(parsePanelWidth(null)).toBe(ROW_PANEL_WIDTH.default);
    expect(parsePanelWidth("wide")).toBe(ROW_PANEL_WIDTH.default);
    expect(parsePanelWidth("-5")).toBe(ROW_PANEL_WIDTH.default);
  });
});

describe("opensNewTab", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false };
  it("opens a new tab with ⌘, Ctrl or Shift held, or the middle button", () => {
    expect(opensNewTab(click)).toBe(false);
    expect(opensNewTab({ ...click, metaKey: true })).toBe(true);
    expect(opensNewTab({ ...click, ctrlKey: true })).toBe(true);
    expect(opensNewTab({ ...click, shiftKey: true })).toBe(true);
    expect(opensNewTab({ ...click, button: 1 })).toBe(true);
  });
});

describe("stepKey", () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  it("goes back with K and on with J", () => {
    expect(stepKey(key("k"))).toBe(-1);
    expect(stepKey(key("J"))).toBe(1);
    expect(stepKey(key("x"))).toBeNull();
  });

  it("leaves combinations with ⌘, Ctrl or Alt to others", () => {
    expect(stepKey(key("k", { metaKey: true }))).toBeNull();
    expect(stepKey(key("j", { ctrlKey: true }))).toBeNull();
    expect(stepKey(key("j", { altKey: true }))).toBeNull();
  });
});
