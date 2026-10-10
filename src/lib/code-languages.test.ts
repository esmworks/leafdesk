import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, codeLanguage, highlightLanguage, PLAIN_TEXT } from "./code-languages";
import { highlightCode, MAX_HIGHLIGHT_LENGTH } from "./code-highlighter";

describe("code block languages", () => {
  it("reads ids and the other names Markdown and older blocks use", () => {
    expect(codeLanguage("python")).toBe("python");
    expect(codeLanguage(" PY ")).toBe("python");
    expect(codeLanguage("sh")).toBe("bash");
    expect(codeLanguage("Plain Text")).toBe(PLAIN_TEXT);
    expect(codeLanguage("c++")).toBe("cpp");
    expect(codeLanguage("brainfuck")).toBeNull();
    expect(codeLanguage(undefined)).toBeNull();
  });

  it("colors every language but plain text", () => {
    expect(highlightLanguage("text")).toBeNull();
    expect(highlightLanguage("txt")).toBeNull();
    expect(highlightLanguage("golang")).toBe("go");
    expect(highlightLanguage("")).toBeNull();
  });

  it("gives no name to two languages", () => {
    const names = Object.entries(CODE_LANGUAGES).flatMap(([id, { aliases }]) => [id, ...(aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("loads a grammar for every language it lists", async () => {
    for (const id of Object.keys(CODE_LANGUAGES)) {
      if (id === PLAIN_TEXT) continue;
      const lines = await highlightCode("x = 1", id);
      expect(lines, id).not.toBeNull();
      expect(lines!.flat().map((token) => token.text).join("")).toBe("x = 1");
    }
  }, 30_000);

  it("leaves plain text, unknown languages and very long code uncolored", async () => {
    expect(await highlightCode("x", "text")).toBeNull();
    expect(await highlightCode("x", "brainfuck")).toBeNull();
    expect(await highlightCode("x".repeat(MAX_HIGHLIGHT_LENGTH + 1), "js")).toBeNull();
  });
});
