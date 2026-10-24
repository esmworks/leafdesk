"use client";

import { RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseSyncSummary } from "@/lib/jira-sync";

const JiraSyncDialog = dynamic(() => import("./jira-sync-dialog"));

/**
 * Shows that a database is synced from Jira (with a mark when the sync is paused or its last run
 * failed), and opens the sync's dialog.
 */
export function JiraSyncButton({ databaseId, sync, onChanged }: { databaseId: string; sync: DatabaseSyncSummary; onChanged: () => void }) {
  const t = useTranslations("database.jiraSync");
  const [open, setOpen] = useState(false);
  const label = sync.enabled ? t("button") : t("buttonPaused");
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
        createPortal(<JiraSyncDialog databaseId={databaseId} onClose={() => setOpen(false)} onChanged={onChanged} />, document.body)}
    </>
  );
}
