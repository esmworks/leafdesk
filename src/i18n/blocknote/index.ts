"use client";

import type { Dictionary } from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import { useLocale } from "next-intl";
import { use } from "react";
import { DEFAULT_LOCALE, type Locale } from "../config";
import { EDITOR_DICTIONARY_LOADERS } from "./loaders";

const loading = new Map<string, Promise<Dictionary>>();

/** The current language's dictionary, downloaded once; a failed download leaves the editor in English. */
function loadEditorDictionary(locale: string): Promise<Dictionary> {
  let dictionary = loading.get(locale);
  if (!dictionary) {
    const load = EDITOR_DICTIONARY_LOADERS[locale as Locale] ?? EDITOR_DICTIONARY_LOADERS[DEFAULT_LOCALE];
    dictionary = load().catch(() => en);
    loading.set(locale, dictionary);
  }
  return dictionary;
}

/**
 * The editor dictionary for the current language. Until it has downloaded the editor suspends
 * (every editor is a `dynamic()` import, so its loading state stays up) rather than showing English.
 */
export function useEditorDictionary(): Dictionary {
  const locale = useLocale();
  return locale === DEFAULT_LOCALE ? en : use(loadEditorDictionary(locale));
}
