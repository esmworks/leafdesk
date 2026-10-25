"use client";

import { ArrowLeft, Check } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { cn, menuFieldClass } from "@/components/ui";
import { DATE_CLOCKS, DATE_FORMATS, REMINDER_DAYS, type DateFormatKind, type DateOptionsInput } from "@/lib/date-options";
import { formatStyledDate, type DateFormatter } from "@/lib/date-format";
import { browserTimeZone, dayString, localDay } from "@/lib/time-zone";
import type { Property } from "./types";

type FormatChoice = DateFormatKind | "default" | "relative";
const FORMAT_CHOICES: FormatChoice[] = ["default", ...DATE_FORMATS, "relative"];

/**
 * A date property's settings (created and last edited times have all but the reminder): the format
 * days show in ("October 24, 2026", "24/10/2026", "tomorrow"…), with an example of each in the
 * viewer's language, the clock times show on, and a reminder to the rows' people some days before
 * their date. Each change is saved right away.
 */
export function DateOptionsEditor({
  prop,
  onChange,
  onBack,
}: {
  prop: Property;
  onChange: (input: DateOptionsInput) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const format = useFormatter();
  const locale = useLocale();
  // Saved per change; the parent applies it to `prop` optimistically.
  const options = prop.options.date ?? {};
  const chosen: FormatChoice = options.display === "relative" ? "relative" : (options.format ?? "default");
  const clock = options.clock ?? "default";
  const writer: DateFormatter = (d, o) => format.dateTime(d, o);
  // Today (the viewer's day) in each format, the way values will read.
  const today = dayString(localDay(Date.now(), browserTimeZone()));
  const example = (choice: FormatChoice) =>
    choice === "relative"
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(1, "day")
      : (formatStyledDate(today, writer, "UTC", { format: choice === "default" ? undefined : choice }) ?? "");

  const choose = (choice: FormatChoice) => {
    if (choice === chosen) return;
    onChange(choice === "relative" ? { display: "relative", format: null } : { display: "date", format: choice });
  };
  // A reminder set here goes by the browser's time zone.
  const setReminder = (value: string) =>
    onChange(value === "" ? { reminderDays: null } : { reminderDays: Number(value), timeZone: browserTimeZone() });

  return (
    <div className="w-64">
      <div className="flex items-center gap-1 px-1 pt-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="truncate px-1 text-sm font-medium">{t("dateOptions")}</span>
      </div>
      <div className="space-y-2 p-2">
        <div>
          <span className="mb-1 block text-xs text-fg-muted">{t("dateFormat")}</span>
          <div role="radiogroup" aria-label={t("dateFormat")} className="space-y-0.5">
            {FORMAT_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={chosen === choice}
                onClick={() => choose(choice)}
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-bg-hover",
                  chosen === choice && "bg-bg-active",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{t(`dateFormats.${choice}`)}</span>
                <span className="shrink-0 text-xs text-fg-faint tabular-nums">{example(choice)}</span>
                <Check className={cn("h-3.5 w-3.5 shrink-0", chosen === choice ? "text-fg-muted" : "invisible")} />
              </button>
            ))}
          </div>
          {chosen === "relative" && <p className="mt-1 text-xs text-fg-faint">{t("relativeHint")}</p>}
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("timeFormat")}</span>
          <select
            className={menuFieldClass}
            value={clock}
            onChange={(e) => onChange({ clock: e.target.value as DateOptionsInput["clock"] })}
          >
            <option value="default">{t("timeFormats.default")}</option>
            {DATE_CLOCKS.map((c) => (
              <option key={c} value={c}>
                {t(`timeFormats.${c}`)}
              </option>
            ))}
          </select>
        </label>
        {prop.type === "date" && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">{t("reminder")}</span>
              <select className={menuFieldClass} value={options.reminder?.daysBefore ?? ""} onChange={(e) => setReminder(e.target.value)}>
                <option value="">{t("reminderNone")}</option>
                {REMINDER_DAYS.map((days) => (
                  <option key={days} value={days}>
                    {t("reminderBefore", { days })}
                  </option>
                ))}
              </select>
            </label>
            {options.reminder && <p className="text-xs text-fg-faint">{t("reminderHint")}</p>}
          </>
        )}
      </div>
    </div>
  );
}
