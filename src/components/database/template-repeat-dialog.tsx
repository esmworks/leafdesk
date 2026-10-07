"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { getTemplateRepeatAction, removeTemplateRepeatAction, setTemplateRepeatAction } from "@/app/actions/templates";
import { Button, cn, Dialog, Input, pageLabel, Switch } from "@/components/ui";
import {
  MAX_REPEAT_INTERVAL,
  nextOccurrence,
  parseRepeatRule,
  REPEAT_FREQUENCIES,
  WEEKDAYS_FROM_MONDAY,
  type RepeatFrequency,
  type ScheduleError,
} from "@/lib/schedule";
import { dayString, isTimeZone, listTimeZones, localDay, timeZoneLabel } from "@/lib/time-zone";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

type Form = {
  frequency: RepeatFrequency;
  interval: string;
  weekdays: number[];
  time: string;
  start: string;
  timeZone: string;
  dateInTitle: boolean;
};

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A new rule: every week on today's weekday, at 09:00, from today, in the browser's time zone. */
function freshForm(): Form {
  const timeZone = browserTimeZone();
  const today = localDay(Date.now(), timeZone);
  return {
    frequency: "weekly",
    interval: "1",
    weekdays: [new Date(today * 86_400_000).getUTCDay()],
    time: "09:00",
    start: dayString(today),
    timeZone,
    dateInTitle: true,
  };
}

/**
 * Sets how a row template repeats: a row is added from it on the rule, in a time zone, as the
 * person who saves it (server/schedules). Shows when it runs next as the form changes, and why it
 * is paused when it is.
 */
export function TemplateRepeatDialog({
  template,
  onClose,
  onChanged,
}: {
  template: { id: string; title: string } | null;
  onClose: () => void;
  /** Refetches the database after the repeat changes. */
  onChanged: () => void;
}) {
  const t = useTranslations("database.page.templates.repeatDialog");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [form, setForm] = useState<Form>(freshForm);
  const [existing, setExisting] = useState<{ lastError: ScheduleError | null; lastRunAt: string | null; enabled: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const templateId = template?.id ?? null;

  useEffect(() => {
    if (!templateId) return;
    let live = true;
    setLoaded(false);
    setError(null);
    void getTemplateRepeatAction(templateId).then((result) => {
      if (!live) return;
      if (!result.ok) setError(result.error);
      else if (result.data) {
        const { rule, timeZone, dateInTitle, lastError, lastRunAt, enabled } = result.data;
        setForm({ ...rule, interval: String(rule.interval), timeZone, dateInTitle });
        setExisting({ lastError, lastRunAt, enabled });
      } else {
        setForm(freshForm());
        setExisting(null);
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [templateId]);

  const rule = useMemo(
    () => parseRepeatRule({ ...form, interval: Number(form.interval), weekdays: form.frequency === "weekly" ? form.weekdays : [] }),
    [form],
  );
  const valid = rule !== null && isTimeZone(form.timeZone);
  const next = useMemo(() => (rule && isTimeZone(form.timeZone) ? nextOccurrence(rule, form.timeZone, new Date()) : null), [rule, form.timeZone]);
  const zoneList = useMemo(() => listTimeZones(form.timeZone), [form.timeZone]);

  const formatAt = (at: Date | string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: form.timeZone }).format(new Date(at));
  const weekdayName = (day: number) =>
    // 2026-10-04 was a Sunday: day 0 of that week.
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 4 + day)));

  const set = (change: Partial<Form>) => setForm((f) => ({ ...f, ...change }));
  const toggleDay = (day: number) =>
    set({ weekdays: form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day] });

  const save = () => {
    if (!templateId || !rule) return;
    setError(null);
    startTransition(async () => {
      const result = await setTemplateRepeatAction(templateId, { rule, timeZone: form.timeZone, dateInTitle: form.dateInTitle });
      if (!result.ok) return setError(result.error);
      onChanged();
      onClose();
    });
  };

  const turnOff = () => {
    if (!templateId) return;
    setError(null);
    startTransition(async () => {
      const result = await removeTemplateRepeatAction(templateId);
      if (!result.ok) return setError(result.error);
      onChanged();
      onClose();
    });
  };

  const field = "space-y-1";
  const label = "block text-xs font-medium text-fg-muted";

  return (
    <Dialog open={template !== null} onClose={onClose} className="max-w-md">
      <form
        className={cn("space-y-4 p-5", (!loaded || pending) && "pointer-events-none opacity-60")}
        aria-busy={!loaded || pending}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("title", { title: pageLabel(template?.title ?? "", tc("untitled")) })}</h2>
          <p className="text-sm text-fg-muted">{t("description")}</p>
        </div>

        {existing && !existing.enabled && existing.lastError && (
          <p role="status" className="rounded-md border border-border bg-bg-hover px-3 py-2 text-sm">
            {t(`paused.${existing.lastError}`)}
          </p>
        )}
        {existing?.enabled && existing.lastError === "failed" && (
          <p role="status" className="rounded-md border border-border bg-bg-hover px-3 py-2 text-sm">
            {t("paused.failed")}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className={field}>
            <label htmlFor="repeat-frequency" className={label}>
              {t("frequency")}
            </label>
            <select
              id="repeat-frequency"
              className={selectClass}
              value={form.frequency}
              onChange={(e) => {
                const frequency = e.target.value as RepeatFrequency;
                // Weekly needs a day: the first day's weekday, to start with.
                const startDay = new Date(`${form.start}T00:00:00Z`).getUTCDay();
                const weekdays = frequency === "weekly" && !form.weekdays.length ? [Number.isNaN(startDay) ? 1 : startDay] : form.weekdays;
                set({ frequency, weekdays });
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
            <label htmlFor="repeat-interval" className={label}>
              {t("every")}
            </label>
            <div className="flex items-center gap-2">
              <div className="w-16 shrink-0">
                <Input
                  id="repeat-interval"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_REPEAT_INTERVAL}
                  value={form.interval}
                  onChange={(e) => set({ interval: e.target.value })}
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
                    className={cn(
                      "h-8 min-w-10 rounded-md border px-2 text-sm",
                      on ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-bg-hover",
                    )}
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
            <label htmlFor="repeat-start" className={label}>
              {t("start")}
            </label>
            <Input id="repeat-start" type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} />
          </div>
          <div className={field}>
            <label htmlFor="repeat-time" className={label}>
              {t("time")}
            </label>
            <Input id="repeat-time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
          </div>
        </div>

        <div className={field}>
          <label htmlFor="repeat-zone" className={label}>
            {t("timeZone")}
          </label>
          <select id="repeat-zone" className={selectClass} value={zoneList.current} onChange={(e) => set({ timeZone: e.target.value })}>
            {zoneList.zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabel(zone)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {t("dateInTitle")}
          </span>
          <Switch checked={form.dateInTitle} onChange={(dateInTitle) => set({ dateInTitle })} label={t("dateInTitle")} />
        </div>

        <div className="space-y-0.5 text-sm text-fg-muted" aria-live="polite">
          {form.frequency === "monthly" && rule && <p>{t("monthlyHint", { day: Number(rule.start.slice(8)) })}</p>}
          {next && <p>{t("next", { date: formatAt(next) })}</p>}
          {existing?.lastRunAt && <p>{t("lastRun", { date: formatAt(existing.lastRunAt) })}</p>}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {existing && (
              <button
                type="button"
                onClick={turnOff}
                className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-danger hover:bg-bg-hover"
              >
                {t("turnOff")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || pending || !loaded}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
