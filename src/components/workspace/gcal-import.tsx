"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { gcalCalendarsAction, gcalSourcesAction } from "@/app/actions/gcal-sync";
import { Input } from "@/components/ui";
import { PRIMARY_CALENDAR, type GcalCalendar, type GcalDirection, type GcalSource } from "@/lib/gcal-sync";
import { ICAL_DAYS_AFTER, ICAL_DAYS_BEFORE } from "@/lib/ical-sync";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a Google Calendar sync up, once a connection and a calendar are chosen. */
export type GcalSetup = {
  connectionId: string;
  calendarId: string;
  intervalMinutes: number;
  direction: GcalDirection;
  title: string;
};

/**
 * The import dialog's Google Calendar tab: the Google Calendar connection to read through (the ones
 * the person may use), the calendar (its account's main one, or another in its list), how often to
 * sync, whether changes made in Leafdesk go back to the calendar (when the person may write through
 * the connection, and only on a schedule), and the database's name and place. The calendar is read
 * when the dialog submits. Tells the dialog the setup (or null while it is incomplete) as it changes.
 */
export function GcalTab({
  workspaceId,
  busy,
  destinationPicker,
  onSetup,
}: {
  workspaceId: string;
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: GcalSetup | null) => void;
}) {
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const [sources, setSources] = useState<GcalSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [calendars, setCalendars] = useState<{ for: string; list: GcalCalendar[] } | null>(null);
  const [calendarId, setCalendarId] = useState(PRIMARY_CALENDAR);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<GcalDirection>("read");

  useEffect(() => {
    let live = true;
    gcalSourcesAction(workspaceId)
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setSources(result.data);
        setConnectionId(result.data[0]?.id ?? "");
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  // The connection's calendars; the main one stays offered while they load or if they can't be listed.
  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    gcalCalendarsAction(workspaceId, connectionId)
      .then((result) => live && setCalendars({ for: connectionId, list: result.ok ? result.data : [] }))
      .catch(() => live && setCalendars({ for: connectionId, list: [] }));
    return () => {
      live = false;
    };
  }, [workspaceId, connectionId]);

  const listed = calendars?.for === connectionId ? calendars.list : [];
  const chosen = calendarId === PRIMARY_CALENDAR || listed.some((c) => c.id === calendarId) ? calendarId : PRIMARY_CALENDAR;
  const canWrite = sources?.find((s) => s.id === connectionId)?.canWrite ?? false;
  // Writing back needs a connection the person may write through, and a schedule.
  const way: GcalDirection = canWrite ? direction : "read";
  const valid = Boolean(connectionId) && (way === "read" || intervalMinutes > 0);
  useEffect(() => {
    onSetup(valid ? { connectionId, calendarId: chosen, intervalMinutes, direction: way, title: name } : null);
  }, [valid, connectionId, chosen, intervalMinutes, way, name, onSetup]);

  const help = t("gcal.help", { before: ICAL_DAYS_BEFORE, after: ICAL_DAYS_AFTER });
  if (sources === null) {
    return error ? (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    ) : (
      <p className="text-sm text-fg-muted">{t("gcal.loading")}</p>
    );
  }
  if (!sources.length) {
    return (
      <div className="space-y-2 text-sm text-fg-muted">
        <p>{help}</p>
        <p className="rounded-lg border border-border px-3 py-2">{t("gcal.noConnection")}</p>
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-fg-muted">{help}</p>
      {sources.length > 1 ? (
        <label className="block">
          <span className={labelClass}>{t("gcal.connection")}</span>
          <select className={selectClass} value={connectionId} disabled={busy} onChange={(e) => setConnectionId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-fg-muted">{t("googleDocs.through", { name: sources[0].name })}</p>
      )}
      <label className="block">
        <span className={labelClass}>{t("gcal.calendar")}</span>
        <select className={selectClass} value={chosen} disabled={busy} onChange={(e) => setCalendarId(e.target.value)}>
          <option value={PRIMARY_CALENDAR}>{t("gcal.primary")}</option>
          {listed.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={t("ical.namePlaceholder")} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.every")}</span>
          <select className={selectClass} value={intervalMinutes} disabled={busy} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
            {JIRA_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes} disabled={way === "both" && minutes === 0}>
                {t(`jira.intervals.${jiraIntervalKey(minutes)}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>{t("gcal.direction")}</span>
          <select
            className={selectClass}
            value={way}
            disabled={busy || !canWrite}
            onChange={(e) => {
              const next = e.target.value as GcalDirection;
              setDirection(next);
              if (next === "both" && intervalMinutes === 0) setIntervalMinutes(DEFAULT_JIRA_INTERVAL);
            }}
          >
            <option value="read">{t("gcal.directionRead")}</option>
            <option value="both">{t("gcal.directionBoth")}</option>
          </select>
        </label>
        {destinationPicker}
      </div>
      {way === "both" ? (
        <p className="text-xs text-fg-muted">{t("gcal.directionBothHelp")}</p>
      ) : (
        !canWrite && <p className="text-xs text-fg-muted">{t("gcal.directionNoWrite")}</p>
      )}
    </>
  );
}
