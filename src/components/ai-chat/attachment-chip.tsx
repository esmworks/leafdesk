"use client";

/**
 * A CSV file attached to a question, as a chip: its name and how many rows and columns it has, in
 * the box (with a button to take it off) and on the question once asked.
 */
import { FileSpreadsheet, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn, IconButton } from "@/components/ui";
import type { ChatAttachmentView } from "@/lib/chat-attachments";

export function AttachmentChip({ file, onRemove, className }: { file: ChatAttachmentView; onRemove?: () => void; className?: string }) {
  const t = useTranslations("ai.chat.files");
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg py-1 ps-2 text-xs", onRemove ? "pe-0.5" : "pe-2", className)}>
      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate font-medium text-fg" title={file.name}>
        {file.name}
      </span>
      <span className="shrink-0 text-fg-muted tabular-nums">{t("size", { rows: file.rows, columns: file.columns })}</span>
      {onRemove && (
        <IconButton label={t("remove", { name: file.name })} className="h-5 w-5" onClick={onRemove}>
          <X className="h-3 w-3" />
        </IconButton>
      )}
    </span>
  );
}
