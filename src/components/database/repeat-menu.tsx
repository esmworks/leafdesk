"use client";

import { Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { setRowRepeatAction, skipRowRepeatAction } from "@/app/actions/databases";
import { Button, cn } from "@/components/ui";
import { dateStartDay } from "@/lib/date-value";
import { presetOf, repeatPresets, type RepeatFrom, type RowRepeatRule, type RowRepeatView } from "@/lib/row-repeat";
import { MAX_REPEAT_INTERVAL, REPEAT_FREQUENCIES, type RepeatFrequency } from "@/lib/schedule";
import { dayNumber, weekdayOf } from "@/lib/time-zone";
import { dayText, useRepeatSummary, weekdayName } from "./repeat-parts";
import { useToday, useViewerTimeZone } from "./use-today";

/** A small field of the custom rule (ui's menuFieldClass fills the line, which cn doesn't override). */
const field = "h-7 rounded-md border border-border bg-bg px-1.5 text-sm text-fg outline-none focus:border-accent";

/** Monday first, as the weekday buttons show them. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * The choices of a date's Repeat row (row-repeat.tsx `RepeatRow`): no repeat, the ready-made
 * rules for the date, a rule of one's own, and "Skip this one" while the row repeats. Loaded the
 * first time the row opens.
 */
export function RepeatMenu({
  rowId,
  propertyId,
  value,
  repeat,
  onDone,
}: {
  rowId: string;
  propertyId: string;
  /** The date as the editor has it now. */
  value: unknown;
  /** The row's rule on this date, if it has one. */
  repeat?: RowRepeatView;
  /** After a change was saved: the menu closes and the rows are read again. */
  onDone: () => void;
}) {
  const t = useTranslations("database.repeat");
  const locale = useLocale();
  const summary = useRepeatSummary();
  const timeZone = useViewerTimeZone();
  const today = useToday();
  const anchor = dateStartDay(value, timeZone) ?? today;
  const presets = repeatPresets(anchor);
  const chosen = repeat ? (presetOf(repeat.rule) ?? "custom") : "off";
  const [custom, setCustom] = useState<RowRepeatRule | null>(() => (chosen === "custom" && repeat ? repeat.rule : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = async (result: Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    const res = await result.catch(() => ({ ok: false as const, error: t("failed") }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDone();
  };
  const save = (rule: RowRepeatRule | null) =>
    done(setRowRepeatAction(rowId, rule && { propertyId, rule: { ...rule, anchor }, timeZone }));

  const choice = (key: string, label: string, onPick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={chosen === key}
      disabled={busy}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-bg-hover disabled:opacity-60"
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0", chosen === key ? "text-accent" : "invisible")} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
  const day = Number(anchor.slice(8, 10));

  return (
    <div className="flex flex-col gap-0.5 pb-1" role="menu" aria-label={t("label")}>
      {choice("off", t("off"), () => void save(null))}
      {presets.map((p) =>
        choice(
          p.key,
          p.key === "weekly"
            ? t("preset.weekly", { day: weekdayName(locale, weekdayOf(dayNumber(anchor))) })
            : p.key === "monthly"
              ? t("preset.monthly", { day })
              : p.key === "yearly"
                ? t("preset.yearly", { date: new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${anchor}T00:00:00Z`)) })
                : t(`preset.${p.key}`),
          () => void save(p.rule),
        ),
      )}
      {choice("custom", chosen === "custom" && repeat ? summary(repeat.rule) : t("custom"), () =>
        setCustom((c) => c ?? repeat?.rule ?? { ...presets[2].rule, interval: 1 }),
      )}
      {custom && <CustomRule rule={custom} anchor={anchor} busy={busy} onChange={setCustom} onSave={() => void save(custom)} />}
      {repeat && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void done(skipRowRepeatAction(rowId))}
          className="mt-1 rounded-md px-1.5 py-1 text-start text-sm text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
        >
          {t("skip")}
        </button>
      )}
      {repeat?.lastError && <p className="px-1.5 text-xs text-danger">{t(`error.${repeat.lastError}`)}</p>}
      {error && (
        <p role="alert" className="px-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      {repeat?.rule.until && <p className="px-1.5 text-xs text-fg-faint">{t("endsOn", { date: dayText(locale, repeat.rule.until) })}</p>}
    </div>
  );
}

/** A rule of one's own: every how many days, weeks, months or years, on which weekdays, counted from what, until when. */
function CustomRule({
  rule,
  anchor,
  busy,
  onChange,
  onSave,
}: {
  rule: RowRepeatRule;
  anchor: string;
  busy: boolean;
  onChange: (rule: RowRepeatRule) => void;
  onSave: () => void;
}) {
  const t = useTranslations("database.repeat");
  const locale = useLocale();
  const set = (patch: Partial<RowRepeatRule>) => {
    const next = { ...rule, ...patch };
    // Weekdays belong to weekly rules counted from the date only.
    if (next.frequency !== "weekly" || next.from !== "due") next.weekdays = [];
    else if (!next.weekdays.length) next.weekdays = [weekdayOf(dayNumber(anchor))];
    onChange(next);
  };
  const toggleDay = (d: number) => {
    const days = rule.weekdays.includes(d) ? rule.weekdays.filter((x) => x !== d) : [...rule.weekdays, d];
    if (days.length) set({ weekdays: days.sort((a, b) => a - b) });
  };
  return (
    <div className="mx-1.5 my-1 flex flex-col gap-2 rounded-md border border-border p-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="shrink-0">{t("everyLabel")}</span>
        <input
          type="number"
          min={1}
          max={MAX_REPEAT_INTERVAL}
          value={rule.interval}
          aria-label={t("interval")}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (n >= 1 && n <= MAX_REPEAT_INTERVAL) set({ interval: n });
          }}
          className={cn(field, "w-14")}
        />
        <select
          value={rule.frequency}
          aria-label={t("unit")}
          onChange={(e) => set({ frequency: e.target.value as RepeatFrequency })}
          className={cn(field, "min-w-0 flex-1")}
        >
          {REPEAT_FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {t(`units.${f}`, { interval: rule.interval })}
            </option>
          ))}
        </select>
      </label>
      {rule.frequency === "weekly" && rule.from === "due" && (
        <div className="flex gap-1" role="group" aria-label={t("onLabel")}>
          {WEEK.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={rule.weekdays.includes(d)}
              title={weekdayName(locale, d)}
              onClick={() => toggleDay(d)}
              className={cn(
                "h-7 min-w-0 flex-1 rounded-md text-xs",
                rule.weekdays.includes(d) ? "bg-accent/15 font-medium text-accent" : "text-fg-muted hover:bg-bg-hover",
              )}
            >
              {weekdayName(locale, d, "short")}
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2">
        <span className="shrink-0">{t("fromLabel")}</span>
        <select
          value={rule.from}
          onChange={(e) => set({ from: e.target.value as RepeatFrom })}
          className={cn(field, "min-w-0 flex-1")}
        >
          <option value="due">{t("from.due")}</option>
          <option value="done">{t("from.done")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="shrink-0">{t("untilLabel")}</span>
        <input
          type="date"
          value={rule.until ?? ""}
          min={anchor}
          onChange={(e) => set({ until: e.target.value || null })}
          className={cn(field, "min-w-0 flex-1")}
        />
      </label>
      <Button size="sm" variant="primary" disabled={busy} onClick={onSave} className="self-end">
        {t("save")}
      </Button>
    </div>
  );
}
