"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { cn, Input } from "@/components/ui";
import {
  MAX_REPEAT_INTERVAL,
  nextOccurrence,
  parseRepeatRule,
  REPEAT_FREQUENCIES,
  WEEKDAYS_FROM_MONDAY,
  type RepeatFrequency,
  type RepeatRule,
} from "@/lib/schedule";
import { browserTimeZone, dayString, isTimeZone, listTimeZones, localDay, timeZoneLabel } from "@/lib/time-zone";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

/** A repeat rule (lib/schedule) as a form edits it: the interval as typed, and the time zone with it. */
export type RepeatForm = {
  frequency: RepeatFrequency;
  interval: string;
  weekdays: number[];
  time: string;
  start: string;
  timeZone: string;
};

/** A new rule: every week on today's weekday (or as `start` says), at `time`, from today, in the browser's time zone. */
export function freshRepeatForm(start: Partial<Pick<RepeatForm, "frequency" | "time">> = {}): RepeatForm {
  const timeZone = browserTimeZone();
  const today = localDay(Date.now(), timeZone);
  return {
    frequency: start.frequency ?? "weekly",
    interval: "1",
    weekdays: [new Date(today * 86_400_000).getUTCDay()],
    time: start.time ?? "09:00",
    start: dayString(today),
    timeZone,
  };
}

export const repeatFormOf = (rule: RepeatRule, timeZone: string): RepeatForm => ({ ...rule, interval: String(rule.interval), timeZone });

/** The rule the form holds (null when it isn't a valid one), and when it runs next. */
export function useRepeatRule(form: RepeatForm) {
  const rule = useMemo(
    () => parseRepeatRule({ ...form, interval: Number(form.interval), weekdays: form.frequency === "weekly" ? form.weekdays : [] }),
    [form],
  );
  const zoneOk = isTimeZone(form.timeZone);
  const next = useMemo(() => (rule && zoneOk ? nextOccurrence(rule, form.timeZone, new Date()) : null), [rule, zoneOk, form.timeZone]);
  return { rule, valid: rule !== null && zoneOk, next };
}

/**
 * The fields of a repeat rule: how often, on which weekdays, from which day, at what time and in
 * which time zone. Shared by the forms that set one (a row template's repeat, an agent's
 * schedule); its words are the template dialog's.
 */
export function RepeatRuleFields({ form, onChange, idPrefix }: { form: RepeatForm; onChange: (change: Partial<RepeatForm>) => void; idPrefix: string }) {
  const t = useTranslations("database.page.templates.repeatDialog");
  const locale = useLocale();
  const zoneList = useMemo(() => listTimeZones(form.timeZone), [form.timeZone]);
  const weekdayName = (day: number) =>
    // 2026-10-04 was a Sunday: day 0 of that week.
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 4 + day)));
  const toggleDay = (day: number) =>
    onChange({ weekdays: form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day] });

  const field = "space-y-1";
  const label = "block text-xs font-medium text-fg-muted";
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <label htmlFor={id("frequency")} className={label}>
            {t("frequency")}
          </label>
          <select
            id={id("frequency")}
            className={selectClass}
            value={form.frequency}
            onChange={(e) => {
              const frequency = e.target.value as RepeatFrequency;
              // Weekly needs a day: the first day's weekday, to start with.
              const startDay = new Date(`${form.start}T00:00:00Z`).getUTCDay();
              const weekdays = frequency === "weekly" && !form.weekdays.length ? [Number.isNaN(startDay) ? 1 : startDay] : form.weekdays;
              onChange({ frequency, weekdays });
            }}
          >
            {REPEAT_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {t(`frequencies.${f}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label htmlFor={id("interval")} className={label}>
            {t("every")}
          </label>
          <div className="flex items-center gap-2">
            <div className="w-16 shrink-0">
              <Input
                id={id("interval")}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_REPEAT_INTERVAL}
                value={form.interval}
                onChange={(e) => onChange({ interval: e.target.value })}
              />
            </div>
            <span className="text-sm text-fg-muted">{t(`units.${form.frequency}`, { count: Number(form.interval) || 1 })}</span>
          </div>
        </div>
      </div>

      {form.frequency === "weekly" && (
        <fieldset className={field}>
          <legend className={label}>{t("on")}</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS_FROM_MONDAY.map((day) => {
              const on = form.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleDay(day)}
                  className={cn("h-8 min-w-10 rounded-md border px-2 text-sm", on ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-bg-hover")}
                >
                  {weekdayName(day)}
                </button>
              );
            })}
          </div>
          {!form.weekdays.length && <p className="text-xs text-danger">{t("noWeekday")}</p>}
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <label htmlFor={id("start")} className={label}>
            {t("start")}
          </label>
          <Input id={id("start")} type="date" value={form.start} onChange={(e) => onChange({ start: e.target.value })} />
        </div>
        <div className={field}>
          <label htmlFor={id("time")} className={label}>
            {t("time")}
          </label>
          <Input id={id("time")} type="time" value={form.time} onChange={(e) => onChange({ time: e.target.value })} />
        </div>
      </div>

      <div className={field}>
        <label htmlFor={id("zone")} className={label}>
          {t("timeZone")}
        </label>
        <select id={id("zone")} className={selectClass} value={zoneList.current} onChange={(e) => onChange({ timeZone: e.target.value })}>
          {zoneList.zones.map((zone) => (
            <option key={zone} value={zone}>
              {timeZoneLabel(zone)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
