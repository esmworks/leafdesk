import { describe, expect, it } from "vitest";
import { dropSide } from "./columns";

describe("dropSide", () => {
  const rect = { left: 100, width: 700 };

  it("is before near the left side and after near the right, nothing between", () => {
    expect(dropSide(rect, 120, false)).toBe("before");
    expect(dropSide(rect, 60, false)).toBe("before");
    expect(dropSide(rect, 780, false)).toBe("after");
    expect(dropSide(rect, 450, false)).toBeNull();
  });

  it("swaps the sides right to left", () => {
    expect(dropSide(rect, 120, true)).toBe("after");
    expect(dropSide(rect, 780, true)).toBe("before");
  });

  it("keeps the zones between 24 and 96 pixels", () => {
    expect(dropSide({ left: 0, width: 2000 }, 97, false)).toBeNull();
    expect(dropSide({ left: 0, width: 2000 }, 95, false)).toBe("before");
    expect(dropSide({ left: 0, width: 100 }, 23, false)).toBe("before");
    expect(dropSide({ left: 0, width: 100 }, 30, false)).toBeNull();
  });
});
