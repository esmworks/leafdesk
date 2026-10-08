import { describe, expect, it } from "vitest";
import { backgroundText, pageBackground, parseBackgroundText, parsePageBackground } from "./page-background";

describe("parsePageBackground", () => {
  it("reads a color, a pattern or both", () => {
    expect(parsePageBackground({ color: "blue", pattern: null })).toEqual({ color: "blue", pattern: null });
    expect(parsePageBackground({ color: null, pattern: "dots" })).toEqual({ color: null, pattern: "dots" });
    expect(parsePageBackground({ color: "black", pattern: "plus" })).toEqual({ color: "black", pattern: "plus" });
  });

  it("reads backgrounds stored by the earlier build", () => {
    expect(parsePageBackground({ kind: "color", color: "green" })).toEqual({ color: "green", pattern: null });
  });

  it("drops unknown names, and reads images and anything else as no background", () => {
    expect(parsePageBackground({ color: "toString", pattern: "dots" })).toEqual({ color: null, pattern: "dots" });
    // Yellow and brown tints are left out of the palette.
    expect(parsePageBackground({ color: "yellow" })).toBeNull();
    expect(parsePageBackground({ kind: "image", url: "https://images.example/a.jpg" })).toBeNull();
    expect(parsePageBackground({ kind: "image", color: "blue" })).toBeNull();
    expect(parsePageBackground(null)).toBeNull();
    expect(parsePageBackground("blue")).toBeNull();
    expect(parsePageBackground({ kind: "gradient", gradient: "forest" })).toBeNull();
  });
});

describe("pageBackground", () => {
  it("is none when it has neither a color nor a pattern", () => {
    expect(pageBackground(null, null)).toBeNull();
    expect(pageBackground("red", null)).toEqual({ color: "red", pattern: null });
  });
});

describe("background text", () => {
  it("round-trips colors, patterns and both", () => {
    for (const text of ["color:green", "pattern:grid", "color:black pattern:plus"]) {
      const parsed = parseBackgroundText(text);
      expect(parsed).not.toBeNull();
      expect(backgroundText(parsed!)).toBe(text);
    }
    expect(parseBackgroundText("  pattern:dots   color:blue ")).toEqual({ color: "blue", pattern: "dots" });
  });

  it("refuses unknown names, repeats, links and other text", () => {
    expect(parseBackgroundText("color:plaid")).toBeNull();
    expect(parseBackgroundText("pattern:stars")).toBeNull();
    expect(parseBackgroundText("color:red color:blue")).toBeNull();
    expect(parseBackgroundText("gradient:forest")).toBeNull();
    expect(parseBackgroundText("https://images.example/a.jpg")).toBeNull();
    expect(parseBackgroundText("/api/files/AbCdEfGhIjKlMnOpQrStUvWx")).toBeNull();
    expect(parseBackgroundText("")).toBeNull();
    // Nothing may follow the name: not a second value, not a link.
    expect(parseBackgroundText("color:gray:https://images.example/a.jpg")).toBeNull();
    expect(parseBackgroundText("pattern:dots:")).toBeNull();
  });
});
