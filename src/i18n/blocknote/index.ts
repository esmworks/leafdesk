"use client";

import type { Dictionary } from "@blocknote/core";
import { de, en, es, fr } from "@blocknote/core/locales";
import { useLocale } from "next-intl";
import { DEFAULT_LOCALE, type Locale } from "../config";
import { tr } from "./tr";

/**
 * BlockNote's own UI strings (slash menu, toolbars, placeholders) per language. BlockNote ships
 * many languages (`@blocknote/core/locales`); import the new one here. For a language it lacks,
 * add `./<locale>.ts` like tr.ts. Named imports keep the other dictionaries out of the bundle; the
 * `Record<Locale, …>` type makes `pnpm typecheck` fail when a language is missing here.
 */
export const EDITOR_DICTIONARIES: Record<Locale, Dictionary> = {
  en: unanchored(en, "Not tied to any text"),
  tr,
  de: unanchored(de, "Mit keinem Text verknüpft"),
  es: unanchored(es, "No está vinculado a ningún texto"),
  fr: unanchored(fr, "Rattaché à aucun texte"),
};

/**
 * A comment thread shows this over its comments when it isn't tied to text on the page: its text
 * was deleted, or it was written about the whole page (as agents do). BlockNote's own wording
 * ("original content deleted") only fits the first.
 */
function unanchored(dictionary: Dictionary, text: string): Dictionary {
  return { ...dictionary, comments: { ...dictionary.comments, deleted_reference_text: text } };
}

/** The editor dictionary for the current language. */
export function useEditorDictionary(): Dictionary {
  return EDITOR_DICTIONARIES[useLocale()] ?? EDITOR_DICTIONARIES[DEFAULT_LOCALE];
}
