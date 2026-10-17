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
export const EDITOR_DICTIONARIES: Record<Locale, Dictionary> = { en, tr, de, es, fr, it, pt, pl, ru, uk, ar, he: hebrew(), fa, ja, ko, zh };

/** BlockNote's Hebrew, with resolving a comment thread said as resolving it (not "mark button"). */
function hebrew(): Dictionary {
  const { comments } = he;
  return {
    ...he,
    comments: {
      ...comments,
      actions: { ...comments.actions, resolve: "סמן כנפתר" },
      sidebar: { ...comments.sidebar, marked_as_resolved: "סומן כנפתר" },
    },
  };
}

/** The editor dictionary for the current language. */
export function useEditorDictionary(): Dictionary {
  return EDITOR_DICTIONARIES[useLocale()] ?? EDITOR_DICTIONARIES[DEFAULT_LOCALE];
}
