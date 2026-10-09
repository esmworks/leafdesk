"use client";

import { ArrowLeft } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { menuFieldClass } from "@/components/ui";
import { COMMON_CURRENCIES, NUMBER_FORMATS, type NumberFormat, type NumberFormatKind } from "@/lib/number-format";
import { useFormatNumber } from "./property-cell";
import type { Property } from "./types";

/** Decimal places the menu offers besides automatic; MCP can set up to MAX_DECIMALS. */
const DECIMALS = [0, 1, 2, 3, 4];

/** The currency a new currency format starts with: the one most people writing in the language use. */
const LOCALE_CURRENCY: Record<string, string> = { tr: "TRY", de: "EUR", fr: "EUR", es: "EUR" };

const FORMAT_LABELS = { number: "formatNumber", percent: "formatPercent", currency: "formatCurrency" } as const;

/** "TRY · Turkish lira" in the viewer's language, or the code alone where the browser can't name it. */
function useCurrencyName() {
  const locale = useLocale();
  const names = useMemo(() => {
    try {
      return new Intl.DisplayNames(locale, { type: "currency" });
    } catch {
      return null;
    }
  }, [locale]);
  return (code: string) => {
    const name = names?.of(code);
    return name && name !== code ? `${code} · ${name}` : code;
  };
}

/**
 * A number property's format: a plain number, a percentage or an amount in a currency, and its
 * decimal places. Each change is saved right away and only changes how values show.
 */
export function NumberFormatEditor({
  prop,
  onChange,
  onBack,
}: {
  prop: Property;
  onChange: (format: NumberFormat | null) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const locale = useLocale();
  const formatNumber = useFormatNumber();
  const currencyName = useCurrencyName();
  // Edited locally and saved per change; the parent applies it optimistically.
  const [format, setFormat] = useState<NumberFormat>(prop.options.number ?? { format: "number" });

  const save = (next: NumberFormat) => {
    setFormat(next);
    onChange(next.format === "number" && next.decimals === undefined ? null : next);
  };
  const choose = (kind: NumberFormatKind) => {
    if (kind === format.format) return;
    const { decimals } = format;
    const currency = kind === "currency" ? (format.currency ?? LOCALE_CURRENCY[locale] ?? "USD") : undefined;
    save({ format: kind, ...(currency ? { currency } : {}), ...(decimals !== undefined ? { decimals } : {}) });
  };
  const currencies = format.currency && !COMMON_CURRENCIES.includes(format.currency) ? [format.currency, ...COMMON_CURRENCIES] : COMMON_CURRENCIES;
  const decimals = format.decimals !== undefined && !DECIMALS.includes(format.decimals) ? [...DECIMALS, format.decimals] : DECIMALS;
  const example = format.format === "percent" ? 0.155 : 1234.5;

  return (
    <div className="w-64">
      <div className="flex items-center gap-1 px-1 pt-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="truncate px-1 text-sm font-medium">{t("numberFormat")}</span>
      </div>
      <div className="space-y-2 p-2">
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={t("numberFormat")}>
          {NUMBER_FORMATS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={format.format === kind}
              onClick={() => choose(kind)}
              className={
                format.format === kind
                  ? "h-7 truncate rounded-md border border-accent bg-bg-active px-1 text-xs text-fg"
                  : "h-7 truncate rounded-md border border-border px-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
              }
            >
              {t(FORMAT_LABELS[kind])}
            </button>
          ))}
        </div>
        {format.format === "currency" && (
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">{t("formatCurrency")}</span>
            <select className={menuFieldClass} value={format.currency} onChange={(e) => save({ ...format, currency: e.target.value })}>
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {currencyName(code)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("decimals")}</span>
          <select
            className={menuFieldClass}
            value={format.decimals ?? ""}
            onChange={(e) => {
              const { decimals: _old, ...rest } = format;
              save(e.target.value === "" ? rest : { ...rest, decimals: Number(e.target.value) });
            }}
          >
            <option value="">{t("decimalsAuto")}</option>
            {decimals.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-fg-faint tabular-nums" aria-live="polite">
          {formatNumber(example, format)}
          {format.format === "percent" && ` · ${t("percentHint", { percent: formatNumber(0.15, { format: "percent" }) })}`}
        </p>
      </div>
    </div>
  );
}
