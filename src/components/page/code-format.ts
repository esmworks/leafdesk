import type { Plugin } from "prettier";
import type { CodeFormatter, FormatPlugin } from "@/lib/code-format";
import { formattedBlockText } from "@/lib/code-format";

/**
 * Formats code with Prettier's standalone build, loading it and the plugins the language needs the
 * first time they are used (each its own chunk). Throws the formatter's error, a syntax error with
 * its line, when the code can't be formatted.
 */

const PLUGINS: Record<FormatPlugin, () => Promise<Plugin>> = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree") as Promise<Plugin>,
  typescript: () => import("prettier/plugins/typescript"),
  postcss: () => import("prettier/plugins/postcss"),
  html: () => import("prettier/plugins/html"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
  graphql: () => import("prettier/plugins/graphql"),
};

export async function formatCode(code: string, formatter: CodeFormatter): Promise<string> {
  const [prettier, ...plugins] = await Promise.all([import("prettier/standalone"), ...formatter.plugins.map((name) => PLUGINS[name]())]);
  const output = await prettier.format(code, { parser: formatter.parser, plugins });
  return formattedBlockText(output);
}
