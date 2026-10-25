import { describe, expect, it } from "vitest";
import { highlightCode } from "./code-highlighter";

/** The light color of the token holding `text` on line `line`. */
async function colorOf(code: string, language: string, text: string) {
  const lines = await highlightCode(code, language);
  expect(lines, language).not.toBeNull();
  const token = lines!.flat().find((t) => t.text.includes(text));
  expect(token, `${language}: ${text}`).toBeDefined();
  return token!.light;
}

describe("the grammars written here", () => {
  it.each([
    ["agda", "-- a comment\ndata Nat : Set where\n  zero : Nat", "-- a comment", "data"],
    ["idris", "||| docs\ntotal\nplus : Nat -> Nat -> Nat", "||| docs", "total"],
    ["dhall", "-- a comment\nlet x = 1 in x", "-- a comment", "let"],
    ["ebnf", "(* a comment *)\ndigit = \"0\" | \"1\" ;", "(* a comment *)", "digit"],
  ])("color %s: comments and keywords differ from plain text", async (language, code, comment, keyword) => {
    const plain = await colorOf("x", language, "x");
    const commentColor = await colorOf(code, language, comment);
    const keywordColor = await colorOf(code, language, keyword);
    expect(commentColor).not.toBe(plain);
    expect(keywordColor).not.toBe(plain);
    expect(commentColor).not.toBe(keywordColor);
  });

  it("nests block comments", async () => {
    const lines = await highlightCode("{- a {- b -} c -} x", "agda");
    const text = lines!.flat();
    const c = text.find((t) => t.text.includes(" c "));
    const x = text.find((t) => t.text.includes("x"));
    expect(c?.light).not.toBe(x?.light);
  });
});
