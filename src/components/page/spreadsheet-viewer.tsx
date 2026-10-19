"use client";

import { Download, FileSpreadsheet, TableProperties } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { fileUrl } from "@/lib/files";
import type { SheetCells } from "@/lib/import/xlsx";
import { columnName, XLSX_MIME } from "@/lib/xlsx";
import type { SpreadsheetReply, SpreadsheetRequest } from "./spreadsheet-worker";

/** Largest workbook read in place; a larger one shows its link only. */
const MAX_BYTES = 10 * 1024 * 1024;
/** What its parts may unpack to (a small file can hold a huge sheet). */
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
/** How much of a sheet is shown. */
const LIMITS = { rows: 200, columns: 40 };

type State = { status: "loading" | "tooLarge" | "unreadable" } | { status: "ready"; sheets: string[]; sheet: number; cells: SheetCells };

const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

type Props = {
  fileId: string;
  name: string;
  caption?: string;
  /** Offered where the reader may edit: imports a sheet of the workbook, given as a file. */
  onConvert?: (file: File) => void;
};

/**
 * An uploaded Excel workbook (.xlsx) shown in place, read-only, in the editor's file blocks and on
 * published pages: the first rows and columns of one sheet at a time, with the sheet's own row
 * numbers and column letters, and tabs for its other sheets. Once the block comes near the screen,
 * a worker fetches and reads the workbook with the import's reader (see spreadsheet-worker.ts),
 * off the page's main thread; cells are text, never markup. A workbook too large, damaged,
 * password-protected or old (.xls) shows its link with a note instead.
 *
 * `onConvert` offers to import a sheet as a new database: it gets the workbook as a file, as if
 * chosen in the import dialog.
 */
export function SpreadsheetViewer(props: Props) {
  // Another file starts over: nothing of the one before shows meanwhile.
  return <Viewer key={props.fileId} {...props} />;
}

function Viewer({ fileId, name, caption, onConvert }: Props) {
  const t = useTranslations("page.spreadsheet");
  const [state, setState] = useState<State>({ status: "loading" });
  const [converting, setConverting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const label = name || t("untitled");

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    const read = () => {
      const reader = new Worker(new URL("./spreadsheet-worker.ts", import.meta.url), { type: "module" });
      worker.current = reader;
      reader.onmessage = (event: MessageEvent<SpreadsheetReply>) => {
        const reply = event.data;
        setState(reply.type === "sheet" ? { status: "ready", sheets: reply.sheets, sheet: reply.sheet, cells: reply.cells } : { status: reply.type });
      };
      reader.onerror = () => setState({ status: "unreadable" });
      reader.postMessage({
        type: "open",
        url: new URL(fileUrl(fileId), location.href).href,
        maxBytes: MAX_BYTES,
        unpackedBytes: MAX_UNPACKED_BYTES,
        limits: LIMITS,
      } satisfies SpreadsheetRequest);
    };
    // Read once the block comes near the screen, so a page of many workbooks doesn't fetch them all.
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") read();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer?.disconnect();
          read();
        },
        { rootMargin: "400px" },
      );
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      worker.current?.terminate();
      worker.current = null;
    };
  }, [fileId]);

  const showSheet = (sheet: number) => {
    if (state.status !== "ready" || sheet === state.sheet) return;
    worker.current?.postMessage({ type: "sheet", sheet } satisfies SpreadsheetRequest);
  };

  /** Hands the workbook to `onConvert`, fetched again (the browser keeps it cached) rather than kept in memory. */
  const convert = async () => {
    if (!onConvert || converting) return;
    setConverting(true);
    try {
      const res = await fetch(fileUrl(fileId));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onConvert(new File([await res.blob()], name || "workbook.xlsx", { type: XLSX_MIME }));
    } catch {
      setState({ status: "unreadable" });
    } finally {
      setConverting(false);
    }
  };

  const link = (
    <a
      href={fileUrl(fileId)}
      download={name || undefined}
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm text-fg no-underline hover:underline"
    >
      <FileSpreadsheet className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="truncate">{label}</span>
      <Download className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
      <span className="sr-only">{t("download")}</span>
    </a>
  );

  return (
    <div ref={box} className="w-full min-w-0" contentEditable={false} data-leafdesk-spreadsheet="">
      <div className="flex min-w-0 items-center justify-between gap-2 pb-1.5">
        {link}
        {onConvert && state.status === "ready" && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            title={t("convertTitle")}
            disabled={converting}
            onClick={() => void convert()}
          >
            <TableProperties className="h-3.5 w-3.5" aria-hidden />
            {t("convert")}
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-bg">
        {state.status !== "ready" ? (
          // Not <p>: the editor resets paragraphs' padding.
          <div className="p-3 text-sm text-fg-muted" role={state.status === "loading" ? "status" : undefined}>
            {t(state.status)}
          </div>
        ) : (
          <>
            {state.cells.rows.length ? (
              <SheetTable cells={state.cells} label={t("tableLabel", { name: label, sheet: state.sheets[state.sheet] ?? "" })} />
            ) : (
              <div className="p-3 text-sm text-fg-muted">{t("empty")}</div>
            )}
            {(state.sheets.length > 1 || state.cells.partial) && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-bg-subtle px-1.5 py-1">
                {state.sheets.length > 1 && (
                  <div role="tablist" aria-label={t("sheets")} className="flex min-w-0 flex-wrap items-center gap-0.5">
                    {state.sheets.map((sheet, i) => (
                      <button
                        key={i}
                        type="button"
                        role="tab"
                        aria-selected={i === state.sheet}
                        onClick={() => showSheet(i)}
                        className={cn(
                          "max-w-[12rem] truncate rounded px-2 py-0.5 text-xs transition-colors",
                          i === state.sheet ? "bg-bg font-medium text-fg shadow-sm ring-1 ring-border" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                        )}
                      >
                        {sheet}
                      </button>
                    ))}
                  </div>
                )}
                {state.cells.partial && (
                  <div className="ml-auto px-1 text-xs text-fg-muted">{t("partial", { rows: LIMITS.rows, columns: LIMITS.columns })}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {caption && <p className="pt-1.5 text-sm text-fg-muted">{caption}</p>}
    </div>
  );
}

function SheetTable({ cells, label }: { cells: SheetCells; label: string }) {
  const columns = Array.from({ length: cells.width }, (_, i) => columnName(i));
  const edge = "border-b border-r border-border";
  return (
    <div className="max-h-[min(28rem,60vh)] overflow-auto">
      {/* Sized by its cells: the editor's own table rules (fixed layout, full width) would squeeze them. */}
      <table
        aria-label={label}
        className="border-separate border-spacing-0 text-sm"
        style={{ tableLayout: "auto", width: "max-content", minWidth: "100%" }}
      >
        <thead>
          <tr>
            <th className={cn(edge, "sticky top-0 left-0 z-[2] w-10 bg-bg-subtle")} aria-hidden />
            {columns.map((column) => (
              <th key={column} scope="col" className={cn(edge, "sticky top-0 z-[1] bg-bg-subtle px-2 py-0.5 text-center text-xs font-normal text-fg-muted")}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.rows.map((row) => (
            <tr key={row.number}>
              <th scope="row" className={cn(edge, "sticky left-0 z-[1] bg-bg-subtle px-2 py-0.5 text-right text-xs font-normal text-fg-muted tabular-nums")}>
                {row.number}
              </th>
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  title={cell.length > 40 ? cell : undefined}
                  className={cn(edge, "max-w-[20rem] truncate px-2 py-0.5", NUMBER.test(cell) && "text-right tabular-nums")}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
