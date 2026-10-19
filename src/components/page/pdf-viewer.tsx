"use client";

import { ExternalLink, FileText, Maximize2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { fileUrl, pdfViewUrl } from "@/lib/files";

/**
 * An uploaded PDF shown in place, in the editor's file blocks and on published pages.
 *
 * The browser's own PDF viewer draws it, in an `<object>`: Chrome's viewer refuses to run in a
 * sandboxed iframe, and an `<object>` falls back to its content (the link) where there is no
 * viewer, where an iframe would download the file on every visit (Android). Browsers that say they
 * have no viewer (`navigator.pdfViewerEnabled`) get only the link. The object loads `pdfViewUrl`,
 * which the file route answers only for files stored as application/pdf (served with nosniff and
 * framable by this site alone), so a file merely named ".pdf" shows the fallback instead.
 *
 * Its expand button opens the file viewer (components/file-viewer), which `fill` draws it in: the
 * whole height it is given, without the line above it.
 */
export function PdfViewer({ fileId, name, caption, fill = false }: { fileId: string; name: string; caption?: string; fill?: boolean }) {
  const t = useTranslations("page.pdf");
  const tv = useTranslations("page.viewer");
  // Unknown until mounted: the server can't tell, and assuming a viewer keeps the layout steady.
  const [viewer, setViewer] = useState(true);
  useEffect(() => {
    setViewer((navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false);
  }, []);
  const label = name || t("untitled");
  const link = (
    <a
      href={fileUrl(fileId)}
      target="_blank"
      rel="noopener"
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm text-fg no-underline hover:underline"
    >
      <FileText className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="truncate">{label}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
      <span className="sr-only">{t("openInNewTab")}</span>
    </a>
  );
  return (
    <div
      className={fill ? "flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" : "w-full min-w-0"}
      contentEditable={false}
      data-leafdesk-pdf=""
      data-file-url={fileUrl(fileId)}
      data-file-name={name}
    >
      {!fill && (
        <div className="flex min-w-0 items-center justify-between gap-2 pb-1.5">
          {link}
          <ExpandButton url={fileUrl(fileId)} name={name} label={tv("expand")} />
        </div>
      )}
      {viewer ? (
        <object
          data={pdfViewUrl(fileId)}
          type="application/pdf"
          aria-label={t("frameTitle", { name: label })}
          className={
            fill ? "block min-h-0 w-full flex-1 bg-bg-subtle" : "block h-[min(36rem,70vh)] w-full rounded-md border border-border bg-bg-subtle"
          }
        >
          <p className="p-3 text-sm text-fg-muted">{t("noPreview")}</p>
        </object>
      ) : (
        fill && <p className="m-auto p-6 text-sm text-fg-muted">{t("noPreview")}</p>
      )}
      {caption && <p className="pt-1.5 text-sm text-fg-muted">{caption}</p>}
    </div>
  );
}

/**
 * Opens the file viewer at this file: the page's file viewer area (published pages) or the editor
 * (see page/editor-files.tsx) finds the button by its `data-file-view` and does the opening.
 */
export function ExpandButton({ url, name, label }: { url: string; name: string; label: string }) {
  return (
    <button
      type="button"
      data-file-view={url}
      data-file-name={name}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
    >
      <Maximize2 className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
