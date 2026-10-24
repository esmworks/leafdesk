import { describe, expect, it } from "vitest";
import { BUILTIN_ICON_NAMES } from "./builtin-icon-names";
import { BUILTIN_ICONS } from "./builtin-icons-data";
import { parseIcon } from "./icon";
import { formatBuiltinIcon, iconPrefix, iconText, readBuiltinIcon } from "./icon-value";

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

  it("takes a built-in icon, with or without a color", () => {
    expect(parseIcon("icon:star")).toBe("icon:star");
    expect(parseIcon(" icon:circle-dollar-sign:purple ")).toBe("icon:circle-dollar-sign:purple");
  });

  it("refuses a built-in icon there isn't, or a color there isn't", () => {
    expect(parseIcon("icon:no-such-icon")).toBeNull();
    expect(parseIcon("icon:star:teal")).toBeNull();
    expect(parseIcon("icon:star:blue:extra")).toBeNull();
    expect(parseIcon("icon:")).toBeNull();
    expect(parseIcon("icon:Star")).toBeNull();
    expect(parseIcon("icon:../star")).toBeNull();
  });
});

describe("built-in icons", () => {
  it("has a drawing for every name, and no drawing without one", () => {
    for (const name of BUILTIN_ICON_NAMES) expect(BUILTIN_ICONS[name]?.length, name).toBeGreaterThan(0);
    expect(Object.keys(BUILTIN_ICONS).sort()).toEqual([...BUILTIN_ICON_NAMES].sort());
    expect(new Set(BUILTIN_ICON_NAMES).size).toBe(BUILTIN_ICON_NAMES.length);
  });

  it("reads and writes the stored form", () => {
    expect(readBuiltinIcon("icon:star:blue")).toEqual({ name: "star", color: "blue" });
    expect(readBuiltinIcon("icon:star")).toEqual({ name: "star", color: null });
    expect(readBuiltinIcon("⭐")).toBeNull();
    expect(readBuiltinIcon(null)).toBeNull();
    expect(formatBuiltinIcon("star", "blue")).toBe("icon:star:blue");
    expect(formatBuiltinIcon("star", null)).toBe("icon:star");
  });

  it("shows as nothing where only text can show", () => {
    expect(iconText("icon:star:blue")).toBe("");
    expect(iconText("⭐")).toBe("⭐");
    expect(iconText(null)).toBe("");
    expect(iconPrefix("icon:star")).toBe("");
    expect(iconPrefix("⭐")).toBe("⭐ ");
    expect(iconPrefix(null)).toBe("");
  });
});
