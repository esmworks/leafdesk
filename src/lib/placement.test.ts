import { describe, expect, it } from "vitest";
import { placePanel, pointBox } from "./placement";

const view = { width: 1000, height: 800 };
const panel = { width: 200, height: 300 };
const button = { top: 100, bottom: 120, left: 400, right: 440 };

describe("placePanel", () => {
  it("opens below the anchor from its start edge", () => {
    expect(placePanel(button, panel, view)).toEqual({ top: 124, left: 400 });
    expect(placePanel(button, panel, view, { align: "end" })).toEqual({ top: 124, left: 240 });
  });

  it("takes the right edge as the start edge right to left", () => {
    expect(placePanel(button, panel, view, { rtl: true })).toEqual({ top: 124, left: 240 });
    expect(placePanel(button, panel, view, { rtl: true, align: "end" })).toEqual({ top: 124, left: 400 });
  });

  it("opens above the anchor when only there it fits", () => {
    const low = { ...button, top: 700, bottom: 720 };
    expect(placePanel(low, panel, view)).toEqual({ top: 396, left: 400 });
  });

  it("stays below and moves up into the window when it fits on neither side", () => {
    const tall = { width: 200, height: 600 };
    const middle = { ...button, top: 390, bottom: 410 };
    expect(placePanel(middle, tall, view)).toEqual({ top: 192, left: 400 });
  });

  it("keeps clear of the window's sides", () => {
    expect(placePanel({ ...button, left: 900, right: 940 }, panel, view)).toEqual({ top: 124, left: 792 });
    expect(placePanel({ ...button, left: 0, right: 40 }, panel, view, { rtl: true })).toEqual({ top: 124, left: 8 });
  });

  it("overlays the anchor when covering it, and the anchor's bottom when flipped", () => {
    expect(placePanel(button, panel, view, { cover: true })).toEqual({ top: 100, left: 400 });
    const low = { ...button, top: 700, bottom: 720 };
    expect(placePanel(low, panel, view, { cover: true })).toEqual({ top: 420, left: 400 });
  });

  it("opens a menu at a point upward near the window's bottom", () => {
    expect(placePanel(pointBox(300, 200), panel, view, { gap: 0 })).toEqual({ top: 200, left: 300 });
    expect(placePanel(pointBox(300, 700), panel, view, { gap: 0 })).toEqual({ top: 400, left: 300 });
  });
});
