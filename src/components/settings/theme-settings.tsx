"use client";

import { useTranslations } from "next-intl";
import { setThemeAction } from "@/app/actions/theme";
import { useChosenTheme } from "@/components/theme/theme-provider";
import { isTheme, THEMES, type Theme } from "@/lib/theme";
import { PreferenceSelect } from "./preference-select";

/** Light or dark theme for this browser, stored in a cookie; empty means "follow the system". */
export function ThemeSettings({ current }: { current: Theme | null }) {
  const t = useTranslations("settings.theme");
  const { setTheme } = useChosenTheme();
  return (
    <PreferenceSelect
      id="interface-theme"
      title={t("label")}
      note={t("note")}
      current={current}
      options={[{ value: "", label: t("system") }, ...THEMES.map((theme) => ({ value: theme, label: t(theme) }))]}
      save={setThemeAction}
      onApply={(value) => setTheme(isTheme(value) ? value : null)}
    />
  );
}
