"use client";

import { Archive } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";
import { useZipExport } from "@/components/use-zip-export";
import { SettingsRow } from "./section";

/**
 * "Back up workspace": everything in the workspace, as one file that restores on any Leafdesk (see
 * server/backup). `disabled` while export is turned off in Settings > Security, like the export.
 */
export function WorkspaceBackup({ workspaceId, disabled = false }: { workspaceId: string; disabled?: boolean }) {
  const t = useTranslations("settings.backup");
  const { start, pending, error } = useZipExport();
  return (
    <SettingsRow
      title={t("title")}
      description={
        error ? <span role="alert" className="text-danger">{error}</span> : disabled ? t("disabled") : t("description")
      }
      control={
        <Button onClick={() => void start(`/w/${workspaceId}/settings/backup.zip`)} disabled={pending || disabled}>
          <Archive className="h-4 w-4" />
          {pending ? t("preparing") : t("button")}
        </Button>
      }
    />
  );
}
