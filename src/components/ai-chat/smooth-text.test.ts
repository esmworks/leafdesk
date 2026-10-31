import { describe, expect, it } from "vitest";
import { nextShown } from "./smooth-text";

const FRAME = 1000 / 60;

/** Frames until `text` is shown whole from `shown`, a frame apart. */
function framesToShow(text: string, shown: string, writing: boolean) {
  let frames = 0;
  while (shown !== text && frames < 10_000) {
    shown = nextShown(text, shown, writing, FRAME);
    frames += 1;
  }
  return frames;
}

describe("nextShown", () => {
  it("shows a few letters a frame while an answer is written", () => {
    const text = "x".repeat(20);
    const shown = nextShown(text, "", true, FRAME);
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(text.startsWith(shown)).toBe(true);
  });

  it("shows at least a letter a frame, more when frames come late", () => {
    expect(nextShown("abcdef", "", true, 1)).toBe("a");
    // 100 ms at 90 letters a second; a longer pause counts as 100 ms.
    expect(nextShown("x".repeat(40), "", true, 100)).toHaveLength(9);
    expect(nextShown("x".repeat(40), "", true, 5_000)).toHaveLength(9);
  });

  it("catches up with a burst quickly", () => {
    // A burst of 2,000 letters at once is down to a few in under a second at 60 frames a second.
    const text = "x".repeat(2_000);
    let shown = "";
    for (let i = 0; i < 50; i++) shown = nextShown(text, shown, true, FRAME);
    expect(text.length - shown.length).toBeLessThan(10);
    expect(framesToShow(text, "", true)).toBeLessThan(60);
  });

  it("shows the rest within a few frames once written, not in one", () => {
    const text = "x".repeat(300);
    const first = nextShown(text, "", false, FRAME);
    expect(first.length).toBeLessThan(text.length);
    // Within a third of a second.
    expect(framesToShow(text, "", false)).toBeLessThanOrEqual(20);
  });

  it("shows what is there and no more", () => {
    expect(nextShown("abc", "abc", true, FRAME)).toBe("abc");
    expect(nextShown("abc", "ab", false, FRAME)).toBe("abc");
  });

  it("never splits an emoji", () => {
    const text = "a😀b";
    // One letter after "a" would end between the emoji's two halves.
    expect(nextShown(text, "a", true, 1)).toBe("a😀");
  });
});
