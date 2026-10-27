"use client";

import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getSheetsSyncAction, stopSheetsSyncAction, syncSheetsNowAction, updateSheetsSyncAction } from "@/app/actions/sheets-sync";
import { Button, Dialog, IconButton, selectClass } from "@/components/ui";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { sheetLink, type SheetsDirection, type SheetsSyncView } from "@/lib/sheets-sync";

/**
 * A synced database's Google Sheets sync: the sheet it reads (with a link to open it), the
 * connection it reads through, the header row, key and title columns, when it last synced and what
 * went wrong (with Google's words for a refused read, for those who may change it), whether it
 * writes back (with the columns it doesn't write, the changes waiting and why writing failed), and,
 * for people with full access to the database, how often, the direction (both ways when they may
 * write through the connection, and only on a schedule), syncing now, another connection, and
 * stopping it. Loaded the first time it opens.
 */
export default function SheetsSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.sheetsSync");
  const tj = useTranslations("database.jiraSync");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<SheetsSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSheetsSyncAction(databaseId).then(
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
              <dt className="text-fg-muted">{t("sheet")}</dt>
              <dd className="min-w-0">
                <a
                  href={sheetLink(sync.spreadsheetId, sync.sheetId)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex max-w-full items-center gap-1 text-accent hover:underline"
                >
                  <span className="truncate">{sync.sheetTitle}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </dd>
              <dt className="text-fg-muted">{ti("sheets.connection")}</dt>
              <dd className="min-w-0">
                {sync.canManage && choices.length > 1 ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("sheets.connection")}
                    value={sync.connectionId}
                    disabled={busy}
                    onChange={(e) => void act(() => updateSheetsSyncAction(databaseId, { connectionId: e.target.value }), setSync)}
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
              <dt className="text-fg-muted">{ti("sheets.headerRow")}</dt>
              <dd>{sync.headerRow}</dd>
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
                    onChange={(e) => void act(() => updateSheetsSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
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
              <dt className="text-fg-muted">{ti("sheets.direction")}</dt>
              <dd>
                {sync.canManage && (sync.canWrite || sync.direction === "both") ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("sheets.direction")}
                    value={sync.direction}
                    disabled={busy}
                    onChange={(e) => void act(() => updateSheetsSyncAction(databaseId, { direction: e.target.value as SheetsDirection }), setSync)}
                  >
                    <option value="read">{ti("sheets.directionRead")}</option>
                    <option value="both" disabled={!sync.canWrite || sync.intervalMinutes === 0}>
                      {ti("sheets.directionBoth")}
                    </option>
                  </select>
                ) : (
                  ti(sync.direction === "both" ? "sheets.directionBoth" : "sheets.directionRead")
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
                {sync.writeError === "forbidden" ? t("writeForbidden") : ti(`sheets.errors.${sync.writeError}`)}
                {sync.writeErrorDetail && <span className="mt-1 block text-xs break-words text-fg-muted">{sync.writeErrorDetail}</span>}
              </p>
            )}
            {sync.lastError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{tj("paused")}:</span>}
                {ti(`sheets.errors.${sync.lastError}`)}
                {sync.lastErrorDetail && <span className="mt-1 block text-xs break-words text-fg-muted">{sync.lastErrorDetail}</span>}
              </p>
            )}
            {sync.direction === "both" ? (
              <div className="space-y-1 text-xs text-fg-muted">
                <p>{ti("sheets.directionBothHelp")}</p>
                {sync.formulaColumns.length > 0 && <p>{t("formulaColumns", { columns: sync.formulaColumns.join(", ") })}</p>}
              </div>
            ) : (
              <p className="text-xs text-fg-muted">{t("overwrite")}</p>
            )}
            {sync.canManage && sync.direction === "read" && !sync.canWrite && <p className="text-xs text-fg-muted">{ti("sheets.directionNoWrite")}</p>}
            {sync.canManage && sync.direction === "read" && sync.canWrite && sync.intervalMinutes === 0 && (
              <p className="text-xs text-fg-muted">{ti("sheets.bothNeedsSchedule")}</p>
            )}

            {sync.canManage ? (
              <>
                {error && (
                  <p role="alert" className="text-sm break-words text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncSheetsNowAction(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {tj("syncNow")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("stopConfirm"))) return;
                      void act(() => stopSheetsSyncAction(databaseId), onClose);
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
