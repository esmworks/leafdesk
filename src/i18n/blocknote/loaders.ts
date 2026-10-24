import type { Dictionary } from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import type { Locale } from "../config";

/**
 * BlockNote's own UI strings (slash menu, toolbars, placeholders) per language, each downloaded
 * only by those who use it. BlockNote ships many languages in one module
 * (`@blocknote/core/locales`); `./locales/<locale>.ts` re-exports one of them so it gets a chunk
 * of its own. For a language BlockNote lacks, add `./<locale>.ts` like tr.ts. English comes with
 * the editor itself. The `Record<Locale, …>` type makes `pnpm typecheck` fail when a language is
 * missing here.
 */
export const EDITOR_DICTIONARY_LOADERS: Record<Locale, () => Promise<Dictionary>> = {
  en: async () => en,
  tr: () => import("./tr").then((m) => m.tr),
  de: () => import("./locales/de").then((m) => m.de),
  es: () => import("./locales/es").then((m) => m.es),
  fr: () => import("./locales/fr").then((m) => m.fr),
  it: () => import("./locales/it").then((m) => m.it),
  pt: () => import("./locales/pt").then((m) => m.pt),
  pl: () => import("./locales/pl").then((m) => m.pl),
  ru: () => import("./locales/ru").then((m) => m.ru),
  uk: () => import("./locales/uk").then((m) => m.uk),
  ar: () => import("./locales/ar").then((m) => m.ar),
  he: () => import("./locales/he").then((m) => m.he),
  fa: () => import("./locales/fa").then((m) => m.fa),
  ja: () => import("./locales/ja").then((m) => m.ja),
  ko: () => import("./locales/ko").then((m) => m.ko),
  zh: () => import("./locales/zh").then((m) => m.zh),
  id: () => import("./id").then((m) => m.id),
  th: () => import("./th").then((m) => m.th),
  vi: () => import("./locales/vi").then((m) => m.vi),
};
