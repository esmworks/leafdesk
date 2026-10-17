"use client";

import type { Dictionary } from "@blocknote/core";
import { ar, de, en, es, fa, fr, he, it, ja, ko, pl, pt, ru, uk, zh } from "@blocknote/core/locales";
import { useLocale } from "next-intl";
import { DEFAULT_LOCALE, type Locale } from "../config";
import { tr } from "./tr";

/**
 * BlockNote's own UI strings (slash menu, toolbars, placeholders) per language. BlockNote ships
 * many languages (`@blocknote/core/locales`); import the new one here. For a language it lacks,
 * add `./<locale>.ts` like tr.ts. Named imports keep the other dictionaries out of the bundle; the
 * `Record<Locale, …>` type makes `pnpm typecheck` fail when a language is missing here.
 */
export const EDITOR_DICTIONARIES: Record<Locale, Dictionary> = { en, tr, de, es, fr, it, pt, pl, ru, uk, ar, he, fa, ja, ko, zh };

/** The editor dictionary for the current language. */
export function useEditorDictionary(): Dictionary {
  return EDITOR_DICTIONARIES[useLocale()] ?? EDITOR_DICTIONARIES[DEFAULT_LOCALE];
}
