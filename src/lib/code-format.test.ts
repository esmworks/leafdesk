import { describe, expect, it } from "vitest";
import { codeFormatter, formattedBlockText, syntaxErrorLine } from "./code-format";
import { CODE_LANGUAGES } from "./code-languages";

describe("codeFormatter", () => {
  it("picks Prettier's parser and plugins for the languages it formats, by id or alias", () => {
    expect(codeFormatter("javascript")).toEqual({ parser: "babel", plugins: ["babel", "estree"] });
    expect(codeFormatter("js")).toEqual({ parser: "babel", plugins: ["babel", "estree"] });
    expect(codeFormatter("TSX")).toEqual({ parser: "typescript", plugins: ["typescript", "estree"] });
    expect(codeFormatter("ts")?.parser).toBe("typescript");
    expect(codeFormatter("json")).toEqual({ parser: "json", plugins: ["babel", "estree"] });
    expect(codeFormatter("sass")).toEqual({ parser: "scss", plugins: ["postcss"] });
    expect(codeFormatter("htm")).toEqual({ parser: "html", plugins: ["html"] });
    expect(codeFormatter("vue")?.parser).toBe("vue");
    expect(codeFormatter("md")?.parser).toBe("markdown");
    expect(codeFormatter("yml")?.parser).toBe("yaml");
    expect(codeFormatter("gql")?.parser).toBe("graphql");
  });

  it("has nothing for plain text, languages Prettier doesn't format and unknown ones", () => {
    for (const language of ["text", "python", "sql", "go", "bash", "dockerfile2", "", null, 3]) expect(codeFormatter(language)).toBeNull();
  });

  it("only names languages the block's menu has", () => {
    const formatted = Object.keys(CODE_LANGUAGES).filter((id) => codeFormatter(id));
    expect(formatted.sort()).toEqual(["css", "graphql", "html", "javascript", "json", "jsx", "markdown", "scss", "tsx", "typescript", "vue", "yaml"]);
  });
});

describe("formattedBlockText", () => {
  it("drops the line breaks the formatter ends with and keeps the rest", () => {
    expect(formattedBlockText("const a = 1;\n")).toBe("const a = 1;");
    expect(formattedBlockText("a:\r\n  - b\r\n\r\n")).toBe("a:\n  - b");
    expect(formattedBlockText("x\n\ny")).toBe("x\n\ny");
  });
});

describe("syntaxErrorLine", () => {
  it("reads the line of a syntax error", () => {
    expect(syntaxErrorLine({ name: "SyntaxError", loc: { start: { line: 3, column: 7 } } })).toBe(3);
    expect(syntaxErrorLine(new Error("network"))).toBeNull();
    expect(syntaxErrorLine({ loc: { start: { line: 0 } } })).toBeNull();
    expect(syntaxErrorLine(null)).toBeNull();
  });
});
