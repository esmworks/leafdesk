"use client";

import { Download, File as FileIcon, Music } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { PdfViewer } from "@/components/page/pdf-viewer";
import { SpreadsheetViewer } from "@/components/page/spreadsheet-viewer";
import { buttonClass, cn } from "@/components/ui";
import { highlightCode, type CodeToken } from "@/lib/code-highlighter";
import { csvPreview, prettyJson, previewText, TEXT_KINDS, TEXT_PREVIEW_BYTES, type CsvPreview, type ViewerFormat } from "@/lib/file-viewer";
import { fileIdOf, formatBytes } from "@/lib/files";
import styles from "@/components/published/published-body.module.css";
import { Message } from "./file-viewer";
import type { ViewerFile } from "./index";

const MarkdownPreview = lazy(() => import("./markdown-preview"));

type Props = { file: ViewerFile; name: string; format: ViewerFormat; size: number | null; type: string };

/** A light or dark sheet, as the app's theme, on the viewer's dark ground: where documents and text show. */
const SHEET = "mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg text-fg sm:rounded-lg sm:shadow-2xl";

/** The preview of one file by its format (lib/file-viewer viewerFormat); images have their own stage. */
export function FilePreview({ file, name, format, size, type }: Props) {
  const t = useTranslations("page.viewer");
  const id = fileIdOf(file.url) ?? "";
  if (size === 0) return <Message>{t("empty")}</Message>;
  switch (format.kind) {
    case "video":
      return <Media kind="video" file={file} name={name} />;
    case "audio":
      return <Media kind="audio" file={file} name={name} />;
    case "pdf":
      return (
        <div className={cn(SHEET, "max-w-5xl p-0")}>
          <PdfViewer fileId={id} name={name} fill />
        </div>
      );
    case "spreadsheet":
      return (
        <div className={cn(SHEET, "max-w-6xl p-2")}>
          <SpreadsheetViewer fileId={id} name={name} fill />
        </div>
      );
    case "docx":
      return <DocxPreview file={file} name={name} />;
    default:
      if (TEXT_KINDS.has(format.kind)) return <TextPreview file={file} format={format} size={size} />;
      return <Other file={file} name={name} size={size} type={type} />;
  }
}

/** Video or audio in the browser's own player; one the browser can't play offers its download. */
function Media({ kind, file, name }: { kind: "video" | "audio"; file: ViewerFile; name: string }) {
  const t = useTranslations("page.viewer");
  const [failed, setFailed] = useState(false);
  if (failed) return <Other file={file} name={name} size={null} type="" note={t("cannotPlay")} />;
  if (kind === "video") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <video src={file.url} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} className="max-h-full max-w-full bg-black" />
      </div>
    );
  }
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center gap-5 px-6">
      <span className="inline-flex h-20 w-20 items-center justify-center rounded-xl bg-white/10 text-white/80">
        <Music className="h-9 w-9" aria-hidden />
      </span>
      <audio src={file.url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} className="w-full" />
    </div>
  );
}

/** A file with no preview: its icon, name, size and type, and its download. */
function Other({ file, name, size, type, note, retry }: { file: ViewerFile; name: string; size: number | null; type: string; note?: string; retry?: () => void }) {
  const t = useTranslations("page.viewer");
  return (
    <div className="m-auto flex w-full max-w-sm flex-col items-center gap-3 px-6 text-center">
      <span className="inline-flex h-20 w-20 items-center justify-center rounded-xl bg-white/10 text-white/80">
        <FileIcon className="h-9 w-9" aria-hidden />
      </span>
      <p className="max-w-full text-base font-medium break-words">{name}</p>
      <p className="text-sm text-white/60">{[type || t("unknownType"), size != null ? formatBytes(size) : null].filter(Boolean).join(" · ")}</p>
      <p className="text-sm text-white/75">{note ?? t("noPreview")}</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {retry && (
          <button type="button" onClick={retry} className={cn(buttonClass(), "border-white/20 bg-transparent text-white hover:bg-white/10")}>
            {t("retry")}
          </button>
        )}
        <a href={file.url} download={name} className={cn(buttonClass({ variant: "primary" }), "no-underline")}>
          <Download className="h-4 w-4" aria-hidden />
          {t("download")}
        </a>
      </div>
    </div>
  );
}

type Loaded<T> = { status: "loading" } | { status: "failed" } | ({ status: "ready" } & T);

/**
 * The first TEXT_PREVIEW_BYTES of a file as text, read with a range request so a large file isn't
 * downloaded whole, and whether there is more.
 */
function useText(url: string, size: number | null): Loaded<{ text: string; truncated: boolean }> {
  const [state, setState] = useState<Loaded<{ text: string; truncated: boolean }>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const ranged = size == null || size > TEXT_PREVIEW_BYTES;
    fetch(url, { headers: ranged ? { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } : {}, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
        const bytes = new Uint8Array(await res.arrayBuffer());
        setState({ status: "ready", ...previewText(bytes, { total: total ? Number(total) : size }) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [url, size]);
  return state;
}

/** Text, code, JSON, CSV/TSV and Markdown: read as text and shown as text, a table or rendered Markdown. */
function TextPreview({ file, format, size }: { file: ViewerFile; format: ViewerFormat; size: number | null }) {
  const t = useTranslations("page.viewer");
  const loaded = useText(file.url, size);
  if (loaded.status === "loading") return <Message role="status">{t("loading")}</Message>;
  if (loaded.status === "failed") return <Message>{t("unavailable")}</Message>;
  const { text, truncated } = loaded;
  const note = truncated ? t("truncated", { size: formatBytes(TEXT_PREVIEW_BYTES) }) : null;
  let body: ReactNode;
  if (format.kind === "csv") body = <CsvTable table={csvPreview(text, { tsv: format.tsv, truncated })} />;
  else if (format.kind === "markdown")
    body = (
      <Suspense fallback={<div className="p-6 text-sm text-fg-muted">{t("loading")}</div>}>
        <MarkdownPreview text={text} />
      </Suspense>
    );
  else if (format.kind === "json") body = <Code text={prettyJson(text, truncated)} language="json" />;
  else if (format.kind === "code") body = <Code text={text} language={format.language ?? null} />;
  else body = <pre className="min-w-0 p-4 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap sm:p-6">{text}</pre>;
  return (
    <div className={cn(SHEET, format.kind === "csv" ? "max-w-6xl" : "max-w-4xl")}>
      {note && <Note>{note}</Note>}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}

/** A line over a preview saying it isn't the whole file. */
function Note({ children }: { children: ReactNode }) {
  return <p className="shrink-0 border-b border-border bg-bg-subtle px-4 py-2 text-xs text-fg-muted">{children}</p>;
}

/** Code with line numbers, colored as the editor's code blocks are (lib/code-highlighter) when it isn't too long. */
function Code({ text, language }: { text: string; language: string | null }) {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null);
  useEffect(() => {
    let live = true;
    void highlightCode(text, language).then((lines) => live && setTokens(lines));
    return () => {
      live = false;
    };
  }, [text, language]);
  const lines = tokens ?? text.split(/\r\n|\r|\n/).map((line) => [{ text: line, light: null, dark: null }]);
  return (
    <pre className="code-colors min-w-max py-4 font-mono text-[13px] leading-relaxed sm:py-5">
      <code className="table">
        {lines.map((line, i) => (
          <span key={i} className="table-row">
            <span className="table-cell w-px ps-4 pe-4 text-end text-fg-faint select-none tabular-nums" aria-hidden>
              {i + 1}
            </span>
            <span className="table-cell pe-6">
              {line.map((token, j) =>
                token.light || token.dark ? (
                  <span key={j} style={{ "--shiki-light": token.light ?? "inherit", "--shiki-dark": token.dark ?? "inherit" } as React.CSSProperties}>
                    {token.text}
                  </span>
                ) : (
                  token.text
                ),
              )}
              {"\n"}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}

/** A CSV or TSV file's first rows as a table, its header (when it has one) kept in view. */
function CsvTable({ table }: { table: CsvPreview }) {
  const t = useTranslations("page.viewer");
  const edge = "border-b border-e border-border";
  if (!table.rows.length && !table.header) return <div className="p-6 text-sm text-fg-muted">{t("empty")}</div>;
  const pad = (row: string[]) => (row.length < table.width ? [...row, ...Array<string>(table.width - row.length).fill("")] : row);
  return (
    <>
      {table.partial && <Note>{t("csvPartial", { rows: table.rows.length })}</Note>}
      <table className="border-separate border-spacing-0 text-sm" style={{ width: "max-content", minWidth: "100%" }}>
        {table.header && (
          <thead>
            <tr>
              <th className={cn(edge, "sticky top-0 start-0 z-[2] w-10 bg-bg-subtle")} aria-hidden />
              {pad(table.header).map((cell, i) => (
                <th key={i} scope="col" className={cn(edge, "sticky top-0 z-[1] max-w-[20rem] truncate bg-bg-subtle px-2 py-1 text-start font-medium")}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              <th scope="row" className={cn(edge, "sticky start-0 z-[1] bg-bg-subtle px-2 py-1 text-end text-xs font-normal text-fg-muted tabular-nums")}>
                {r + 1}
              </th>
              {pad(row).map((cell, i) => (
                <td key={i} title={cell.length > 40 ? cell : undefined} className={cn(edge, "max-w-[20rem] truncate px-2 py-1")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type DocxState = Loaded<{ html: string; picturesLeftOut: boolean }> | { status: "error"; code: string };

/** A Word document as the server reads it (api/files/[id]/preview): its text, tables and own pictures as clean HTML. */
function DocxPreview({ file, name }: { file: ViewerFile; name: string }) {
  const t = useTranslations("page.viewer");
  const [state, setState] = useState<DocxState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`${file.url}/preview`, { signal: controller.signal })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { html?: string; picturesLeftOut?: boolean; code?: string } | null;
        if (res.ok && typeof data?.html === "string") setState({ status: "ready", html: data.html, picturesLeftOut: Boolean(data.picturesLeftOut) });
        else setState({ status: "error", code: data?.code ?? "unreadable" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [file.url, attempt]);

  if (state.status === "loading") return <Message role="status">{t("readingDocument")}</Message>;
  if (state.status === "failed" || state.status === "error") {
    const code = state.status === "error" ? state.code : "failed";
    if (code === "notFound") return <Message>{t("unavailable")}</Message>;
    const busy = code === "busy" || code === "failed" || code === "storage";
    return (
      <Other
        file={file}
        name={name}
        size={null}
        type=""
        note={code === "tooLarge" ? t("documentTooLarge") : busy ? t("documentBusy") : t("documentUnreadable")}
        retry={busy ? () => setAttempt((a) => a + 1) : undefined}
      />
    );
  }
  return (
    <div className={cn(SHEET, "max-w-4xl")}>
      {state.picturesLeftOut && <Note>{t("picturesLeftOut")}</Note>}
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className={cn(styles.body, "px-5 py-6 sm:px-12 sm:py-10")}
          onClick={openLinksAside}
          // Written by the server from the editor's own blocks (see server/docx-preview.ts): no scripts, styles or outside sources.
          dangerouslySetInnerHTML={{ __html: state.html }}
        />
      </div>
    </div>
  );
}

/** Links in a previewed document open in a new tab, so the viewer (and the page under it) stays. */
export function openLinksAside(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = link?.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  event.preventDefault();
  if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}
