"use client";

import { CloudAlert, CloudUpload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { syncSheetsNowAction } from "@/app/actions/sheets-sync";
import type { SheetsWriteStatus as Status } from "@/lib/sheets-sync";

/**
 * The rows of a Google Sheets sync that wait to be written to the sheet, with Write now for those
 * who may run it, or that writing failed. Its own module, loaded only while rows wait, so a
 * database's first load doesn't carry it.
 */
export default function SheetsWriteStatus({
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
  const writeNow = async () => {
    setWriting(true);
    const res = await syncSheetsNowAction(databaseId).catch(() => null);
    setWriting(false);
    // The dialog says why it didn't go.
    if (!res?.ok || res.data.outcome.error) onOpenDialog();
    onChanged();
  };
  if (status.failed)
    return (
      <button
        type="button"
        title={t("sheetsSync.writeStuckHelp")}
        aria-label={t("sheetsSync.writeStuck")}
        aria-haspopup="dialog"
        onClick={onOpenDialog}
        className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-danger hover:bg-bg-hover"
      >
        <CloudAlert className="h-4 w-4" />
        <span className="hidden xl:inline">{t("sheetsSync.writeStuck")}</span>
      </button>
    );
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 ps-1.5 text-sm whitespace-nowrap text-fg-muted" title={t("sheetsSync.waitingHelp")}>
      <CloudUpload className="h-4 w-4" />
      <span className="sr-only xl:not-sr-only">{t("sheetsSync.waiting", { count: status.pending })}</span>
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
          {writing ? t("sheetsSync.writingNow") : t("sheetsSync.writeNow")}
        </button>
      )}
    </span>
  );
}
