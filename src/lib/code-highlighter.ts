import { createBundledHighlighter } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { highlightLanguage } from "./code-languages";

/**
 * Colors code in the languages of lib/code-languages, for the editor (BlockNote's syntax
 * highlighting extension, components/page/code-block.tsx) and for published pages
 * (server/published-body.ts). Each language's grammar is loaded the first time a block needs it.
 *
 * Every token carries a light and a dark color as CSS variables (`--shiki-light`, `--shiki-dark`);
 * the stylesheet picks the one that suits the background behind the code.
 */

export const LIGHT_THEME = "github-light";
export const DARK_THEME = "github-dark";

const createHighlighter = createBundledHighlighter({
  langs: {
    bash: () => import("@shikijs/langs-precompiled/shellscript"),
    c: () => import("@shikijs/langs-precompiled/c"),
    cpp: () => import("@shikijs/langs-precompiled/cpp"),
    csharp: () => import("@shikijs/langs-precompiled/csharp"),
    css: () => import("@shikijs/langs-precompiled/css"),
    dart: () => import("@shikijs/langs-precompiled/dart"),
    diff: () => import("@shikijs/langs-precompiled/diff"),
    dockerfile: () => import("@shikijs/langs-precompiled/dockerfile"),
    elixir: () => import("@shikijs/langs-precompiled/elixir"),
    go: () => import("@shikijs/langs-precompiled/go"),
    graphql: () => import("@shikijs/langs-precompiled/graphql"),
    html: () => import("@shikijs/langs-precompiled/html"),
    ini: () => import("@shikijs/langs-precompiled/ini"),
    java: () => import("@shikijs/langs-precompiled/java"),
    javascript: () => import("@shikijs/langs-precompiled/javascript"),
    json: () => import("@shikijs/langs-precompiled/json"),
    jsx: () => import("@shikijs/langs-precompiled/jsx"),
    kotlin: () => import("@shikijs/langs-precompiled/kotlin"),
    latex: () => import("@shikijs/langs-precompiled/latex"),
    lua: () => import("@shikijs/langs-precompiled/lua"),
    makefile: () => import("@shikijs/langs-precompiled/make"),
    markdown: () => import("@shikijs/langs-precompiled/markdown"),
    nginx: () => import("@shikijs/langs-precompiled/nginx"),
    "objective-c": () => import("@shikijs/langs-precompiled/objective-c"),
    php: () => import("@shikijs/langs-precompiled/php"),
    powershell: () => import("@shikijs/langs-precompiled/powershell"),
    protobuf: () => import("@shikijs/langs-precompiled/proto"),
    python: () => import("@shikijs/langs-precompiled/python"),
    r: () => import("@shikijs/langs-precompiled/r"),
    ruby: () => import("@shikijs/langs-precompiled/ruby"),
    rust: () => import("@shikijs/langs-precompiled/rust"),
    scala: () => import("@shikijs/langs-precompiled/scala"),
    scss: () => import("@shikijs/langs-precompiled/scss"),
    sql: () => import("@shikijs/langs-precompiled/sql"),
    swift: () => import("@shikijs/langs-precompiled/swift"),
    terraform: () => import("@shikijs/langs-precompiled/terraform"),
    toml: () => import("@shikijs/langs-precompiled/toml"),
    typescript: () => import("@shikijs/langs-precompiled/typescript"),
    tsx: () => import("@shikijs/langs-precompiled/tsx"),
    vue: () => import("@shikijs/langs-precompiled/vue"),
    xml: () => import("@shikijs/langs-precompiled/xml"),
    yaml: () => import("@shikijs/langs-precompiled/yaml"),
  },
  themes: {
    [LIGHT_THEME]: () => import("@shikijs/themes/github-light"),
    [DARK_THEME]: () => import("@shikijs/themes/github-dark"),
  },
  engine: () => createJavaScriptRegexEngine(),
});

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;
type HighlighterLanguage = Exclude<Parameters<Highlighter["loadLanguage"]>[0], object>;

let highlighter: Promise<Highlighter> | null = null;

/** The one highlighter of this page or server process, with both themes and no languages yet. */
export function codeHighlighter(): Promise<Highlighter> {
  const created = (highlighter ??= createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [] }).catch((error) => {
    highlighter = null;
    throw error;
  }));
  return created;
}

/** A run of code of one color; `light` and `dark` are null where the text has the default color. */
export type CodeToken = { text: string; light: string | null; dark: string | null };

/** Longer code is shown uncolored: coloring it would hold up every read of a published page. */
export const MAX_HIGHLIGHT_LENGTH = 100_000;

/**
 * `code` split into lines of colored tokens, or null when its language isn't one we color (plain
 * text, or a name we don't know), it is longer than MAX_HIGHLIGHT_LENGTH or its grammar can't be
 * loaded.
 */
export async function highlightCode(code: string, language: unknown): Promise<CodeToken[][] | null> {
  const id = highlightLanguage(language) as HighlighterLanguage | null;
  if (!id || code.length > MAX_HIGHLIGHT_LENGTH) return null;
  try {
    const shiki = await codeHighlighter();
    if (!shiki.getLoadedLanguages().includes(id)) await shiki.loadLanguage(id);
    const { tokens } = shiki.codeToTokens(code, { lang: id, themes: { light: LIGHT_THEME, dark: DARK_THEME }, defaultColor: false });
    return tokens.map((line) =>
      line.map((token) => ({
        text: token.content,
        light: token.htmlStyle?.["--shiki-light"] ?? null,
        dark: token.htmlStyle?.["--shiki-dark"] ?? null,
      })),
    );
  } catch {
    return null;
  }
}
