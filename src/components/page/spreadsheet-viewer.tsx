"use client";

import { Download, FileSpreadsheet, TableProperties } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { fileUrl } from "@/lib/files";
import type { SheetCells, Workbook } from "@/lib/import/xlsx";
import { XLSX_MIME } from "@/lib/xlsx";

/** Largest workbook read in place; a larger one shows its link only. */
const MAX_BYTES = 10 * 1024 * 1024;
/** How much of a sheet is shown. */
const LIMITS = { rows: 200, columns: 40 };

type State =
  | { status: "loading" | "tooLarge" | "unreadable" }
  | { status: "ready"; book: Workbook; bytes: Uint8Array<ArrayBuffer>; sheet: number; cells: SheetCells };

/** A column's letters, as spreadsheets name it: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * An uploaded Excel workbook (.xlsx) shown in place, read-only, in the editor's file blocks and on
 * published pages: the first rows and columns of one sheet at a time, with the sheet's own row
 * numbers and column letters, and tabs for its other sheets. The bytes are read in the browser
 * with the import's reader (lib/import/xlsx) once the block comes near the screen; cells are
 * text, never markup. A workbook too large, damaged, password-protected or old (.xls) shows its
 * link with a note instead.
 *
 * `onConvert`, where the reader may edit, offers to import a sheet as a new database: it gets the
 * workbook as a file, as if chosen in the import dialog.
 */
export function SpreadsheetViewer({
  fileId,
  name,
  caption,
  onConvert,
}: {
  fileId: string;
  name: string;
  caption?: string;
  onConvert?: (file: File) => void;
}) {
  const t = useTranslations("page.spreadsheet");
  const [state, setState] = useState<State>({ status: "loading" });
  const box = useRef<HTMLDivElement>(null);
  const label = name || t("untitled");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const read = async () => {
      try {
        const res = await fetch(fileUrl(fileId), { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
          controller.abort();
          if (!cancelled) setState({ status: "tooLarge" });
          return;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) {
          if (!cancelled) setState({ status: "tooLarge" });
          return;
        }
        const { readWorkbook } = await import("@/lib/import/xlsx");
        const book = readWorkbook(bytes);
        const cells = book.cells(0, LIMITS);
        if (!cancelled) setState({ status: "ready", book, bytes, sheet: 0, cells });
      } catch {
        if (!cancelled) setState({ status: "unreadable" });
      }
    };
    // Read once the block comes near the screen, so a page of many workbooks doesn't fetch them all.
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      void read();
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer.disconnect();
          void read();
        },
        { rootMargin: "400px" },
      );
      observer.observe(element);
      return () => {
        cancelled = true;
        observer.disconnect();
        controller.abort();
      };
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fileId]);

  const showSheet = (sheet: number) => {
    if (state.status !== "ready" || sheet === state.sheet) return;
    try {
      setState({ ...state, sheet, cells: state.book.cells(sheet, LIMITS) });
    } catch {
      setState({ status: "unreadable" });
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
            onClick={() => onConvert(new File([state.bytes], name || "workbook.xlsx", { type: XLSX_MIME }))}
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
              <SheetTable cells={state.cells} label={t("tableLabel", { name: label, sheet: state.book.sheets[state.sheet]?.name ?? "" })} />
            ) : (
              <div className="p-3 text-sm text-fg-muted">{t("empty")}</div>
            )}
            {(state.book.sheets.length > 1 || state.cells.partial) && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-bg-subtle px-1.5 py-1">
                {state.book.sheets.length > 1 && (
                  <div role="tablist" aria-label={t("sheets")} className="flex min-w-0 flex-wrap items-center gap-0.5">
                    {state.book.sheets.map((sheet, i) => (
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
                        {sheet.name}
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
