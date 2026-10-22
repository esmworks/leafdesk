"use client";

import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { previewDatePassedAction, rotateAutomationHookAction } from "@/app/actions/automations";
import { copyText } from "@/components/settings/copy-button";
import { Button, cn, IconButton, Input, textareaClass } from "@/components/ui";
import { MAX_CRON_LENGTH } from "@/lib/automation-schedule";
import { DATE_PASSED_BATCH, INCOMING_PER_MINUTE, MAX_DATE_PASSED_DAYS, MAX_EXAMPLE_PAYLOAD, TO_VALUE_TYPES } from "@/lib/automations";
import { STATUS_GROUPS } from "@/lib/property-types";
import { browserTimeZone, timeZoneLabel } from "@/lib/time-zone";
import {
  canWatch,
  defaultSchedule,
  draftDays,
  nextRun,
  optionsOf,
  parseJson,
  TRIGGER_CHOICES,
  triggerInput,
  type Automation,
  type DraftSchedule,
  type DraftTrigger,
  type Person,
} from "./automations-shared";
import { selectClass } from "./automations-values";
import { PropertyTypeIcon } from "./property-icons";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

/**
 * What starts an automation: a row added, properties changing (to a value), a date passing, a
 * schedule, or a request to the automation's own address.
 */
export function TriggerEditor({
  trigger,
  people,
  saved,
  onChange,
  onUpdated,
}: {
  trigger: DraftTrigger;
  people: Person[];
  /** The automation as saved, for an incoming webhook's address. */
  saved: Automation | null;
  onChange: (trigger: DraftTrigger) => void;
  onUpdated: (automation: Automation) => void;
}) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const dates = properties.filter((p) => p.type === "date");
  const statuses = properties.filter((p) => p.type === "status");

  return (
    <div className="space-y-2">
      <select
        value={trigger.type}
        aria-label={t("form.when")}
        onChange={(e) => {
          const type = e.target.value as DraftTrigger["type"];
          onChange(
            type === "row_created"
              ? { type }
              : type === "date_passed"
                ? { type, date: dates[0]?.id ?? "", days: "0", status: null }
                : type === "schedule"
                  ? { type, schedule: defaultSchedule() }
                  : type === "incoming_webhook"
                    ? { type, example: "" }
                    : { type: "property_changed", properties: [] },
          );
        }}
        className={selectClass}
      >
        {TRIGGER_CHOICES.map((type) => (
          <option key={type} value={type}>
            {t(`form.triggerType.${type}`)}
          </option>
        ))}
      </select>
      {trigger.type === "date_passed" && <DatePassedEditor trigger={trigger} dates={dates} statuses={statuses} onChange={onChange} />}
      {trigger.type === "property_changed" && <PropertyChangedEditor trigger={trigger} people={people} onChange={onChange} />}
      {trigger.type === "schedule" && <ScheduleEditor schedule={trigger.schedule} onChange={(schedule) => onChange({ type: "schedule", schedule })} />}
      {trigger.type === "incoming_webhook" && (
        <IncomingWebhookEditor trigger={trigger} saved={saved} onChange={onChange} onUpdated={onUpdated} />
      )}
    </div>
  );
}

/** The properties to watch (none: any), and with one, optionally the value it becomes. */
function PropertyChangedEditor({
  trigger,
  people,
  onChange,
}: {
  trigger: Extract<DraftTrigger, { type: "property_changed" }>;
  people: Person[];
  onChange: (trigger: DraftTrigger) => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const properties = useSchema();
  const watchable = properties.filter((p) => canWatch(p) && !trigger.properties.includes(p.id));
  const only = trigger.properties.length === 1 ? properties.find((p) => p.id === trigger.properties[0]) : undefined;
  const takesValue = !!only && (TO_VALUE_TYPES as readonly string[]).includes(only.type);
  const set = (ids: string[]) => onChange({ type: "property_changed", properties: ids });

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 flex-wrap items-center gap-1">
        {!trigger.properties.length && <span className="px-1 text-sm text-fg-muted">{t("form.anyProperty")}</span>}
        {trigger.properties.map((id) => {
          const prop = properties.find((p) => p.id === id);
          return (
            <span key={id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border ps-2 pe-1 text-sm">
              {prop && <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
              <span className="max-w-40 truncate">{prop?.name ?? t("deletedProperty")}</span>
              <IconButton label={`${tc("remove")}: ${prop?.name ?? ""}`} onClick={() => set(trigger.properties.filter((x) => x !== id))} className="h-5 w-5">
                <X className="h-3 w-3" />
              </IconButton>
            </span>
          );
        })}
        {watchable.length > 0 && (
          <select
            value=""
            aria-label={t("form.watchProperty")}
            onChange={(e) => e.target.value && set([...trigger.properties, e.target.value])}
            className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
          >
            <option value="">+ {t("form.watchProperty")}</option>
            {watchable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {takesValue && only && (
        <select
          value={trigger.to === undefined ? "" : String(trigger.to)}
          aria-label={t("form.becomes")}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...trigger, ...(v === "" ? { to: undefined } : { to: only.type === "checkbox" ? v === "true" : v }) });
          }}
          className={selectClass}
        >
          <option value="">{t("form.anyValue")}</option>
          {only.type === "checkbox" ? (
            <>
              <option value="true">{t("form.becomesValue", { value: t("checked") })}</option>
              <option value="false">{t("form.becomesValue", { value: t("unchecked") })}</option>
            </>
          ) : only.type === "person" ? (
            people.map((p) => (
              <option key={p.id} value={p.id}>
                {t("form.becomesValue", { value: p.name || p.email || "?" })}
              </option>
            ))
          ) : (
            optionsOf(only).map((o) => (
              <option key={o.id} value={o.id}>
                {t("form.becomesValue", { value: o.name })}
              </option>
            ))
          )}
        </select>
      )}
      {trigger.properties.length > 1 && <p className="text-xs text-fg-faint">{t("form.severalHelp")}</p>}
    </div>
  );
}

/**
 * "A date passes": the date to count from (a date property, or when the row was added or last
 * edited), how many days after, and optionally the status groups rows must be in.
 */
function DatePassedEditor({
  trigger,
  dates,
  statuses,
  onChange,
}: {
  trigger: Extract<DraftTrigger, { type: "date_passed" }>;
  dates: Property[];
  statuses: Property[];
  onChange: (trigger: DraftTrigger) => void;
}) {
  const t = useTranslations("database.automations");
  const tGroup = useTranslations("database.statusGroups");
  const set = (patch: Partial<Extract<DraftTrigger, { type: "date_passed" }>>) => onChange({ ...trigger, ...patch });
  const known = trigger.date === "created_time" || trigger.date === "last_edited_time" || dates.some((p) => p.id === trigger.date);
  const status = trigger.status;
  const statusGone = status && !statuses.some((p) => p.id === status.property);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-xs text-fg-muted">{t("form.date")}</span>
          <select value={trigger.date} onChange={(e) => set({ date: e.target.value })} className={selectClass}>
            {!trigger.date && <option value="">{t("form.chooseDate")}</option>}
            {dates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="created_time">{t("form.dateCreated")}</option>
            <option value="last_edited_time">{t("form.dateEdited")}</option>
            {trigger.date && !known && <option value={trigger.date}>{t("deletedProperty")}</option>}
          </select>
        </label>
        <label className="block sm:w-32">
          <span className="mb-1 block text-xs text-fg-muted">{t("form.days")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_DATE_PASSED_DAYS}
            step={1}
            value={trigger.days}
            onChange={(e) => set({ days: e.target.value })}
          />
        </label>
      </div>
      <p className="text-xs text-fg-faint">{t("form.daysHelp")}</p>
      {(statuses.length > 0 || status) && (
        <div className="space-y-2 border-t border-border pt-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!status}
              onChange={(e) =>
                set({ status: e.target.checked ? { property: statuses[0]?.id ?? "", groups: ["todo", "in_progress"] } : null })
              }
              className="h-4 w-4 accent-accent"
            />
            {t("form.statusCondition")}
          </label>
          {status && (
            <div className="flex flex-col gap-2 ps-6 sm:flex-row sm:items-center">
              {(statuses.length > 1 || statusGone) && (
                <select
                  value={status.property}
                  aria-label={t("form.statusProperty")}
                  onChange={(e) => set({ status: { ...status, property: e.target.value } })}
                  className={cn(selectClass, "sm:w-44")}
                >
                  {statuses.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {statusGone && <option value={status.property}>{t("deletedProperty")}</option>}
                </select>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {STATUS_GROUPS.map((group) => (
                  <label key={group} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={status.groups.includes(group)}
                      onChange={(e) =>
                        set({
                          status: {
                            ...status,
                            groups: STATUS_GROUPS.filter((g) => (g === group ? e.target.checked : status.groups.includes(g))),
                          },
                        })
                      }
                      className="h-4 w-4 accent-accent"
                    />
                    {tGroup(group)}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-fg-faint">{t("form.datePassedHelp")}</p>
    </div>
  );
}

/**
 * How many rows the trigger as edited would run for at the next check, so nobody is surprised by
 * a burst of runs for rows that already match.
 */
export function DatePassedPreview({
  databaseId,
  automationId,
  trigger,
}: {
  databaseId: string;
  automationId: string | null;
  trigger: Extract<DraftTrigger, { type: "date_passed" }>;
}) {
  const t = useTranslations("database.automations");
  const [count, setCount] = useState<number | null>(null);
  const ready =
    !!trigger.date && draftDays(trigger.days) !== null && (!trigger.status || (!!trigger.status.property && trigger.status.groups.length > 0));
  const key = JSON.stringify(triggerInput(trigger));
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = setTimeout(() => {
      previewDatePassedAction(databaseId, JSON.parse(key), automationId, browserTimeZone())
        .then((res) => live && setCount(res.ok ? res.data : null))
        .catch(() => live && setCount(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [databaseId, automationId, key, ready]);
  if (!ready || count === null) return null;
  return (
    <p className="mt-2 text-xs text-fg-muted" role="status">
      {t("form.matchNow", { count, max: DATE_PASSED_BATCH })}
    </p>
  );
}

/** Weekday numbers (0 = Sunday) in the order the locale's week runs. */
function weekOrder(locale: string) {
  let first = 1;
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1;
  } catch {
    // An unknown locale's week starts on Monday.
  }
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/** Every day, some weekdays, some days of the month at a time, or a cron expression; in the saver's time zone. */
function ScheduleEditor({ schedule, onChange }: { schedule: DraftSchedule; onChange: (schedule: DraftSchedule) => void }) {
  const t = useTranslations("database.automations.schedule");
  const locale = useLocale();
  const format = useFormatter();
  const set = (patch: Partial<DraftSchedule>) => onChange({ ...schedule, ...patch });
  const toggle = (list: number[], n: number) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n]);
  // January 4, 2026 is a Sunday: day n of that week names weekday n.
  const weekdayName = (n: number) => format.dateTime(new Date(Date.UTC(2026, 0, 4 + n, 12)), { weekday: "short", timeZone: "UTC" });
  const next = nextRun(schedule);
  const toggleClass = (on: boolean) =>
    cn(
      "inline-flex h-7 items-center justify-center rounded-md border text-sm transition-colors",
      on ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-bg-hover",
    );

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-xs text-fg-muted">{t("frequency")}</span>
          <select
            value={schedule.frequency}
            onChange={(e) => set({ frequency: e.target.value as DraftSchedule["frequency"] })}
            className={selectClass}
          >
            <option value="daily">{t("daily")}</option>
            <option value="weekly">{t("weekly")}</option>
            <option value="monthly">{t("monthly")}</option>
            <option value="cron">{t("cron")}</option>
          </select>
        </label>
        {schedule.frequency !== "cron" && (
          <label className="block sm:w-36">
            <span className="mb-1 block text-xs text-fg-muted">{t("time")}</span>
            <Input type="time" value={schedule.time} onChange={(e) => set({ time: e.target.value })} className="[color-scheme:light_dark]" />
          </label>
        )}
      </div>
      {schedule.frequency === "weekly" && (
        <div role="group" aria-label={t("weekdays")}>
          <span className="mb-1 block text-xs text-fg-muted">{t("weekdays")}</span>
          <div className="grid grid-cols-7 gap-1">
            {weekOrder(locale).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={schedule.weekdays.includes(n)}
                onClick={() => set({ weekdays: toggle(schedule.weekdays, n) })}
                className={toggleClass(schedule.weekdays.includes(n))}
              >
                {weekdayName(n)}
              </button>
            ))}
          </div>
        </div>
      )}
      {schedule.frequency === "monthly" && (
        <div role="group" aria-label={t("days")}>
          <span className="mb-1 block text-xs text-fg-muted">{t("days")}</span>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={schedule.days.includes(n)}
                onClick={() => set({ days: toggle(schedule.days, n) })}
                className={cn(toggleClass(schedule.days.includes(n)), "tabular-nums")}
              >
                {format.number(n)}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t("daysHelp")}</p>
        </div>
      )}
      {schedule.frequency === "cron" && (
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("cronExpression")}</span>
          <Input
            value={schedule.cron}
            dir="ltr"
            maxLength={MAX_CRON_LENGTH}
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            onChange={(e) => set({ cron: e.target.value })}
          />
          <span className="mt-1 block text-xs text-fg-faint">{t("cronHelp")}</span>
        </label>
      )}
      <p className={cn("text-xs", next ? "text-fg-muted" : "text-danger")} role="status">
        {next
          ? t("nextRun", { time: format.dateTime(next, { dateStyle: "full", timeStyle: "short" }) })
          : schedule.frequency === "cron"
            ? t("invalidCron")
            : t("invalid")}
      </p>
      <p className="text-xs text-fg-faint">{t("zoneHelp", { zone: timeZoneLabel(browserTimeZone()) })}</p>
    </div>
  );
}

/** An incoming webhook: its secret address (once saved), a new one, and an example body. */
function IncomingWebhookEditor({
  trigger,
  saved,
  onChange,
  onUpdated,
}: {
  trigger: Extract<DraftTrigger, { type: "incoming_webhook" }>;
  saved: Automation | null;
  onChange: (trigger: DraftTrigger) => void;
  onUpdated: (automation: Automation) => void;
}) {
  const t = useTranslations("database.automations.incoming");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const example = parseJson(trigger.example);
  const url = saved?.hookUrl ?? null;

  const rotate = async () => {
    if (!saved || !confirm(t("confirmRotate"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rotateAutomationHookAction(saved.id);
      if (res.ok) onUpdated(res.data);
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div>
        <span className="mb-1 block text-xs text-fg-muted">{t("address")}</span>
        {url ? (
          <>
            <div className="flex items-center gap-1.5">
              <Input readOnly value={url} dir="ltr" aria-label={t("address")} onFocus={(e) => e.currentTarget.select()} className="text-xs" />
              <Button
                size="sm"
                className="shrink-0"
                onClick={async (e) => {
                  if (await copyText(url, e.currentTarget)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? tc("copied") : tc("copy")}
              </Button>
              <Button size="sm" className="shrink-0" disabled={busy} onClick={() => void rotate()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("rotate")}
              </Button>
            </div>
            {error && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {error}
              </p>
            )}
            {saved && saved.version < 1 && <p className="mt-1 text-xs text-fg-faint">{t("notLive")}</p>}
          </>
        ) : (
          <p className="text-xs text-fg-muted">{t("saveFirst")}</p>
        )}
        <p className="mt-1 text-xs text-fg-faint">{t("help", { max: INCOMING_PER_MINUTE })}</p>
      </div>
      <label className="block">
        <span className="mb-1 flex items-baseline justify-between gap-2 text-xs text-fg-muted">
          {t("example")}
          <span className="tabular-nums text-fg-faint">
            {trigger.example.length} / {MAX_EXAMPLE_PAYLOAD}
          </span>
        </span>
        <textarea
          rows={5}
          dir="ltr"
          spellCheck={false}
          value={trigger.example}
          maxLength={MAX_EXAMPLE_PAYLOAD}
          placeholder={'{\n  "email": "ada@example.com",\n  "plan": "pro"\n}'}
          onChange={(e) => onChange({ ...trigger, example: e.target.value })}
          className={cn(textareaClass, "text-xs", !example.ok && "border-danger focus:border-danger")}
        />
        <span className={cn("mt-1 block text-xs", example.ok ? "text-fg-faint" : "text-danger")}>
          {example.ok ? t("exampleHelp") : t("exampleInvalid")}
        </span>
      </label>
    </div>
  );
}
