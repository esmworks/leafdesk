import { describe, expect, it } from "vitest";
import { highlightParts } from "./search-highlight";

const marked = (text: string, words: string[]) =>
  highlightParts(text, words)
    .filter((p) => p.match)
    .map((p) => p.text);

describe("highlightParts", () => {
  it("marks the words where they start a word, whatever their case or i", () => {
    expect(marked("Kondenser planı ve ikonda bir not", ["kond", "PLAN"])).toEqual(["Kond", "plan"]);
    expect(marked("İstanbul ofisi, Isparta deposu", ["istanbul", "ısparta"])).toEqual(["İstanbul", "Isparta"]);
  });

  it("marks inside words when asked to", () => {
    expect(highlightParts("Fiyat listesi", ["yat"], { anywhere: true }).filter((p) => p.match).map((p) => p.text)).toEqual(["yat"]);
    expect(marked("Fiyat listesi", ["yat"])).toEqual([]);
  });

  it("marks Chinese and Japanese inside a sentence", () => {
    expect(marked("明日の会議について", ["会議"])).toEqual(["会議"]);
  });

  it("keeps the text whole, and reads words with pattern characters as written", () => {
    const parts = highlightParts("Price (USD) is 3.5", ["(usd)", "3.5"]);
    expect(parts.map((p) => p.text).join("")).toBe("Price (USD) is 3.5");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["(USD)", "3.5"]);
    expect(highlightParts("no words", [])).toEqual([{ text: "no words", match: false }]);
  });
});
