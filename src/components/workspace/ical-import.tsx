"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui";
import { ICAL_DAYS_AFTER, ICAL_DAYS_BEFORE, icalUrl } from "@/lib/ical-sync";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a calendar sync up, once an address is typed. */
export type IcalSetup = { url: string; intervalMinutes: number; title: string };

/**
 * The import dialog's calendar tab: the calendar's address (an .ics or webcal link), how often to
 * sync, and the database's name and place. The calendar is read when the dialog submits. Tells
 * the dialog the setup (or null while no address is typed) as it changes.
 */
export function IcalTab({ busy, destinationPicker, onSetup }: { busy: boolean; destinationPicker: React.ReactNode; onSetup: (setup: IcalSetup | null) => void }) {
  const t = useTranslations("import");
  const [url, setUrl] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  const valid = icalUrl(url) !== null;
  useEffect(() => {
    onSetup(valid ? { url: url.trim(), intervalMinutes, title: name } : null);
  }, [valid, url, intervalMinutes, name, onSetup]);

  return (
    <>
      <p className="text-sm text-fg-muted">{t("ical.help", { before: ICAL_DAYS_BEFORE, after: ICAL_DAYS_AFTER })}</p>
      <label className="block">
        <span className={labelClass}>{t("ical.url")}</span>
        <Input type="password" value={url} placeholder={t("ical.urlPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="text-xs text-fg-muted">{t("ical.urlHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={t("ical.namePlaceholder")} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.every")}</span>
          <select className={selectClass} value={intervalMinutes} disabled={busy} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
            {JIRA_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t(`jira.intervals.${jiraIntervalKey(minutes)}`)}
              </option>
            ))}
          </select>
        </label>
        {destinationPicker}
      </div>
    </>
  );
}
