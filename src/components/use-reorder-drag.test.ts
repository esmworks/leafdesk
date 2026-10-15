import { describe, expect, it } from "vitest";
import { dropPlace } from "./use-reorder-drag";

const box = { left: 100, top: 50, width: 200, height: 100 };

describe("dropPlace", () => {
  it("splits an item into left and right halves along x", () => {
    expect(dropPlace("x", box, 800, { x: 150, y: 140 })).toEqual({ side: "before", axis: "x" });
    expect(dropPlace("x", box, 800, { x: 250, y: 60 })).toEqual({ side: "after", axis: "x" });
  });

  it("splits an item into top and bottom halves along y", () => {
    expect(dropPlace("y", box, 200, { x: 290, y: 60 })).toEqual({ side: "before", axis: "y" });
    expect(dropPlace("y", box, 200, { x: 110, y: 140 })).toEqual({ side: "after", axis: "y" });
  });

  it("puts items side by side in a grid, and one as wide as its row above or below", () => {
    expect(dropPlace("grid", box, 800, { x: 280, y: 60 })).toEqual({ side: "after", axis: "x" });
    expect(dropPlace("grid", box, 200, { x: 280, y: 60 })).toEqual({ side: "before", axis: "y" });
    // Rounding of the row's width doesn't make a full-width item a column.
    expect(dropPlace("grid", box, 200.5, { x: 110, y: 140 })).toEqual({ side: "after", axis: "y" });
    expect(dropPlace("grid", box, undefined, { x: 110, y: 140 })).toEqual({ side: "before", axis: "x" });
  });
});
