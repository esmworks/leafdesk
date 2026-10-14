"use client";

import { useTranslations } from "next-intl";
import { setContrastAction, setThemeAction } from "@/app/actions/theme";
import { useChosenTheme } from "@/components/theme/theme-provider";
import { CONTRASTS, isContrast, isTheme, THEMES, type Contrast, type Theme } from "@/lib/theme";
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

/**
 * Standard or high contrast for this browser, stored in a cookie; empty means following the
 * system's "increase contrast". Only the stylesheet draws it (<html data-contrast>, globals.css).
 */
export function ContrastSettings({ current }: { current: Contrast | null }) {
  const t = useTranslations("settings.theme");
  return (
    <PreferenceSelect
      id="interface-contrast"
      title={t("contrast.label")}
      note={t("contrast.note")}
      current={current}
      options={[{ value: "", label: t("system") }, ...CONTRASTS.map((contrast) => ({ value: contrast, label: t(`contrast.${contrast}`) }))]}
      save={setContrastAction}
      onApply={(value) => {
        if (isContrast(value)) document.documentElement.dataset.contrast = value;
        else delete document.documentElement.dataset.contrast;
      }}
    />
  );
}
