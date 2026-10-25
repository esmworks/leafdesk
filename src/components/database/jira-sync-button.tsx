"use client";

import { RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseSyncSummary } from "@/lib/jira-sync";

const JiraSyncDialog = dynamic(() => import("./jira-sync-dialog"));
const GithubPullsSyncDialog = dynamic(() => import("./github-pulls-sync-dialog"));

/**
 * Shows that a database is synced from Jira or GitHub (with a mark when the sync is paused or its
 * last run failed), and opens the sync's dialog.
 */
export function JiraSyncButton({ databaseId, sync, onChanged }: { databaseId: string; sync: DatabaseSyncSummary; onChanged: () => void }) {
  const t = useTranslations("database.jiraSync");
  const tg = useTranslations("database.githubPulls");
  const [open, setOpen] = useState(false);
  const github = sync.source === "github";
  const label = sync.enabled ? (github ? tg("button") : t("button")) : github ? tg("buttonPaused") : t("buttonPaused");
  const Sync = github ? GithubPullsSyncDialog : JiraSyncDialog;
  return (
    <>
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
