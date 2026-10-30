"use client";

import { CloudAlert, CloudUpload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { syncGcalNowAction } from "@/app/actions/gcal-sync";
import { syncSheetsNowAction } from "@/app/actions/sheets-sync";
import type { SyncWriteStatus as Status } from "@/lib/jira-sync";

/**
 * The rows of a Google Sheets or Google Calendar sync that wait to be written to the sheet or the
 * calendar, with Write now for those who may run it, or that writing failed. Its own module, loaded
 * only while rows wait, so a database's first load doesn't carry it.
 */
export default function SyncWriteStatus({
  databaseId,
  status,
  onOpenDialog,
  onChanged,
}: {
  databaseId: string;
  status: Status;
  onOpenDialog: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("database");
  const [writing, setWriting] = useState(false);
  const texts = status.source === "gcal" ? "gcalSync" : "sheetsSync";
  const writeNow = async () => {
    setWriting(true);
    const res = await (status.source === "gcal" ? syncGcalNowAction : syncSheetsNowAction)(databaseId).catch(() => null);
    setWriting(false);
    // The dialog says why it didn't go.
    if (!res?.ok || res.data.outcome.error) onOpenDialog();
    onChanged();
  };
  if (status.failed)
    return (
      <button
        type="button"
        title={t(`${texts}.writeStuckHelp`)}
        aria-label={t(`${texts}.writeStuck`)}
        aria-haspopup="dialog"
        onClick={onOpenDialog}
        className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-danger hover:bg-bg-hover"
      >
        <CloudAlert className="h-4 w-4" />
        <span className="hidden xl:inline">{t(`${texts}.writeStuck`)}</span>
      </button>
    );
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 ps-1.5 text-sm whitespace-nowrap text-fg-muted" title={t(`${texts}.waitingHelp`)}>
      <CloudUpload className="h-4 w-4" />
      <span className="sr-only xl:not-sr-only">{t(`${texts}.waiting`, { count: status.pending })}</span>
      <span className="xl:hidden" aria-hidden>
        {status.pending}
      </span>
      {status.canWriteNow && (
        <button
          type="button"
          disabled={writing}
          onClick={() => void writeNow()}
          className="ms-0.5 h-7 rounded-md px-1.5 font-medium whitespace-nowrap text-accent hover:bg-bg-hover disabled:opacity-60"
        >
          {writing ? t(`${texts}.writingNow`) : t(`${texts}.writeNow`)}
        </button>
      )}
    </span>
  );
}
