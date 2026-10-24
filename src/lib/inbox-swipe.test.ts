import { describe, expect, it } from "vitest";
import { SWIPE_COMMIT_PX, SWIPE_MAX_PX, swipeActionFor, swipeAxis, swipeOffset, swipeSide } from "./inbox-swipe";

describe("inbox swipes", () => {
  it("tell a swipe from a scroll once the finger has moved far enough", () => {
    expect(swipeAxis(3, 2)).toBeNull();
    expect(swipeAxis(12, 4)).toBe("x");
    expect(swipeAxis(-12, 4)).toBe("x");
    expect(swipeAxis(4, 12)).toBe("y");
  });

  it("mark read toward the line's end and snooze toward its start", () => {
    expect(swipeActionFor(SWIPE_COMMIT_PX, false, true)).toBe("read");
    expect(swipeActionFor(-SWIPE_COMMIT_PX, false, true)).toBe("snooze");
    expect(swipeActionFor(SWIPE_COMMIT_PX - 1, false, true)).toBeNull();
    // Right to left, the line runs the other way.
    expect(swipeActionFor(-SWIPE_COMMIT_PX, true, true)).toBe("read");
    expect(swipeActionFor(SWIPE_COMMIT_PX, true, true)).toBe("snooze");
  });

  it("don't snooze what can't be snoozed", () => {
    expect(swipeActionFor(-200, false, false)).toBeNull();
    expect(swipeSide(-20, false, false)).toBeNull();
    expect(swipeSide(-20, false, true)).toBe("snooze");
    expect(swipeSide(20, true, true)).toBe("snooze");
    expect(swipeSide(0, false, true)).toBeNull();
  });

  it("follow the finger only so far", () => {
    expect(swipeOffset(40, false, true)).toBe(40);
    expect(swipeOffset(400, false, true)).toBe(SWIPE_MAX_PX);
    expect(swipeOffset(-400, false, true)).toBe(-SWIPE_MAX_PX);
    expect(swipeOffset(-400, false, false)).toBe(-16);
    expect(swipeOffset(-40, false, false)).toBe(-10);
    expect(swipeOffset(400, true, false)).toBe(16);
    expect(swipeOffset(-400, true, true)).toBe(-SWIPE_MAX_PX);
  });
});
