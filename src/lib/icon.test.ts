import { describe, expect, it } from "vitest";
import { parseIcon } from "./icon";

describe("parseIcon", () => {
  it("takes an emoji, joined ones and flags included", () => {
    expect(parseIcon("📄")).toBe("📄");
    expect(parseIcon(" 🧑‍💻 ")).toBe("🧑‍💻");
    expect(parseIcon("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(parseIcon("🇹🇷")).toBe("🇹🇷");
  });

  it("refuses what isn't one", () => {
    expect(parseIcon("")).toBeNull();
    expect(parseIcon("   ")).toBeNull();
    expect(parseIcon("a".repeat(9))).toBeNull();
    expect(parseIcon("x".repeat(10_000))).toBeNull();
    expect(parseIcon(42)).toBeNull();
    expect(parseIcon(null)).toBeNull();
  });
});
