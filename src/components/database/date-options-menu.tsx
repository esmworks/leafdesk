"use client";

import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { REMINDER_DAYS, type DateOptionsInput } from "@/lib/date-options";
import { browserTimeZone } from "@/lib/time-zone";
import type { Property } from "./types";

const FIELD = "block w-full h-7 rounded-md border border-border bg-bg px-1.5 text-sm text-fg outline-none focus:border-accent";

/**
 * A date property's settings: whether days near today show relatively ("tomorrow", "in 3 days"),
 * and a reminder to the rows' people some days before their date. Each change is saved right away.
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
  // Saved per change; the parent applies it to `prop` optimistically.
  const options = prop.options.date ?? {};
  const relative = options.display === "relative";

  const setDisplay = (display: "date" | "relative") => onChange({ display });
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
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="truncate px-1 text-sm font-medium">{t("dateOptions")}</span>
      </div>
      <div className="space-y-2 p-2">
        <div>
          <span className="mb-1 block text-xs text-fg-muted">{t("dateDisplay")}</span>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label={t("dateDisplay")}>
            {(["date", "relative"] as const).map((display) => {
              const checked = relative === (display === "relative");
              return (
                <button
                  key={display}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => !checked && setDisplay(display)}
                  className={
                    checked
                      ? "h-7 truncate rounded-md border border-accent bg-bg-active px-1 text-xs text-fg"
                      : "h-7 truncate rounded-md border border-border px-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                  }
                >
                  {t(display === "relative" ? "displayRelative" : "displayDate")}
                </button>
              );
            })}
          </div>
          {relative && <p className="mt-1 text-xs text-fg-faint">{t("relativeHint")}</p>}
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("reminder")}</span>
          <select className={FIELD} value={options.reminder?.daysBefore ?? ""} onChange={(e) => setReminder(e.target.value)}>
            <option value="">{t("reminderNone")}</option>
            {REMINDER_DAYS.map((days) => (
              <option key={days} value={days}>
                {t("reminderBefore", { days })}
              </option>
            ))}
          </select>
        </label>
        {options.reminder && <p className="text-xs text-fg-faint">{t("reminderHint")}</p>}
      </div>
    </div>
  );
}
