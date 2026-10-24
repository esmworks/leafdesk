"use client";

import { iconPrefix } from "@/lib/icon-value";
import { useTranslations } from "next-intl";
import { DEFAULT_ROW_TEMPLATE } from "@/lib/automations";
import { pageLabel } from "@/lib/labels";
import type { DatabaseInfo } from "./automations-data";
import { selectClass } from "./automations-values";

/**
 * Which row template a button's or automation's "add a row" step starts from: none (a blank row),
 * the database's default one, or one of its templates. "" is none (lib/automations cleanRowTemplate).
 */
export function RowTemplateSelect({
  info,
  value,
  onChange,
  className,
}: {
  info: Pick<DatabaseInfo, "templates" | "defaultTemplateId">;
  value: string;
  onChange: (template: string) => void;
  className?: string;
}) {
  const t = useTranslations("database.automations.steps");
  const tc = useTranslations("common");
  const named = (id: string | null) => info.templates.find((x) => x.id === id);
  const fallback = named(info.defaultTemplateId);
  const known = !value || value === DEFAULT_ROW_TEMPLATE || Boolean(named(value));
  return (
    <select value={value} aria-label={t("rowTemplate")} onChange={(e) => onChange(e.target.value)} className={className ?? selectClass}>
      <option value="">{t("rowTemplateNone")}</option>
      <option value={DEFAULT_ROW_TEMPLATE}>
        {fallback ? t("rowTemplateDefaultNamed", { name: pageLabel(fallback.title, tc("untitled")) }) : t("rowTemplateDefault")}
      </option>
      {info.templates.map((x) => (
        <option key={x.id} value={x.id}>
          {iconPrefix(x.icon)}
          {pageLabel(x.title, tc("untitled"))}
        </option>
      ))}
      {!known && <option value={value}>{t("rowTemplateGone")}</option>}
    </select>
  );
}
