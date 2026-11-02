import { describe, expect, it } from "vitest";
import { typedCharacter } from "./cell-typing";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("typedCharacter", () => {
  it("types letters, digits, signs and letters of any alphabet", () => {
    for (const k of ["a", "Z", "7", "-", "=", "ş", "Ğ", "é", "日", "😀"]) expect(typedCharacter(key(k))).toBe(k);
  });

  it("leaves named keys and Space alone", () => {
    for (const k of ["Enter", "ArrowDown", "Tab", "Escape", "Backspace", "Delete", "F2", "Dead", "Process", " "]) {
      expect(typedCharacter(key(k))).toBeNull();
    }
  });

  it("leaves shortcuts alone", () => {
    expect(typedCharacter(key("c", { metaKey: true }))).toBeNull();
    expect(typedCharacter(key("v", { ctrlKey: true }))).toBeNull();
    expect(typedCharacter(key("t", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(typedCharacter(key("f", { altKey: true }))).toBeNull();
  });

  it("types what AltGr and Option make", () => {
    expect(typedCharacter(key("@", { ctrlKey: true, altKey: true }))).toBe("@");
    expect(typedCharacter(key("€", { altKey: true }))).toBe("€");
  });

  it("waits while an input method composes", () => {
    expect(typedCharacter(key("a", { isComposing: true }))).toBeNull();
  });
});
