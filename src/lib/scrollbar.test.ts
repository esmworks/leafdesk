import { describe, expect, it } from "vitest";
import { MIN_THUMB, scrollLeftForDrag, scrollLeftForTrackPoint, scrollRange, thumbGeometry } from "./scrollbar";

const wide = { scrollWidth: 3000, clientWidth: 1000 };

describe("scrollRange", () => {
  it("is zero when the content fits, or overflows by under a pixel", () => {
    expect(scrollRange({ scrollWidth: 1000, clientWidth: 1000 })).toBe(0);
    expect(scrollRange({ scrollWidth: 1001, clientWidth: 1000 })).toBe(0);
    expect(scrollRange(wide)).toBe(2000);
  });
});

describe("thumbGeometry", () => {
  it("has no thumb when nothing overflows", () => {
    expect(thumbGeometry({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800, rtl: false }, 800)).toBeNull();
  });

  it("sizes the thumb by the visible share and moves it with the scroll", () => {
    expect(thumbGeometry({ ...wide, scrollLeft: 0, rtl: false }, 900)).toEqual({ size: 300, offset: 0 });
    expect(thumbGeometry({ ...wide, scrollLeft: 1000, rtl: false }, 900)).toEqual({ size: 300, offset: 300 });
    expect(thumbGeometry({ ...wide, scrollLeft: 2000, rtl: false }, 900)).toEqual({ size: 300, offset: 600 });
  });

  it("keeps a grabbable thumb on a very wide box", () => {
    const g = thumbGeometry({ scrollLeft: 0, scrollWidth: 100_000, clientWidth: 1000, rtl: false }, 900);
    expect(g?.size).toBe(MIN_THUMB);
  });

  it("starts on the right in a right-to-left box", () => {
    expect(thumbGeometry({ ...wide, scrollLeft: 0, rtl: true }, 900)).toEqual({ size: 300, offset: 600 });
    expect(thumbGeometry({ ...wide, scrollLeft: -2000, rtl: true }, 900)).toEqual({ size: 300, offset: 0 });
  });
});

describe("scrollLeftForDrag", () => {
  const m = { ...wide, rtl: false };
  it("moves the box by the thumb's share of the range", () => {
    expect(scrollLeftForDrag(0, 300, m, 900, 300)).toBe(1000);
    expect(scrollLeftForDrag(1000, -600, m, 900, 300)).toBe(0);
    expect(scrollLeftForDrag(1500, 900, m, 900, 300)).toBe(2000);
  });

  it("goes the same way on screen in a right-to-left box", () => {
    const r = { ...m, rtl: true };
    expect(scrollLeftForDrag(0, -300, r, 900, 300)).toBe(-1000);
    expect(scrollLeftForDrag(0, 300, r, 900, 300)).toBe(0);
    expect(scrollLeftForDrag(-1500, -900, r, 900, 300)).toBe(-2000);
  });
});

describe("scrollLeftForTrackPoint", () => {
  it("centres the thumb on the point", () => {
    expect(scrollLeftForTrackPoint(450, { ...wide, rtl: false }, 900, 300)).toBe(1000);
    expect(scrollLeftForTrackPoint(900, { ...wide, rtl: false }, 900, 300)).toBe(2000);
    expect(scrollLeftForTrackPoint(0, { ...wide, rtl: true }, 900, 300)).toBe(-2000);
  });
});
