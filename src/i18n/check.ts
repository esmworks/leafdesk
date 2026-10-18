import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPluralElement,
  isSelectElement,
  isTagElement,
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";

/**
 * The translation check behind `pnpm i18n:check` and messages.test.ts: every language folder in
 * `src/i18n/messages` must have the source language's files and keys, no others, and messages
 * that use the same placeholders (`{name}`, `{count, plural, …}`, `<b>…</b>`) as the source.
 */

export type Problem =
  | "missing file"
  | "extra file"
  | "unregistered folder"
  | "missing"
  | "extra"
  | "empty"
  | "not text"
  | "syntax"
  | "placeholders"
  | "select options";

export type Issue = {
  locale: string;
  file: string;
  /** Dotted path of the message; empty for file-level problems. */
  key: string;
  problem: Problem;
  detail?: string;
};

/** Files whose texts aren't ICU messages (Markdown, names), so only their keys are compared. */
const PLAIN_TEXT_FILES = new Set(["templates.json", "skillTemplates.json"]);

type Leaf = { key: string; value: unknown };

function flatten(tree: unknown, prefix = ""): Leaf[] {
  if (tree !== null && typeof tree === "object" && !Array.isArray(tree)) {
    return Object.entries(tree).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key));
  }
  return [{ key: prefix, value: tree }];
}

function parseMessage(message: string): MessageFormatElement[] {
  return parse(message, { requiresOtherClause: true });
}

/**
 * Every argument and tag a message uses, with what it takes. Plain `{count}`, `{count, number}`
 * and `{count, plural, …}` all take a number: a language without plural forms (Turkish) writes
 * "{count} satır" where English needs a plural, and another may need one where English doesn't.
 */
function variables(elements: MessageFormatElement[], out = new Map<string, string>()) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.plural:
        // An argument used both plainly and as a plural stays "value".
        if (!out.has(el.value)) out.set(el.value, "value");
        break;
      case TYPE.date:
      case TYPE.time:
        out.set(el.value, "date");
        break;
      case TYPE.select:
        out.set(el.value, "select");
        break;
      case TYPE.tag:
        out.set(`<${el.value}>`, "tag");
        break;
    }
    if (isSelectElement(el) || isPluralElement(el)) {
      for (const option of Object.values(el.options)) variables(option.value, out);
    }
    if (isTagElement(el)) variables(el.children, out);
  }
  return out;
}

function describe(vars: Map<string, string>) {
  return [...vars.keys()].sort().map((name) => (name.startsWith("<") ? name : `{${name}}`)).join(" ") || "none";
}

/** Option keys of every select, by argument name ("{kind, select, page {…} other {…}}" → page, other). */
function selectOptions(elements: MessageFormatElement[], out = new Map<string, string>()) {
  for (const el of elements) {
    if (isSelectElement(el)) out.set(el.value, Object.keys(el.options).sort().join(", "));
    if (isSelectElement(el) || isPluralElement(el)) {
      for (const option of Object.values(el.options)) selectOptions(option.value, out);
    }
    if (isTagElement(el)) selectOptions(el.children, out);
  }
  return out;
}

/** Problems of one translated file against the same file of the source language. */
export function compareFile(source: unknown, target: unknown, { icu = true } = {}): Omit<Issue, "locale" | "file">[] {
  const issues: Omit<Issue, "locale" | "file">[] = [];
  const translated = new Map(flatten(target).map((leaf) => [leaf.key, leaf.value]));
  const sourceKeys = new Set<string>();

  for (const { key, value } of flatten(source)) {
    sourceKeys.add(key);
    if (!translated.has(key)) {
      issues.push({ key, problem: "missing", detail: typeof value === "string" ? value : undefined });
      continue;
    }
    const text = translated.get(key);
    if (typeof value !== "string") continue;
    if (typeof text !== "string") {
      issues.push({ key, problem: "not text", detail: `expected text, found ${JSON.stringify(text)}` });
      continue;
    }
    if (text.trim() === "" && value.trim() !== "") {
      issues.push({ key, problem: "empty", detail: value });
      continue;
    }
    if (!icu) continue;
    let a: MessageFormatElement[];
    let b: MessageFormatElement[];
    try {
      a = parseMessage(value);
    } catch (error) {
      issues.push({ key, problem: "syntax", detail: `source message doesn't parse: ${(error as Error).message}` });
      continue;
    }
    try {
      b = parseMessage(text);
    } catch (error) {
      issues.push({ key, problem: "syntax", detail: `${(error as Error).message} in ${JSON.stringify(text)}` });
      continue;
    }
    const va = variables(a);
    const vb = variables(b);
    const differs = va.size !== vb.size || [...va].some(([name, kind]) => vb.get(name) !== kind);
    if (differs) {
      issues.push({ key, problem: "placeholders", detail: `expected ${describe(va)}, found ${describe(vb)} in ${JSON.stringify(text)}` });
      continue;
    }
    const wanted = selectOptions(a);
    const found = selectOptions(b);
    for (const [name, options] of wanted) {
      if (found.get(name) !== options) {
        issues.push({ key, problem: "select options", detail: `{${name}} needs the options ${options}, found ${found.get(name)}` });
      }
    }
  }

  // Leaves under a key the source has as text (e.g. `{ "a": { "b": "…" } }` for `"a": "…"`) are reported there.
  for (const key of translated.keys()) {
    if (!sourceKeys.has(key) && ![...sourceKeys].some((k) => key.startsWith(`${k}.`))) issues.push({ key, problem: "extra" });
  }
  return issues;
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * Checks every language folder under `dir` against `sourceLocale`. `locales` are the registered
 * languages (config.ts): a folder that isn't one, or one without a folder, is reported too.
 */
export function checkTranslations(dir: string, locales: readonly string[], sourceLocale: string, only?: string[]): Issue[] {
  const issues: Issue[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const folder of folders) {
    if (!locales.includes(folder)) {
      issues.push({ locale: folder, file: "", key: "", problem: "unregistered folder", detail: "add it to LOCALE_NAMES in src/i18n/config.ts" });
    }
  }

  const sourceDir = join(dir, sourceLocale);
  const sourceFiles = jsonFiles(sourceDir);
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

  for (const locale of locales) {
    if (locale === sourceLocale || (only && !only.includes(locale))) continue;
    const localeDir = join(dir, locale);
    const files = existsSync(localeDir) ? jsonFiles(localeDir) : [];
    for (const file of sourceFiles) {
      if (!files.includes(file)) {
        issues.push({ locale, file, key: "", problem: "missing file", detail: `copy ${sourceLocale}/${file} and translate it` });
        continue;
      }
      let target: unknown;
      try {
        target = read(join(localeDir, file));
      } catch (error) {
        issues.push({ locale, file, key: "", problem: "syntax", detail: `not valid JSON: ${(error as Error).message}` });
        continue;
      }
      const found = compareFile(read(join(sourceDir, file)), target, { icu: !PLAIN_TEXT_FILES.has(file) });
      issues.push(...found.map((issue) => ({ locale, file, ...issue })));
    }
    for (const file of files) {
      if (!sourceFiles.includes(file)) issues.push({ locale, file, key: "", problem: "extra file" });
    }
  }
  return issues;
}

/** A readable report, grouped by language and file. */
export function formatIssues(issues: Issue[]): string {
  const lines: string[] = [];
  let group = "";
  for (const issue of issues) {
    const heading = issue.file ? `${issue.locale}/${issue.file}` : issue.locale;
    if (heading !== group) {
      lines.push(`${lines.length ? "\n" : ""}${heading}`);
      group = heading;
    }
    const where = issue.key ? `${issue.key}: ` : "";
    lines.push(`  ${where}${issue.problem}${issue.detail ? ` (${issue.detail})` : ""}`);
  }
  return lines.join("\n");
}
