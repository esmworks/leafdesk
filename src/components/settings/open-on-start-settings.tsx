"use client";

import { useTranslations } from "next-intl";
import { setOpenOnStartAction } from "@/app/actions/preferences";
import { OPEN_ON_START, type OpenOnStart } from "@/lib/open-on-start";
import { PreferenceSelect } from "./preference-select";

/** What the app opens on when the person starts it (lib/open-on-start.ts); account-wide. */
export function OpenOnStartSettings({ current }: { current: OpenOnStart }) {
  const t = useTranslations("settings.openOnStart");
  return (
    <PreferenceSelect
      id="open-on-start"
      title={t("label")}
      note={t("note")}
      current={current}
      options={OPEN_ON_START.map((value) => ({ value, label: t(value) }))}
      save={setOpenOnStartAction}
    />
  );
}
