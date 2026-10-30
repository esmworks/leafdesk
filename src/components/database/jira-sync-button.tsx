"use client";

import { RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseSyncSummary } from "@/lib/jira-sync";

const JiraSyncDialog = dynamic(() => import("./jira-sync-dialog"));
const GithubPullsSyncDialog = dynamic(() => import("./github-pulls-sync-dialog"));
const IcalSyncDialog = dynamic(() => import("./ical-sync-dialog"));
const PostgresSyncDialog = dynamic(() => import("./postgres-sync-dialog"));
const SheetsSyncDialog = dynamic(() => import("./sheets-sync-dialog"));
const GcalSyncDialog = dynamic(() => import("./gcal-sync-dialog"));
const SyncWriteStatus = dynamic(() => import("./sync-write-status"));

const DIALOGS = { jira: JiraSyncDialog, github: GithubPullsSyncDialog, ical: IcalSyncDialog, postgres: PostgresSyncDialog, sheets: SheetsSyncDialog, gcal: GcalSyncDialog };
/** The texts of each source's button, under `database`. */
const SOURCE_TEXTS = { jira: "jiraSync", github: "githubPulls", ical: "icalSync", postgres: "postgresSync", sheets: "sheetsSync", gcal: "gcalSync" } as const;

/**
 * Shows that a database is synced from Jira, GitHub, a calendar, PostgreSQL, Google Sheets or
 * Google Calendar (with a mark when the sync is paused or its last run failed), and opens the
 * sync's dialog. A Google Sheets or Google Calendar sync that writes back also shows the rows
 * waiting to be written, with Write now for those who may run it, or that writing failed.
 */
export function JiraSyncButton({ databaseId, sync, onChanged }: { databaseId: string; sync: DatabaseSyncSummary; onChanged: () => void }) {
  const t = useTranslations("database");
  const [open, setOpen] = useState(false);
  const texts = SOURCE_TEXTS[sync.source];
  const label = sync.enabled ? t(`${texts}.button`) : t(`${texts}.buttonPaused`);
  const Sync = DIALOGS[sync.source];
  const writing = sync.writing;
  return (
    <>
      {writing && writing.pending > 0 && (
        <SyncWriteStatus databaseId={databaseId} status={writing} onOpenDialog={() => setOpen(true)} onChanged={onChanged} />
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
