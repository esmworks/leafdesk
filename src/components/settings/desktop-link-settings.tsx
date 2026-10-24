"use client";

import { useTranslations } from "next-intl";
import { setDesktopLinksAction } from "@/app/actions/preferences";
import { DESKTOP_LINKS, type DesktopLinks } from "@/lib/desktop-links";
import { PreferenceSelect } from "./preference-select";

/** Whether Leafdesk's pages opened in a browser go on to the desktop app (lib/desktop-links.ts); account-wide. */
export function DesktopLinkSettings({ current }: { current: DesktopLinks }) {
  const t = useTranslations("settings.desktopLinks");
  return (
    <PreferenceSelect
      id="desktop-links"
      title={t("label")}
      note={t("note")}
      current={current}
      options={DESKTOP_LINKS.map((value) => ({ value, label: t(value) }))}
      save={setDesktopLinksAction}
    />
  );
}
