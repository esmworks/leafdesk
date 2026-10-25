import { describe, expect, it } from "vitest";
import { isStraightQuote, smartQuote } from "./smart-quotes";

describe("smartQuote", () => {
  it("opens at the start of a line and after spaces, brackets, dashes and opening quotes", () => {
    expect(smartQuote("", '"')).toBe("“");
    expect(smartQuote("He said ", '"')).toBe("“");
    expect(smartQuote("(", "'")).toBe("‘");
    expect(smartQuote("word—", '"')).toBe("“");
    expect(smartQuote("“", "'")).toBe("‘");
  });

  it("closes after words and punctuation, so contractions get an apostrophe", () => {
    expect(smartQuote("“Hello", '"')).toBe("”");
    expect(smartQuote("don", "'")).toBe("’");
    expect(smartQuote("end.", '"')).toBe("”");
    expect(smartQuote("‘ok’", '"')).toBe("”");
  });

  it("only takes the two straight quotes", () => {
    expect(isStraightQuote('"')).toBe(true);
    expect(isStraightQuote("'")).toBe(true);
    expect(isStraightQuote("`")).toBe(false);
    expect(isStraightQuote("''")).toBe(false);
  });
});
