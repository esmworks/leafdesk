"use client";

import { RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getPostgresSyncAction, stopPostgresSyncAction, syncPostgresNowAction, updatePostgresSyncAction } from "@/app/actions/postgres-sync";
import { Button, Dialog, DialogBody, DialogHeader, Input, selectClass } from "@/components/ui";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import type { PostgresSyncView } from "@/lib/postgres-sync";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/**
 * A synced database's PostgreSQL sync: the server, database and table it reads (never the user or
 * password), the key and title columns, when it last synced and what went wrong (with the server's
 * words for a refused query, for those who may change it), and, for people with full access to
 * the database, how often, syncing now, a new connection address, and stopping it. Loaded the
 * first time it opens.
 */
export default function PostgresSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.postgresSync");
  const tj = useTranslations("database.jiraSync");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<PostgresSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUrl, setEditingUrl] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let live = true;
    getPostgresSyncAction(databaseId).then(
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
      <DialogHeader title={t("title")} onClose={onClose} closeLabel={tc("close")} closeDisabled={busy} />
      <DialogBody className="max-h-[70vh] overflow-y-auto" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{t("server")}</dt>
              <dd className="min-w-0 truncate">
                {sync.host} / {sync.database}
              </dd>
              <dt className="text-fg-muted">{ti("postgres.table")}</dt>
              <dd className="min-w-0 truncate">{sync.table}</dd>
              <dt className="text-fg-muted">{ti("postgres.key")}</dt>
              <dd className="min-w-0 truncate">{sync.keyColumn}</dd>
              <dt className="text-fg-muted">{ti("postgres.titleColumn")}</dt>
              <dd className="min-w-0 truncate">{sync.titleColumn}</dd>
              <dt className="text-fg-muted">{ti("jira.every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("jira.every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => updatePostgresSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
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
                {ti(`postgres.errors.${sync.lastError}`)}
                {sync.lastErrorDetail && <span className="mt-1 block font-mono text-xs break-words text-fg-muted">{sync.lastErrorDetail}</span>}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t("overwrite")}</p>

            {sync.canManage ? (
              <>
                {editingUrl && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <label className="block">
                      <span className={labelClass}>{ti("postgres.url")}</span>
                      <Input type="password" value={url} autoComplete="off" placeholder={ti("postgres.urlPlaceholder")} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingUrl(false)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!url.trim()}
                        onClick={() =>
                          void act(() => updatePostgresSyncAction(databaseId, { url }), (next) => (setSync(next), setEditingUrl(false), setUrl("")))
                        }
                      >
                        {tj("save")}
                      </Button>
                    </div>
                  </fieldset>
                )}
                {error && (
                  <p role="alert" className="text-sm break-words text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncPostgresNowAction(databaseId), setSync)}>
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
                      void act(() => stopPostgresSyncAction(databaseId), onClose);
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
