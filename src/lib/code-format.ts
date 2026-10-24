/**
 * "Format code" in a code block's menu (components/page/code-format-item.tsx): which of Prettier's
 * parsers formats a language of the block (lib/code-languages), and the plugins that parser needs.
 * The formatter and its plugins load only when someone formats (components/page/code-format.ts).
 */

import { codeLanguage } from "./code-languages";

/** Prettier's plugins the app loads, each on its own when first needed. */
export type FormatPlugin = "babel" | "estree" | "typescript" | "postcss" | "html" | "markdown" | "yaml" | "graphql";

export type CodeFormatter = { parser: string; plugins: FormatPlugin[] };

const FORMATTERS: Record<string, CodeFormatter> = {
  javascript: { parser: "babel", plugins: ["babel", "estree"] },
  jsx: { parser: "babel", plugins: ["babel", "estree"] },
  typescript: { parser: "typescript", plugins: ["typescript", "estree"] },
  tsx: { parser: "typescript", plugins: ["typescript", "estree"] },
  json: { parser: "json", plugins: ["babel", "estree"] },
  css: { parser: "css", plugins: ["postcss"] },
  scss: { parser: "scss", plugins: ["postcss"] },
  html: { parser: "html", plugins: ["html"] },
  vue: { parser: "vue", plugins: ["html"] },
  markdown: { parser: "markdown", plugins: ["markdown"] },
  yaml: { parser: "yaml", plugins: ["yaml"] },
  graphql: { parser: "graphql", plugins: ["graphql"] },
};

/** How to format a block of `language` (its id or a name it stands for), or null when it can't be. */
export function codeFormatter(language: unknown): CodeFormatter | null {
  const id = codeLanguage(language);
  return (id && FORMATTERS[id]) || null;
}

/**
 * The formatted code as the block holds it: without the line break the formatter ends with, since
 * a block's last line has none.
 */
export function formattedBlockText(output: string): string {
  return output.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** The line of a formatter's syntax error, when it says (Prettier's errors carry `loc.start.line`). */
export function syntaxErrorLine(error: unknown): number | null {
  const line = (error as { loc?: { start?: { line?: unknown } } } | null)?.loc?.start?.line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}
