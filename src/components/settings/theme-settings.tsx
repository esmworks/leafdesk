"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setThemeAction } from "@/app/actions/theme";
import { cn } from "@/components/ui";
import { isTheme, THEMES, type Theme } from "@/lib/theme";
import { SettingsRow } from "./section";
import { selectClass } from "./workspace-settings";

/** Light or dark theme for this browser, stored in a cookie; empty means "follow the system". */
export function ThemeSettings({ current }: { current: Theme | null }) {
  const t = useTranslations("settings.theme");
  const tc = useTranslations("common");
  const router = useRouter();
  const [value, setValue] = useState<string>(current ?? "");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  // Shown at once; the refresh then brings the parts that draw themselves (editor, diagrams) along.
  const apply = (theme: string) => {
    if (isTheme(theme)) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };

  return (
    <SettingsRow
      title={t("label")}
      htmlFor="interface-theme"
      description={error ? <span className="text-danger">{tc("genericError")}</span> : t("note")}
      control={
        <select
          id="interface-theme"
          className={cn(selectClass, "min-w-44")}
          value={value}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            const previous = value;
            setValue(next);
            setError(false);
            apply(next);
            startTransition(async () => {
              try {
                await setThemeAction(next || null);
                router.refresh();
              } catch {
                // Not saved: back to the theme that is still in effect.
                setValue(previous);
                apply(previous);
                setError(true);
              }
            });
          }}
        >
          <option value="">{t("system")}</option>
          {THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {t(theme)}
            </option>
          ))}
        </select>
      }
    />
  );
}
