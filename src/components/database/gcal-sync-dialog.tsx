"use client";

import { RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getGcalSyncAction, stopGcalSyncAction, syncGcalNowAction, updateGcalSyncAction } from "@/app/actions/gcal-sync";
import { Button, Dialog, DialogBody, DialogHeader, selectClass } from "@/components/ui";
import { PRIMARY_CALENDAR, type GcalDirection, type GcalSyncView } from "@/lib/gcal-sync";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

/**
 * A synced database's Google Calendar sync: the calendar it reads, the connection it reads through,
 * when it last synced and what went wrong (with Google's words for a refusal, for those who may
 * change it), whether it writes back (with the changes waiting and why writing failed), and, for
 * people with full access to the database, how often, the direction (both ways when they may write
 * through the connection, and only on a schedule), syncing now, another connection, and stopping
 * it. Loaded the first time it opens.
 */
export default function GcalSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.gcalSync");
  const tj = useTranslations("database.jiraSync");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<GcalSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getGcalSyncAction(databaseId).then(
      (result) => live && (result.ok ? setSync(result.data) : (setSync(null), setError(result.error))),
      () => live && (setSync(null), setError(tc("genericError"))),
    );
    return () => {
      live = false;
    };
  }, [databaseId, tc]);

  async function act<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (data: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) return setError(result.error);
      done?.(result.data);
      onChanged();
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  // The connection it reads through, offered beside the others the viewer may use.
  const choices =
    sync && sync !== "loading" && !sync.choices.some((c) => c.id === sync.connectionId)
      ? [{ id: sync.connectionId, name: sync.connection ?? t("connectionGone") }, ...sync.choices]
      : sync && sync !== "loading"
        ? sync.choices
        : [];

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <DialogHeader title={t("title")} onClose={onClose} closeLabel={tc("close")} closeDisabled={busy} />
      <DialogBody className="max-h-[70vh] overflow-y-auto" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{ti("gcal.calendar")}</dt>
              <dd className="min-w-0 truncate">{sync.calendarName || (sync.calendarId === PRIMARY_CALENDAR ? ti("gcal.primary") : sync.calendarId)}</dd>
              <dt className="text-fg-muted">{ti("gcal.connection")}</dt>
              <dd className="min-w-0">
                {sync.canManage && choices.length > 1 ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("gcal.connection")}
                    value={sync.connectionId}
                    disabled={busy}
                    onChange={(e) => void act(() => updateGcalSyncAction(databaseId, { connectionId: e.target.value }), setSync)}
                  >
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="block truncate">{sync.connection ?? t("connectionGone")}</span>
                )}
              </dd>
              <dt className="text-fg-muted">{ti("jira.every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("jira.every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => updateGcalSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
                  >
                    {JIRA_INTERVALS.map((minutes) => (
                      <option key={minutes} value={minutes} disabled={sync.direction === "both" && minutes === 0}>
                        {ti(`jira.intervals.${jiraIntervalKey(minutes)}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  ti(`jira.intervals.${jiraIntervalKey(sync.intervalMinutes)}`)
                )}
              </dd>
              <dt className="text-fg-muted">{ti("gcal.direction")}</dt>
              <dd>
                {sync.canManage && (sync.canWrite || sync.direction === "both") ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("gcal.direction")}
                    value={sync.direction}
                    disabled={busy}
                    onChange={(e) => void act(() => updateGcalSyncAction(databaseId, { direction: e.target.value as GcalDirection }), setSync)}
                  >
                    <option value="read">{ti("gcal.directionRead")}</option>
                    <option value="both" disabled={!sync.canWrite || sync.intervalMinutes === 0}>
                      {ti("gcal.directionBoth")}
                    </option>
                  </select>
                ) : (
                  ti(sync.direction === "both" ? "gcal.directionBoth" : "gcal.directionRead")
                )}
              </dd>
            </dl>
            <p className="text-sm">
              {busy || sync.running
                ? tj("running")
                : sync.lastRunAt
                  ? t("lastRun", { when: format.relativeTime(new Date(sync.lastRunAt), new Date()), count: sync.lastCount ?? 0 })
                  : tj("never")}
            </p>
            {sync.direction === "both" && sync.pendingWrites > 0 && <p className="text-sm">{t("pending", { count: sync.pendingWrites })}</p>}
            {sync.direction === "both" && sync.writeError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                <span className="me-1.5 font-medium text-danger">{t("writeFailed")}</span>
                {sync.writeError === "forbidden" ? t("writeForbidden") : ti(`gcal.errors.${sync.writeError}`)}
                {sync.writeErrorDetail && <span className="mt-1 block text-xs break-words text-fg-muted">{sync.writeErrorDetail}</span>}
              </p>
            )}
            {sync.lastError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{tj("paused")}:</span>}
                {ti(`gcal.errors.${sync.lastError}`)}
                {sync.lastErrorDetail && <span className="mt-1 block text-xs break-words text-fg-muted">{sync.lastErrorDetail}</span>}
              </p>
            )}
            <p className="text-xs text-fg-muted">{sync.direction === "both" ? ti("gcal.directionBothHelp") : t("overwrite")}</p>
            {sync.canManage && sync.direction === "read" && !sync.canWrite && <p className="text-xs text-fg-muted">{ti("gcal.directionNoWrite")}</p>}
            {sync.canManage && sync.direction === "read" && sync.canWrite && sync.intervalMinutes === 0 && (
              <p className="text-xs text-fg-muted">{ti("gcal.bothNeedsSchedule")}</p>
            )}

            {sync.canManage ? (
              <>
                {error && (
                  <p role="alert" className="text-sm break-words text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncGcalNowAction(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {tj("syncNow")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("stopConfirm"))) return;
                      void act(() => stopGcalSyncAction(databaseId), onClose);
                    }}
                  >
                    {tj("stop")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-fg-muted">{tj("viewOnly")}</p>
            )}
          </>
        )}
        {(!sync || sync === "loading") && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}
