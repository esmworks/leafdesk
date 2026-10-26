"use client";

import { RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getIcalSyncAction, stopIcalSyncAction, syncIcalNowAction, updateIcalSyncAction } from "@/app/actions/ical-sync";
import { Button, Dialog, IconButton, Input, selectClass } from "@/components/ui";
import type { IcalSyncView } from "@/lib/ical-sync";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/**
 * A synced database's calendar sync: the calendar's host (never its address, which can be its
 * key), when it last synced and what went wrong, and, for people with full access to the database,
 * how often, syncing now, a new address, and stopping it. Loaded the first time it opens.
 */
export default function IcalSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.icalSync");
  const tj = useTranslations("database.jiraSync");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<IcalSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUrl, setEditingUrl] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let live = true;
    getIcalSyncAction(databaseId).then(
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

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <IconButton label={tc("close")} onClick={onClose} disabled={busy}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{t("calendar")}</dt>
              <dd className="min-w-0 truncate">{sync.host}</dd>
              <dt className="text-fg-muted">{ti("jira.every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("jira.every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => updateIcalSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
                  >
                    {JIRA_INTERVALS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {ti(`jira.intervals.${jiraIntervalKey(minutes)}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  ti(`jira.intervals.${jiraIntervalKey(sync.intervalMinutes)}`)
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
            {sync.lastError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{tj("paused")}:</span>}
                {ti(`ical.errors.${sync.lastError}`)}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t("overwrite")}</p>

            {sync.canManage ? (
              <>
                {editingUrl && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <label className="block">
                      <span className={labelClass}>{ti("ical.url")}</span>
                      <Input type="password" value={url} autoComplete="off" placeholder={ti("ical.urlPlaceholder")} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingUrl(false)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!url.trim()}
                        onClick={() => void act(() => updateIcalSyncAction(databaseId, { url }), (next) => (setSync(next), setEditingUrl(false), setUrl("")))}
                      >
                        {tj("save")}
                      </Button>
                    </div>
                  </fieldset>
                )}
                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncIcalNowAction(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {tj("syncNow")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditingUrl(!editingUrl);
                      setError(null);
                    }}
                  >
                    {t("changeUrl")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("stopConfirm"))) return;
                      void act(() => stopIcalSyncAction(databaseId), onClose);
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
      </div>
    </Dialog>
  );
}
