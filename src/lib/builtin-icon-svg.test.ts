import { describe, expect, it } from "vitest";
import { builtinIconSvg } from "./builtin-icon-svg";

describe("builtinIconSvg", () => {
  it("draws a built-in icon in its color", () => {
    const svg = builtinIconSvg("icon:star:blue")!;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('stroke="#0b6fa7"');
    expect(svg).toContain("<path d=");
  });

  it("uses the fallback color without one", () => {
    expect(builtinIconSvg("icon:star", { fallbackColor: "#000000" })).toContain('stroke="#000000"');
  });

  it("draws nothing for an emoji or an icon there isn't", () => {
    expect(builtinIconSvg("⭐")).toBeNull();
    expect(builtinIconSvg("icon:no-such-icon")).toBeNull();
    expect(builtinIconSvg(null)).toBeNull();
  });
});
