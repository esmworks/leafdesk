"use client";

import { ArrowLeft } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, menuFieldClass } from "@/components/ui";
import {
  defaultDivideBy,
  NUMBER_DISPLAYS,
  type NumberDisplay,
  type NumberDisplayColor,
  type NumberDisplayKind,
} from "@/lib/number-display";
import {
  COMMON_CURRENCIES,
  NUMBER_FORMATS,
  numberText,
  readNumber,
  type NumberFormat,
  type NumberFormatKind,
} from "@/lib/number-format";
import { SELECT_COLORS } from "@/lib/properties";
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
 * decimal places; and whether values show as the number, a bar or a ring (with its color and what
 * a full one stands for). Each change is saved right away and only changes how values show.
 */
export function NumberFormatEditor({
  prop,
  onChange,
  onDisplayChange,
  onBack,
}: {
  prop: Property;
  onChange: (format: NumberFormat | null) => void;
  /** Omitted where only the format can change. */
  onDisplayChange?: (display: NumberDisplay | null) => void;
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
      {onDisplayChange && (
        // A new format reads "divide by" in its own terms (percent points for a percentage).
        <DisplayEditor key={format.format} initial={prop.options.numberDisplay} format={format} onChange={onDisplayChange} />
      )}
    </div>
  );
}

/** The display part of the number menu: the number, a bar or a ring, as rollup percentages offer. */
function DisplayEditor({
  initial,
  format,
  onChange,
}: {
  initial: NumberDisplay | undefined;
  format: NumberFormat;
  onChange: (display: NumberDisplay | null) => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const tr = useTranslations("database.rollup");
  const tColor = useTranslations("database.colors");
  const locale = useLocale();
  const formatNumber = useFormatNumber();
  const [display, setDisplay] = useState<NumberDisplay | null>(initial ?? null);
  const divideBy = display?.divideBy ?? defaultDivideBy(format);
  // What a full bar stands for, typed as values are (percent points for a percent property).
  const [draft, setDraft] = useState(() => numberText(divideBy, locale, format));
  const [invalid, setInvalid] = useState(false);

  const save = (next: NumberDisplay | null) => {
    setDisplay(next);
    onChange(next);
  };
  const choose = (kind: NumberDisplayKind) => {
    if (kind === (display?.display ?? "number")) return;
    save(kind === "number" ? null : { ...display, display: kind });
  };
  const commitDivideBy = () => {
    if (!display) return;
    const n = readNumber(draft, format, locale);
    if (n === undefined || !(n > 0)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (n === divideBy) return;
    const { divideBy: _old, ...rest } = display;
    save(n === defaultDivideBy(format) ? rest : { ...rest, divideBy: n });
  };
  // Closing the menu by clicking outside unmounts it before the input's blur fires.
  const commitRef = useRef(commitDivideBy);
  commitRef.current = commitDivideBy;
  useEffect(() => () => commitRef.current(), []);
  const swatch = (color: NumberDisplayColor | undefined) => {
    const chosen = display?.color === color;
    return (
      <button
        key={color ?? "default"}
        type="button"
        role="radio"
        aria-checked={chosen}
        aria-label={color ? tColor(color) : t("colorDefault")}
        title={color ? tColor(color) : t("colorDefault")}
        onClick={() => {
          if (!display || chosen) return;
          const { color: _old, ...rest } = display;
          save(color ? { ...rest, color } : rest);
        }}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-md border",
          chosen ? "border-accent bg-bg-active" : "border-transparent hover:bg-bg-hover",
        )}
      >
        <span className="h-3 w-3 rounded-full bg-accent" style={color ? { background: `var(--chart-${color})` } : undefined} />
      </button>
    );
  };

  return (
    <div className="space-y-2 border-t border-border p-2">
      <div>
        <span className="mb-1 block text-xs text-fg-muted">{tr("display")}</span>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={tr("display")}>
          {NUMBER_DISPLAYS.map((kind) => {
            const on = (display?.display ?? "number") === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(kind)}
                className={
                  on
                    ? "h-7 truncate rounded-md border border-accent bg-bg-active px-1 text-xs text-fg"
                    : "h-7 truncate rounded-md border border-border px-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                }
              >
                {tr(`displays.${kind}`)}
              </button>
            );
          })}
        </div>
      </div>
      {display && (
        <>
          <div>
            <span className="mb-1 block text-xs text-fg-muted">{t("color")}</span>
            <div className="flex flex-wrap gap-0.5" role="radiogroup" aria-label={t("color")}>
              {swatch(undefined)}
              {SELECT_COLORS.map((color) => swatch(color))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">{t("divideBy")}</span>
            <input
              className={cn(menuFieldClass, "tabular-nums", invalid && "border-danger")}
              inputMode="decimal"
              value={draft}
              aria-invalid={invalid}
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              onBlur={commitDivideBy}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitDivideBy();
              }}
            />
          </label>
          <p className="text-xs text-fg-faint" aria-live="polite">
            {invalid ? t("divideByInvalid") : t("divideByHint", { value: formatNumber(divideBy, format) })}
          </p>
        </>
      )}
    </div>
  );
}
