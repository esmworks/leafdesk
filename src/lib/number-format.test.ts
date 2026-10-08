import { describe, expect, it } from "vitest";
import {
  calculationFormat,
  checkNumberFormat,
  fromPercentPoints,
  numberFormatOptions,
  numberText,
  parseTypedNumber,
  readNumber,
  stripNumberDecor,
  toPercentPoints,
} from "./number-format";

const show = (locale: string, value: number, ...args: Parameters<typeof numberFormatOptions>) =>
  new Intl.NumberFormat(locale, numberFormatOptions(...args)).format(value);

describe("checkNumberFormat", () => {
  it("keeps percent and currency formats", () => {
    expect(checkNumberFormat({ format: "percent" })).toEqual({ ok: true, format: { format: "percent" } });
    expect(checkNumberFormat({ format: "currency", currency: "try", decimals: 2 })).toEqual({
      ok: true,
      format: { format: "currency", currency: "TRY", decimals: 2 },
    });
  });

  it("stores nothing for plain numbers", () => {
    expect(checkNumberFormat(null)).toEqual({ ok: true, format: null });
    expect(checkNumberFormat({ format: "number" })).toEqual({ ok: true, format: null });
    expect(checkNumberFormat({ format: "number", decimals: 0 })).toEqual({ ok: true, format: { format: "number", decimals: 0 } });
    expect(checkNumberFormat({ format: "percent", decimals: null })).toEqual({ ok: true, format: { format: "percent" } });
  });

  it("refuses unknown formats, currencies and decimals", () => {
    expect(checkNumberFormat({ format: "money" }).ok).toBe(false);
    expect(checkNumberFormat("percent").ok).toBe(false);
    expect(checkNumberFormat({ format: "currency" }).ok).toBe(false);
    expect(checkNumberFormat({ format: "currency", currency: "XYZ" }).ok).toBe(false);
    expect(checkNumberFormat({ format: "currency", currency: "EURO" }).ok).toBe(false);
    expect(checkNumberFormat({ format: "percent", currency: "EUR" }).ok).toBe(false);
    expect(checkNumberFormat({ format: "number", decimals: 9 }).ok).toBe(false);
    expect(checkNumberFormat({ format: "number", decimals: 1.5 }).ok).toBe(false);
    expect(checkNumberFormat({ format: "number", decimals: -1 }).ok).toBe(false);
  });
});

describe("numberFormatOptions", () => {
  it("shows plain numbers as before", () => {
    expect(show("en", 1234.5678, undefined)).toBe("1,234.5678");
    expect(show("tr", 1234.5, null)).toBe("1.234,5");
    expect(show("en", 1234.5678, { format: "number", decimals: 1 })).toBe("1,234.6");
  });

  it("shows money in the viewer's locale", () => {
    expect(show("tr", 1234.56, { format: "currency", currency: "TRY" })).toBe("₺1.234,56");
    expect(show("en", 1234.5, { format: "currency", currency: "USD" })).toBe("$1,234.50");
    expect(show("en", 1234.56, { format: "currency", currency: "USD", decimals: 0 })).toBe("$1,235");
    expect(show("en", 1234.5, { format: "currency", currency: "JPY" })).toBe("¥1,235");
    expect(show("de", 3, { format: "currency", currency: "EUR", decimals: 2 })).toBe("3,00\u00a0€");
  });

  it("shows fractions as percentages without rounding them away", () => {
    expect(show("en", 0.15, { format: "percent" })).toBe("15%");
    expect(show("en", 0.155, { format: "percent" })).toBe("15.5%");
    expect(show("tr", 0.155, { format: "percent", decimals: 0 })).toBe("%16");
    expect(show("en", 0.5, { format: "percent", decimals: 2 })).toBe("50.00%");
  });

  it("uses fewer digits when asked (averages)", () => {
    expect(show("en", 1 / 3, undefined, 2)).toBe("0.33");
    expect(show("en", 1 / 3, { format: "percent" }, 2)).toBe("33.33%");
  });
});

describe("percent points", () => {
  it("converts without binary noise", () => {
    expect(toPercentPoints(0.07)).toBe(7);
    expect(toPercentPoints(0.155)).toBe(15.5);
    expect(fromPercentPoints(14.3)).toBe(0.143);
    expect(fromPercentPoints(15)).toBe(0.15);
  });
});

describe("calculationFormat", () => {
  const options = { number: { format: "currency" as const, currency: "TRY" } };
  it("formats calculations in the values' unit, not counts", () => {
    expect(calculationFormat("sum", options)).toEqual(options.number);
    expect(calculationFormat("range", options)).toEqual(options.number);
    expect(calculationFormat("count_values", options)).toBeUndefined();
    expect(calculationFormat("percent_empty", options)).toBeUndefined();
    expect(calculationFormat("sum", {})).toBeUndefined();
  });
});

describe("stripNumberDecor", () => {
  it("drops percent signs and currency symbols", () => {
    expect(stripNumberDecor("15%")).toEqual({ text: "15", percent: true });
    expect(stripNumberDecor("%15,5")).toEqual({ text: "15,5", percent: true });
    expect(stripNumberDecor("15 %")).toEqual({ text: "15", percent: true });
    expect(stripNumberDecor("₺1.234,50")).toEqual({ text: "1.234,50", percent: false });
    expect(stripNumberDecor("-$12")).toEqual({ text: "-12", percent: false });
    expect(stripNumberDecor("3,00 €")).toEqual({ text: "3,00", percent: false });
  });

  it("drops the property's currency code, and nothing else", () => {
    expect(stripNumberDecor("1,234.50 EUR", "EUR").text).toBe("1,234.50");
    expect(stripNumberDecor("usd 12", "USD").text).toBe("12");
    expect(stripNumberDecor("100 TL", "TRY").text).toBe("100");
    expect(stripNumberDecor("12 abc", "USD").text).toBe("12 abc");
    expect(stripNumberDecor("12 EUR").text).toBe("12 EUR");
  });
});

describe("typed numbers", () => {
  const percent = { format: "percent" as const };
  const lira = { format: "currency" as const, currency: "TRY" };

  it("reads both decimal styles, and the locale's grouping", () => {
    expect(parseTypedNumber("1234,5")).toBe(1234.5);
    expect(parseTypedNumber("1.000", "tr")).toBe(1000);
    expect(parseTypedNumber("1.000", "en")).toBe(1);
    expect(parseTypedNumber("1,234.5")).toBe(1234.5);
    expect(parseTypedNumber("")).toBeUndefined();
  });

  it("reads a percent property in percent points", () => {
    expect(readNumber("15", percent, "en")).toBe(0.15);
    expect(readNumber("15%", percent, "en")).toBe(0.15);
    expect(readNumber("%12,5", percent, "tr")).toBe(0.125);
    expect(readNumber("abc", percent, "en")).toBeUndefined();
  });

  it("reads a percent sign in a plain number as a percentage", () => {
    expect(readNumber("15%", undefined, "en")).toBe(0.15);
    expect(readNumber("15", undefined, "en")).toBe(15);
  });

  it("reads amounts with their symbol or code", () => {
    expect(readNumber("₺1.234,56", lira, "tr")).toBe(1234.56);
    expect(readNumber("1.234,56 TL", lira, "tr")).toBe(1234.56);
    expect(readNumber("250 try", lira, "en")).toBe(250);
    expect(readNumber("250 usd", lira, "en")).toBeUndefined();
  });

  it("shows what it reads back", () => {
    expect(numberText(0.07, "en", percent)).toBe("7");
    expect(numberText(0.125, "tr", percent)).toBe("12,5");
    expect(numberText(1234.5, "tr", lira)).toBe("1234,5");
    expect(readNumber(numberText(0.155, "de", percent), percent, "de")).toBe(0.155);
  });
});
