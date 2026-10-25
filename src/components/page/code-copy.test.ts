import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/published/published-body.module.css", () => ({ default: {} }));

const { codeText } = await import("./code-copy");

describe("codeText", () => {
  it("joins a code block's text as written, line breaks and indents kept", () => {
    expect(codeText([{ type: "text", text: "if (a) {\n  b();\n}", styles: {} }, { type: "text", text: "\n// end", styles: {} }])).toBe(
      "if (a) {\n  b();\n}\n// end",
    );
  });

  it("is empty for a block without inline content", () => {
    expect(codeText(undefined)).toBe("");
    expect(codeText([{ type: "link", href: "x" }])).toBe("");
  });
});
