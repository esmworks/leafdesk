import { describe, expect, it } from "vitest";
import { cutShort } from "./truncated-titles";

const size = (scrollWidth: number, clientWidth: number, scrollHeight = 20, clientHeight = 20) => ({ scrollWidth, clientWidth, scrollHeight, clientHeight });

describe("cutShort", () => {
  it("is text ending in an ellipsis that doesn't fit", () => {
    expect(cutShort({ textOverflow: "ellipsis" }, size(240, 120))).toBe(true);
    expect(cutShort({ textOverflow: "ellipsis" }, size(120, 120))).toBe(false);
    // Rounding leaves a pixel over now and then.
    expect(cutShort({ textOverflow: "ellipsis" }, size(121, 120))).toBe(false);
  });

  it("is clamped lines that don't fit", () => {
    expect(cutShort({ textOverflow: "clip", webkitLineClamp: "2" }, size(100, 100, 60, 40))).toBe(true);
    expect(cutShort({ textOverflow: "clip", webkitLineClamp: "none" }, size(100, 100, 60, 40))).toBe(false);
  });

  it("isn't text that overflows without an ellipsis", () => {
    expect(cutShort({ textOverflow: "clip" }, size(240, 120))).toBe(false);
  });
});
