import { describe, expect, it } from "vitest";
import { byRecency } from "./chat-recency";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

describe("byRecency", () => {
  const now = new Date(2026, 9, 26, 9, 30);

  it("groups by the reader's calendar days, keeping the order", () => {
    const items = [
      { id: "a", updatedAt: at(2026, 10, 26, 0) },
      { id: "b", updatedAt: at(2026, 10, 25, 23) },
      { id: "c", updatedAt: at(2026, 10, 25, 1) },
      { id: "d", updatedAt: at(2026, 10, 19) },
      { id: "e", updatedAt: at(2026, 10, 18) },
      { id: "f", updatedAt: at(2026, 9, 26) },
      { id: "g", updatedAt: at(2026, 9, 25) },
    ];
    expect(byRecency(items, now).map((g) => [g.recency, g.items.map((i) => i.id).join("")])).toEqual([
      ["today", "a"],
      ["yesterday", "bc"],
      ["week", "d"],
      ["month", "ef"],
      ["older", "g"],
    ]);
  });

  it("leaves out empty runs and counts a later time today as today", () => {
    expect(byRecency([{ updatedAt: at(2026, 10, 26, 23) }, { updatedAt: at(2025, 1, 1) }], now).map((g) => g.recency)).toEqual(["today", "older"]);
    expect(byRecency([], now)).toEqual([]);
  });
});
