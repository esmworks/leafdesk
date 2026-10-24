import { describe, expect, it } from "vitest";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/lib/views";
import { fittedWidth } from "./fit-column";

describe("fittedWidth", () => {
  it("takes the widest cell, rounded up", () => {
    expect(fittedWidth([80, 212.3, 150])).toBe(213);
  });

  it("stays within the limits a view keeps", () => {
    expect(fittedWidth([12])).toBe(MIN_COLUMN_WIDTH);
    expect(fittedWidth([])).toBe(MIN_COLUMN_WIDTH);
    expect(fittedWidth([5000])).toBe(MAX_COLUMN_WIDTH);
  });
});
