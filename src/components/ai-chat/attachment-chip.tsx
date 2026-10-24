"use client";

/**
 * A file attached to a question, as a chip: its name and size (a CSV file's rows and columns), in
 * the box (with a spinner while it uploads, and a button to take it off) and on the question once
 * asked, where it opens the file (for the person who attached it only).
 */
import { FileSpreadsheet, FileText, Image as ImageIcon, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn, IconButton } from "@/components/ui";
import { chatFileKind, type ChatAttachmentView } from "@/lib/chat-attachments";
import { formatBytes } from "@/lib/files";

export function AttachmentChip({ file, onRemove, className }: { file: ChatAttachmentView & { uploading?: boolean }; onRemove?: () => void; className?: string }) {
  const t = useTranslations("ai.chat.files");
  const kind = chatFileKind(file.contentType, file.name);
  const Icon = file.uploading ? Loader2 : kind === "image" ? ImageIcon : kind === "csv" ? FileSpreadsheet : FileText;
  const size = file.uploading ? t("uploading") : file.rows !== undefined && file.columns !== undefined ? t("size", { rows: file.rows, columns: file.columns }) : formatBytes(file.size);
  const name = (
    <span className="min-w-0 truncate font-medium text-fg" title={file.name}>
      {file.name}
    </span>
  );
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg py-1 ps-2 text-xs", onRemove ? "pe-0.5" : "pe-2", className)}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0 text-fg-muted", file.uploading && "animate-spin")} />
      {!onRemove && file.url ? (
        <a href={file.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">
          {name}
        </a>
      ) : (
        name
      )}
      <span className="shrink-0 text-fg-muted tabular-nums">{size}</span>
      {onRemove && (
        <IconButton label={t("remove", { name: file.name })} className="h-5 w-5" onClick={onRemove}>
          <X className="h-3 w-3" />
        </IconButton>
      )}
    </span>
  );
}
