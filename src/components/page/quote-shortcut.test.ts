import { describe, expect, it } from "vitest";
import { startsQuote } from "./quote-shortcut";

describe("startsQuote", () => {
  it("takes a bar or a quote mark, straight or curled, followed by a space", () => {
    for (const mark of ["|", '"', "“"]) expect(startsQuote(mark, " "), mark).toBe(true);
  });

  it("leaves anything else alone", () => {
    expect(startsQuote("|", "a")).toBe(false);
    expect(startsQuote('"Hello', " ")).toBe(false);
    expect(startsQuote("", " ")).toBe(false);
    expect(startsQuote("||", " ")).toBe(false);
    expect(startsQuote("”", " ")).toBe(false);
  });
});
