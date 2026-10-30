import { describe, expect, it } from "vitest";
import { fitTabs } from "./tab-fit";

describe("fitTabs", () => {
  const widths = [100, 100, 100, 100, 100];

  it("shows every tab when they all fit", () => {
    expect(fitTabs(widths, 0, 508, 2, 60)).toBeNull();
  });

  it("shows tabs in order until one doesn't fit, leaving room for the button", () => {
    // 60 for the button, then 102 a tab: three fit in 370.
    expect(fitTabs(widths, 0, 370, 2, 60)).toEqual([0, 1, 2]);
  });

  it("keeps the open tab in its place, even past the ones that don't fit", () => {
    expect(fitTabs(widths, 4, 370, 2, 60)).toEqual([0, 1, 4]);
  });

  it("stops at the first tab that doesn't fit, so a narrower one after it waits too", () => {
    expect(fitTabs([100, 200, 50, 100], 0, 300, 2, 60)).toEqual([0]);
  });

  it("keeps the open tab when nothing else fits", () => {
    expect(fitTabs(widths, 2, 120, 2, 60)).toEqual([2]);
  });

  it("works without an open tab", () => {
    expect(fitTabs(widths, -1, 270, 2, 60)).toEqual([0, 1]);
  });
});
