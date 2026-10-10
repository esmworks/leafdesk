/**
 * The interface languages: code → the language's name in itself (shown in the language picker).
 * Adding a language starts here; CONTRIBUTING.md (Translations) has the whole list of steps.
 */
export const LOCALE_NAMES = {
  en: "English",
  tr: "Türkçe",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
} as const satisfies Record<string, string>;

export type Locale = keyof typeof LOCALE_NAMES;
export const LOCALES = Object.keys(LOCALE_NAMES) as Locale[];
/** The source language: every other language is checked against it and falls back to it. */
export const DEFAULT_LOCALE: Locale = "en";

/** Chosen language; absent means "follow the browser". */
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** Browser time zone, so server-rendered dates match the viewer's clock. */
export const TIME_ZONE_COOKIE = "TZ";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LOCALE_NAMES, value);
}

/** The supported language for a BCP 47 tag: an exact match ("pt-br"), else its base language ("de-AT" → "de"). */
function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  if (isLocale(lower)) return lower;
  const base = lower.split("-")[0];
  return isLocale(base) ? base : null;
}

/** Picks the best supported locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    // Stable: equal weights keep the browser's order.
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

/** The language of a request outside Next's request scope: the saved choice, else Accept-Language. */
export function requestLocale(headers: Headers): Locale {
  const saved = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE)?.[1];
  return isLocale(saved) ? saved : negotiateLocale(headers.get("accept-language"));
}

/** The time zone a request's cookie names (see TimeZoneCookie), outside Next's request scope; unchecked. */
export function requestTimeZone(headers: Headers): string | null {
  const saved = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === TIME_ZONE_COOKIE)?.[1];
  if (!saved) return null;
  try {
    return decodeURIComponent(saved);
  } catch {
    return null;
  }
}
