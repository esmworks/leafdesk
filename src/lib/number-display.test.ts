import { describe, expect, it } from "vitest";
import { checkNumberDisplay, defaultDivideBy, numberShare } from "./number-display";

describe("number display", () => {
  it("stores bars and rings with their color and divisor, and nothing for plain numbers", () => {
    expect(checkNumberDisplay(null)).toEqual({ ok: true, display: null });
    expect(checkNumberDisplay({ display: "number", color: "red" })).toEqual({ ok: true, display: null });
    expect(checkNumberDisplay({ display: "bar" })).toEqual({ ok: true, display: { display: "bar" } });
    expect(checkNumberDisplay({ display: "ring", color: "green", divideBy: 10 })).toEqual({
      ok: true,
      display: { display: "ring", color: "green", divideBy: 10 },
    });
    expect(checkNumberDisplay({ display: "bar", color: null, divideBy: null })).toEqual({ ok: true, display: { display: "bar" } });
  });

  it("refuses unknown displays and colors and divisors that aren't above 0", () => {
    expect(checkNumberDisplay("bar").ok).toBe(false);
    expect(checkNumberDisplay({ display: "pie" }).ok).toBe(false);
    expect(checkNumberDisplay({ display: "bar", color: "teal" }).ok).toBe(false);
    expect(checkNumberDisplay({ display: "bar", divideBy: 0 }).ok).toBe(false);
    expect(checkNumberDisplay({ display: "bar", divideBy: -5 }).ok).toBe(false);
    expect(checkNumberDisplay({ display: "bar", divideBy: Infinity }).ok).toBe(false);
    expect(checkNumberDisplay({ display: "bar", divideBy: "10" }).ok).toBe(false);
  });

  it("fills by the value over the divisor, from empty to full", () => {
    expect(numberShare(42, { display: "bar" })).toBe(0.42);
    expect(numberShare(5, { display: "bar", divideBy: 10 })).toBe(0.5);
    expect(numberShare(150, { display: "bar" })).toBe(1);
    expect(numberShare(-3, { display: "ring" })).toBe(0);
    expect(numberShare(NaN, { display: "ring" })).toBe(0);
  });

  it("takes 100 % as full for a percent property", () => {
    expect(defaultDivideBy({ format: "percent" })).toBe(1);
    expect(defaultDivideBy({ format: "currency", currency: "EUR" })).toBe(100);
    expect(defaultDivideBy(undefined)).toBe(100);
    expect(numberShare(0.75, { display: "bar" }, { format: "percent" })).toBe(0.75);
  });
});
