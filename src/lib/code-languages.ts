/**
 * The languages a code block can be set to. A block stores the id (`props.language`); the names
 * after it are what Markdown fences and older blocks may hold instead (```sh, ```py, "Plain Text"),
 * read as that language. Anything else is kept as written and shown without colors.
 *
 * Shared by the editor's language menu (components/page/code-block.tsx) and by the highlighter
 * (lib/code-highlighter.ts), which colors the same languages on screen and on published pages.
 */

export const PLAIN_TEXT = "text";

export const CODE_LANGUAGES: Record<string, { name: string; aliases?: string[] }> = {
  [PLAIN_TEXT]: { name: "Plain text", aliases: ["txt", "plain", "plaintext", "plain text", "none"] },
  bash: { name: "Bash", aliases: ["sh", "shell", "shellscript", "zsh", "console"] },
  c: { name: "C", aliases: ["h"] },
  cpp: { name: "C++", aliases: ["c++", "cc", "hpp"] },
  csharp: { name: "C#", aliases: ["c#", "cs"] },
  css: { name: "CSS" },
  dart: { name: "Dart" },
  diff: { name: "Diff", aliases: ["patch"] },
  dockerfile: { name: "Dockerfile", aliases: ["docker"] },
  elixir: { name: "Elixir", aliases: ["ex", "exs"] },
  go: { name: "Go", aliases: ["golang"] },
  graphql: { name: "GraphQL", aliases: ["gql"] },
  html: { name: "HTML", aliases: ["htm"] },
  ini: { name: "INI", aliases: ["properties", "cfg"] },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js", "mjs", "cjs"] },
  json: { name: "JSON" },
  jsx: { name: "JSX" },
  kotlin: { name: "Kotlin", aliases: ["kt", "kts"] },
  latex: { name: "LaTeX", aliases: ["tex"] },
  lua: { name: "Lua" },
  makefile: { name: "Makefile", aliases: ["make", "mk"] },
  markdown: { name: "Markdown", aliases: ["md"] },
  nginx: { name: "Nginx" },
  "objective-c": { name: "Objective-C", aliases: ["objc", "objectivec"] },
  php: { name: "PHP" },
  powershell: { name: "PowerShell", aliases: ["ps", "ps1", "pwsh"] },
  protobuf: { name: "Protocol Buffers", aliases: ["proto"] },
  python: { name: "Python", aliases: ["py"] },
  r: { name: "R" },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  scala: { name: "Scala" },
  scss: { name: "SCSS", aliases: ["sass"] },
  sql: { name: "SQL", aliases: ["postgresql", "postgres", "mysql", "sqlite"] },
  swift: { name: "Swift" },
  terraform: { name: "Terraform", aliases: ["hcl", "tf"] },
  toml: { name: "TOML" },
  typescript: { name: "TypeScript", aliases: ["ts", "mts", "cts"] },
  tsx: { name: "TSX" },
  vue: { name: "Vue" },
  xml: { name: "XML", aliases: ["svg", "xsl", "plist"] },
  yaml: { name: "YAML", aliases: ["yml"] },
};

const byName = new Map<string, string>();
for (const [id, { aliases }] of Object.entries(CODE_LANGUAGES)) {
  byName.set(id, id);
  for (const alias of aliases ?? []) byName.set(alias, id);
}

/** The language id a block's `language` stands for, or null when it isn't one of ours. */
export function codeLanguage(language: unknown): string | null {
  if (typeof language !== "string") return null;
  return byName.get(language.trim().toLowerCase()) ?? null;
}

/** The language to color a block's code as: null for plain text and languages we don't know. */
export function highlightLanguage(language: unknown): string | null {
  const id = codeLanguage(language);
  return id && id !== PLAIN_TEXT ? id : null;
}
