import { describe, expect, it } from "vitest";
import { backgroundText, parseBackgroundText, parsePageBackground } from "./page-background";

describe("parsePageBackground", () => {
  it("reads colors by name only", () => {
    expect(parsePageBackground({ kind: "color", color: "blue" })).toEqual({ kind: "color", color: "blue" });
    expect(parsePageBackground({ kind: "color", color: "toString" })).toBeNull();
    // Yellow and brown tints are left out of the palette.
    expect(parsePageBackground({ kind: "color", color: "yellow" })).toBeNull();
  });

  it("reads images and anything else as no background", () => {
    expect(parsePageBackground({ kind: "image", url: "https://images.example/a.jpg" })).toBeNull();
    expect(parsePageBackground({ kind: "image", url: "/api/files/AbCdEfGhIjKlMnOpQrStUvWx" })).toBeNull();
    expect(parsePageBackground(null)).toBeNull();
    expect(parsePageBackground("blue")).toBeNull();
    expect(parsePageBackground({ kind: "gradient", gradient: "forest" })).toBeNull();
  });
});

describe("background text", () => {
  it("round-trips colors", () => {
    const color = parseBackgroundText(" color:green ");
    expect(color).toEqual({ kind: "color", color: "green" });
    expect(backgroundText(color!)).toBe("color:green");
  });

  it("refuses unknown colors, links and other text", () => {
    expect(parseBackgroundText("color:plaid")).toBeNull();
    expect(parseBackgroundText("gradient:forest")).toBeNull();
    expect(parseBackgroundText("https://images.example/a.jpg")).toBeNull();
    expect(parseBackgroundText("/api/files/AbCdEfGhIjKlMnOpQrStUvWx")).toBeNull();
    expect(parseBackgroundText("a sunset")).toBeNull();
  });
});
