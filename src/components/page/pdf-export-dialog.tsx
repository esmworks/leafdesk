"use client";

import { FileDown } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { listLetterheadsAction } from "@/app/actions/letterheads";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, selectClass, Switch } from "@/components/ui";
import type { Letterhead } from "@/lib/letterheads";
import { PDF_TEXT_SCALES } from "@/lib/pdf-text-scale";

/** The file name a download's Content-Disposition gives (its UTF-8 form first). */
function fileNameOf(disposition: string | null, fallback: string): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {}
  }
  return disposition?.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

/**
 * The page menu's "Export as PDF" and "Export as Word": the page as a PDF file or Word document
 * made on the server (the export route's `format=pdf` or `docx`), in one of the workspace's
 * letterheads (its default picked first) and, for a row, with its values and with the comments if
 * asked (the page menu's "Include comments" picks the latter first); a PDF in a text size from 75
 * to 150 percent. The file is fetched rather than linked, so a refusal (another export
 * running, export turned off) shows here instead of downloading as a file. Loaded with the menu's
 * first use, not with every page.
 */
export default function PdfExportDialog({
  workspaceId,
  pageId,
  isRow,
  comments: commentsFirst = false,
  format: kind = "pdf",
  onClose,
}: {
  workspaceId: string;
  pageId: string;
  isRow: boolean;
  comments?: boolean;
  format?: "pdf" | "docx";
  onClose: () => void;
}) {
  const t = useTranslations("page.pdfExport");
  const tExport = useTranslations("common.export");
  const tc = useTranslations("common");
  const format = useFormatter();
  const formatPercent = (percent: number) => format.number(percent / 100, { style: "percent" });
  const id = useId();
  const [letterheads, setLetterheads] = useState<Letterhead[] | null>(null);
  const [choice, setChoice] = useState("none");
  const [properties, setProperties] = useState(false);
  const [comments, setComments] = useState(commentsFirst);
  const [scale, setScale] = useState(100);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listLetterheadsAction(workspaceId)
      .then((result) => (result.ok ? result.data : []))
      .catch(() => [])
      .then((list) => {
        if (!live) return;
        setLetterheads(list);
        setChoice(list.find((l) => l.isDefault)?.id ?? "none");
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function download() {
    setPending(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        format: kind,
        letterhead: choice,
        ...(isRow && properties ? { properties: "1" } : {}),
        ...(comments ? { comments: "1" } : {}),
        ...(kind === "pdf" && scale !== 100 ? { scale: String(scale) } : {}),
      });
      const res = await fetch(`/w/${workspaceId}/p/${pageId}/export?${query}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error === "busy" ? tExport("busy") : body?.error === "disabled" ? tExport("disabled") : tExport("failed"));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameOf(res.headers.get("content-disposition"), `page.${kind}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch {
      setError(tExport("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogBody className="pt-5">
        <DialogTitle>{t(kind === "pdf" ? "title" : "titleDocx")}</DialogTitle>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-letterhead`} className="block text-sm font-medium">
            {t("letterhead")}
          </label>
          <select
            id={`${id}-letterhead`}
            className={cn(selectClass, "w-full")}
            value={choice}
            disabled={!letterheads || pending}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="none">{t("none")}</option>
            {letterheads?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.isDefault ? t("defaultMark", { name: l.name }) : l.name}
              </option>
            ))}
          </select>
          {letterheads?.length === 0 && <p className="text-xs text-fg-muted">{t("noLetterheads")}</p>}
        </div>
        {kind === "pdf" && (
        <div className="flex items-center justify-between gap-3 text-sm">
          <label htmlFor={`${id}-scale`}>{t("textSize")}</label>
          <select
            id={`${id}-scale`}
            className={selectClass}
            value={scale}
            disabled={pending}
            onChange={(e) => setScale(Number(e.target.value))}
          >
            {PDF_TEXT_SCALES.map((percent) => (
              <option key={percent} value={percent}>
                {formatPercent(percent)}
              </option>
            ))}
          </select>
        </div>
        )}
        {isRow && (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span id={`${id}-properties`}>{t("properties")}</span>
            <Switch checked={properties} onChange={setProperties} label={t("properties")} disabled={pending} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>{t("comments")}</span>
          <Switch checked={comments} onChange={setComments} label={t("comments")} disabled={pending} />
        </div>
        <p className="text-xs text-fg-muted">{t(kind === "pdf" ? "hint" : "hintDocx")}</p>
      </DialogBody>
      <DialogFooter>
        {error && <span className="flex-1 text-sm text-danger">{error}</span>}
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" onClick={() => void download()} disabled={pending || !letterheads}>
          <FileDown className="h-3.5 w-3.5" />
          {pending ? t("preparing") : t("download")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
