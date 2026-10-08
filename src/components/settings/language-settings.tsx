"use client";

import { useTranslations } from "next-intl";
import { setLocaleAction } from "@/app/actions/locale";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/i18n/config";
import { PreferenceSelect } from "./preference-select";

// Each language by its own name, in alphabetical order.
const SORTED_LOCALES = [...LOCALES].sort((a, b) => LOCALE_NAMES[a].localeCompare(LOCALE_NAMES[b], "en"));

/** Interface language for this browser, stored in a cookie; empty means "follow the browser". */
export function LanguageSettings({ current }: { current: Locale | null }) {
  const t = useTranslations("settings.language");
  return (
    <PreferenceSelect
      id="interface-language"
      title={t("label")}
      note={t("note")}
      current={current}
      options={[
        { value: "", label: t("followBrowser") },
        ...SORTED_LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale], lang: locale })),
      ]}
      save={setLocaleAction}
    />
  );
}
