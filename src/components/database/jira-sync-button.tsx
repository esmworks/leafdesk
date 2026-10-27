"use client";

import { CloudAlert, CloudUpload, RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import { syncSheetsNowAction } from "@/app/actions/sheets-sync";
import type { DatabaseSyncSummary } from "@/lib/jira-sync";

const JiraSyncDialog = dynamic(() => import("./jira-sync-dialog"));
const GithubPullsSyncDialog = dynamic(() => import("./github-pulls-sync-dialog"));
const IcalSyncDialog = dynamic(() => import("./ical-sync-dialog"));
const PostgresSyncDialog = dynamic(() => import("./postgres-sync-dialog"));
const SheetsSyncDialog = dynamic(() => import("./sheets-sync-dialog"));

const DIALOGS = { jira: JiraSyncDialog, github: GithubPullsSyncDialog, ical: IcalSyncDialog, postgres: PostgresSyncDialog, sheets: SheetsSyncDialog };
/** The texts of each source's button, under `database`. */
const SOURCE_TEXTS = { jira: "jiraSync", github: "githubPulls", ical: "icalSync", postgres: "postgresSync", sheets: "sheetsSync" } as const;

/**
 * Shows that a database is synced from Jira, GitHub, a calendar, PostgreSQL or Google Sheets (with a mark when the
 * sync is paused or its last run failed), and opens the sync's dialog. A Google Sheets sync that
 * writes back also shows the rows waiting for the sheet, with Write now for those who may run it,
 * or that writing failed.
 */
export function JiraSyncButton({ databaseId, sync, onChanged }: { databaseId: string; sync: DatabaseSyncSummary; onChanged: () => void }) {
  const t = useTranslations("database");
  const [open, setOpen] = useState(false);
  const texts = SOURCE_TEXTS[sync.source];
  const label = sync.enabled ? t(`${texts}.button`) : t(`${texts}.buttonPaused`);
  const Sync = DIALOGS[sync.source];
  const [writing, setWriting] = useState(false);
  const waiting = sync.writing?.pending ?? 0;
  const writeNow = async () => {
    setWriting(true);
    const res = await syncSheetsNowAction(databaseId).catch(() => null);
    setWriting(false);
    // The dialog says why it didn't go.
    if (!res?.ok || res.data.outcome.error) setOpen(true);
    onChanged();
  };
  return (
    <>
      {waiting > 0 && sync.writing?.failed && (
        <button
          type="button"
          title={t("sheetsSync.writeStuckHelp")}
          aria-label={t("sheetsSync.writeStuck")}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-danger hover:bg-bg-hover"
        >
          <CloudAlert className="h-4 w-4" />
          <span className="hidden xl:inline">{t("sheetsSync.writeStuck")}</span>
        </button>
      )}
      {waiting > 0 && !sync.writing?.failed && (
        <span className="inline-flex h-7 shrink-0 items-center gap-1 ps-1.5 text-sm whitespace-nowrap text-fg-muted" title={t("sheetsSync.waitingHelp")}>
          <CloudUpload className="h-4 w-4" />
          <span className="sr-only xl:not-sr-only">{t("sheetsSync.waiting", { count: waiting })}</span>
          <span className="xl:hidden" aria-hidden>
            {waiting}
          </span>
          {sync.writing?.canWriteNow && (
            <button
              type="button"
              disabled={writing}
              onClick={() => void writeNow()}
              className="ms-0.5 h-7 rounded-md px-1.5 font-medium whitespace-nowrap text-accent hover:bg-bg-hover disabled:opacity-60"
            >
              {writing ? t("sheetsSync.writingNow") : t("sheetsSync.writeNow")}
            </button>
          )}
        </span>
      )}
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="relative inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <RefreshCw className="h-4 w-4" />
        {(sync.lastError || !sync.enabled) && <span aria-hidden className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(<Sync databaseId={databaseId} onClose={() => setOpen(false)} onChanged={onChanged} />, document.body)}
    </>
  );
}
