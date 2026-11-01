"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { cn, Input, selectClass, Switch } from "@/components/ui";
import { isDailyChangeLimit, MAX_DAILY_CHANGES, parseQuietHours, type QuietHours } from "@/lib/quiet-hours";
import { browserTimeZone, listTimeZones, timeZoneLabel } from "@/lib/time-zone";

/** The agent form's quiet hours as typed: on or off, and the times and zone kept while off. */
export type QuietHoursDraft = { on: boolean; start: string; end: string; timeZone: string };

/** The form's starting quiet hours: the agent's, else 22:00 to 07:00 on the browser's clock, off. */
export function quietHoursDraft(quiet: QuietHours | null | undefined): QuietHoursDraft {
  return quiet ? { on: true, ...quiet } : { on: false, start: "22:00", end: "07:00", timeZone: browserTimeZone() };
}

/** The draft as the agent takes it: null when off, undefined when it isn't valid. */
export function quietHoursOf(draft: QuietHoursDraft): QuietHours | null | undefined {
  if (!draft.on) return null;
  return parseQuietHours({ start: draft.start, end: draft.end, timeZone: draft.timeZone }) ?? undefined;
}

/** The typed daily limit: null when empty, undefined when it isn't a whole number in range. */
export function dailyLimitOf(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  return isDailyChangeLimit(value) ? value : undefined;
}

/**
 * The agent's guardrails in its form: quiet hours, when calls an owner's rule lets go without
 * asking wait until they end, and the most changes it may make in a day. Only owners set them
 * (`ownersOnly`: the viewer isn't one, and sees them as they are).
 */
export function AgentGuardrailFields({
  quiet,
  onQuiet,
  dailyLimit,
  onDailyLimit,
  disabled,
  ownersOnly = false,
}: {
  quiet: QuietHoursDraft;
  onQuiet: (draft: QuietHoursDraft) => void;
  dailyLimit: string;
  onDailyLimit: (text: string) => void;
  disabled: boolean;
  ownersOnly?: boolean;
}) {
  const t = useTranslations("settings.agents.form");
  const zones = useMemo(() => listTimeZones(quiet.timeZone), [quiet.timeZone]);
  const quietValid = quietHoursOf(quiet) !== undefined;
  const limitValid = dailyLimitOf(dailyLimit) !== undefined;
  return (
    <>
      <div className="space-y-2 border-t border-border pt-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div>{t("quietHours")}</div>
            <div className="text-xs text-fg-muted">{t("quietHoursHelp")}</div>
          </div>
          <Switch checked={quiet.on} label={t("quietHours")} disabled={disabled} onChange={(on) => onQuiet({ ...quiet, on })} />
        </div>
        {quiet.on && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-fg-muted">{t("quietFrom")}</span>
              <Input type="time" value={quiet.start} disabled={disabled} aria-invalid={!quietValid} onChange={(e) => onQuiet({ ...quiet, start: e.target.value })} className="w-28" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-fg-muted">{t("quietTo")}</span>
              <Input type="time" value={quiet.end} disabled={disabled} aria-invalid={!quietValid} onChange={(e) => onQuiet({ ...quiet, end: e.target.value })} className="w-28" />
            </label>
            <select
              value={zones.current}
              aria-label={t("quietTimeZone")}
              disabled={disabled}
              onChange={(e) => onQuiet({ ...quiet, timeZone: e.target.value })}
              className={cn(selectClass, "w-48")}
            >
              {zones.zones.map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </select>
            {!quietValid && <span className="block w-full text-xs text-danger">{t("quietHoursInvalid")}</span>}
          </div>
        )}
      </div>
      <label className="block border-t border-border pt-3">
        <span className="mb-1 block text-sm">{t("dailyChangeLimit")}</span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_DAILY_CHANGES}
          step={1}
          value={dailyLimit}
          placeholder={t("dailyChangeLimitPlaceholder")}
          aria-invalid={!limitValid}
          disabled={disabled}
          onChange={(e) => onDailyLimit(e.target.value)}
          className="w-48"
        />
        <span className={cn("mt-1 block text-xs", limitValid ? "text-fg-muted" : "text-danger")}>
          {limitValid ? t("dailyChangeLimitHelp") : t("dailyChangeLimitInvalid", { max: MAX_DAILY_CHANGES })}
        </span>
        {ownersOnly && <span className="mt-1 block text-xs text-fg-muted">{t("guardrailsOwnersOnly")}</span>}
      </label>
    </>
  );
}
