import { en as editorEn } from "@blocknote/core/locales";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EDITOR_DICTIONARIES } from "./blocknote";
import { tr as editorTr } from "./blocknote/tr";
import { checkTranslations, compareFile, formatIssues } from "./check";
import { DEFAULT_LOCALE, LOCALES, negotiateLocale, requestLocale } from "./config";
import { emailMessages } from "./messages/email";
import { clientMessages, loadMessages, withFallback } from "./messages";
import en from "./messages/en";

const MESSAGES_DIR = fileURLToPath(new URL("./messages", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Leaf key paths of a dictionary (BlockNote's alias lists count as one leaf: each language has its own). */
function keys(tree: unknown, prefix = ""): string[] {
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return [prefix];
  return Object.entries(tree).flatMap(([key, value]) => keys(value, prefix ? `${prefix}.${key}` : key));
}

describe("translations", () => {
  // The same check as `pnpm i18n:check`; its report says what to fix.
  it("every language has exactly the English files, keys and placeholders", () => {
    const issues = checkTranslations(MESSAGES_DIR, LOCALES, DEFAULT_LOCALE);
    expect(issues, `\n${formatIssues(issues)}\n\nRun \`pnpm i18n:check\` for this report.`).toHaveLength(0);
  });

  it("finds missing, extra and mismatched messages", () => {
    const source = { a: "Hello {name}", b: { c: "{count, plural, one {# page} other {# pages}}" }, d: "Plain", e: "{kind, select, page {Page} other {Item}}" };
    const problems = (target: unknown) => compareFile(source, target).map((issue) => `${issue.key}: ${issue.problem}`);
    expect(problems({ a: "Hallo {name}", b: { c: "{count} Seiten" }, d: "Schlicht", e: "{kind, select, page {Seite} other {Ding}}" })).toEqual([]);
    expect(problems({ a: "Hallo {nom}", b: { c: "{count, plural, one {# Seite}}" }, e: "{kind, select, other {Ding}}", x: "Extra" })).toEqual([
      "a: placeholders",
      "b.c: syntax",
      "d: missing",
      "e: select options",
      "x: extra",
    ]);
    // An ASCII apostrophe before a brace quotes it in ICU, losing the placeholder.
    expect(problems({ ...source, a: "Bonjour l'{name}" })).toEqual(["a: placeholders"]);
    expect(problems({ ...source, d: " " })).toEqual(["d: empty"]);
  });

  it("falls back to English for texts a language lacks", async () => {
    expect(withFallback({ a: "A", b: { c: "C", d: "D" } }, { a: "Ä", b: { c: 1 }, x: "X" })).toEqual({ a: "Ä", b: { c: "C", d: "D" } });
    for (const locale of LOCALES) {
      const messages = await loadMessages(locale);
      expect(keys(messages).sort(), locale).toEqual(keys(en).sort());
      expect(keys(emailMessages[locale]).sort(), locale).toEqual(keys(emailMessages.en).sort());
    }
    expect((await loadMessages("tr")).common.untitled).toBe("Adsız");
  });

  it("every language has an editor dictionary; the Turkish one covers every BlockNote key", () => {
    for (const locale of LOCALES) expect(EDITOR_DICTIONARIES[locale], locale).toBeDefined();
    expect(keys(editorTr).sort()).toEqual(keys(editorEn).sort());
  });

  it("negotiates the language from Accept-Language", () => {
    expect(negotiateLocale("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
    expect(negotiateLocale("nl-NL,de;q=0.9,tr;q=0.5")).toBe("de");
    expect(negotiateLocale("fr-CA")).toBe("fr");
    expect(negotiateLocale("es-419,es;q=0.9")).toBe("es");
    expect(negotiateLocale("nl-NL")).toBe("en");
    expect(negotiateLocale("pt-BR")).toBe("pt");
    expect(negotiateLocale("zh-CN,zh;q=0.9")).toBe("zh");
    expect(negotiateLocale(null)).toBe("en");
    expect(negotiateLocale("en;q=0.2,tr;q=0.8")).toBe("tr");
    expect(negotiateLocale("DE-de")).toBe("de");
  });

  it("prefers the saved language over Accept-Language for requests", () => {
    const headers = (init: Record<string, string>) => new Headers(init);
    expect(requestLocale(headers({ "accept-language": "tr-TR" }))).toBe("tr");
    expect(requestLocale(headers({ cookie: "TZ=Europe%2FIstanbul; NEXT_LOCALE=en", "accept-language": "tr" }))).toBe("en");
    expect(requestLocale(headers({ cookie: "NEXT_LOCALE=fr", "accept-language": "tr" }))).toBe("fr");
    expect(requestLocale(headers({ cookie: "NEXT_LOCALE=xx", "accept-language": "tr" }))).toBe("tr");
    expect(requestLocale(headers({}))).toBe("en");
  });
});

describe("clientMessages", () => {
  it("leaves out the audit log texts and keeps the rest of Settings", () => {
    const sent = clientMessages(en);
    expect(sent.settings).not.toHaveProperty("audit");
    expect(sent.settings.members).toBe(en.settings.members);
    expect(Object.keys(sent)).toEqual(Object.keys(en));
  });

  it("no client component reads the texts the browser doesn't get", () => {
    const clientFiles = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => readFileSync(join(SRC_DIR, file), "utf8"))
      .filter((source) => /^["']use client["']/m.test(source));
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(clientFiles.filter((source) => /settings\.audit|["']audit\./.test(source))).toEqual([]);
  });
});
