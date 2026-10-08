import { describe, expect, it } from "vitest";
import { isTheme } from "./theme";

describe("isTheme", () => {
  it("accepts the themes someone can choose", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
  });

  it("refuses anything else, so a forged cookie can't reach <html>", () => {
    for (const value of ["", "system", "Dark", "dark\" onload=\"x", null, undefined, 1]) {
      expect(isTheme(value)).toBe(false);
    }
  });
});
