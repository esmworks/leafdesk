"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, cn, selectClass } from "@/components/ui";
import { useZipExport } from "@/components/use-zip-export";
import { MAX_PDF_EXPORT_PAGES } from "@/lib/export-pdf-limits";
import { SettingsRow } from "./section";

type Format = "markdown" | "pdf";

/**
 * "Export workspace": every page the owner can see, as a ZIP of Markdown, CSV and files, or as a ZIP
 * of PDFs (one per page, see server/export-pdf). `disabled` while export is turned off in Settings >
 * Security (the route refuses it then too).
 */
export function WorkspaceExport({ workspaceId, disabled = false }: { workspaceId: string; disabled?: boolean }) {
  const t = useTranslations("settings.export");
  const { start, pending, error } = useZipExport();
  const [format, setFormat] = useState<Format>("markdown");
  return (
    <SettingsRow
      title={t("title")}
      description={
        error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : disabled ? (
          t("disabled")
        ) : format === "pdf" ? (
          t("descriptionPdf", { limit: MAX_PDF_EXPORT_PAGES })
        ) : (
          t("description")
        )
      }
      control={
        <div className="flex items-center gap-2">
          <select
            aria-label={t("format")}
            className={cn(selectClass, "h-8")}
            value={format}
            disabled={pending || disabled}
            onChange={(e) => setFormat(e.target.value === "pdf" ? "pdf" : "markdown")}
          >
            <option value="markdown">{t("formatMarkdown")}</option>
            <option value="pdf">{t("formatPdf")}</option>
          </select>
          <Button
            onClick={() => void start(`/w/${workspaceId}/settings/export.zip${format === "pdf" ? "?format=pdf" : ""}`)}
            disabled={pending || disabled}
          >
            <Download className="h-4 w-4" />
            {pending ? t("preparing") : t("button")}
          </Button>
        </div>
      }
    />
  );
}
