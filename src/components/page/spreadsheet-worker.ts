import { readWorkbook, type SheetCells, type SheetLimits, type Workbook } from "@/lib/import/xlsx";

/**
 * Reads a workbook for SpreadsheetViewer off the page's main thread: fetches it, opens it with
 * the import's reader and answers with one sheet's cells at a time, so a large workbook never
 * holds up typing in the editor. The workbook stays open here until the viewer goes away.
 */

export type SpreadsheetRequest =
  | { type: "open"; url: string; maxBytes: number; unpackedBytes: number; limits: SheetLimits }
  | { type: "sheet"; sheet: number };

export type SpreadsheetReply =
  | { type: "sheet"; sheets: string[]; sheet: number; cells: SheetCells }
  | { type: "tooLarge" | "unreadable" };

let book: Workbook | null = null;
let limits: SheetLimits | null = null;

const reply = (message: SpreadsheetReply) => postMessage(message);

const showSheet = (sheet: number) => {
  if (!book || !limits) return reply({ type: "unreadable" });
  reply({ type: "sheet", sheets: book.sheets.map((s) => s.name), sheet, cells: book.cells(sheet, limits) });
};

async function open({ url, maxBytes, unpackedBytes, limits: wanted }: Extract<SpreadsheetRequest, { type: "open" }>) {
  const res = await fetch(url);
  if (!res.ok) return reply({ type: "unreadable" });
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    void res.body?.cancel();
    return reply({ type: "tooLarge" });
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) return reply({ type: "tooLarge" });
  book = readWorkbook(bytes, { unpackedBytes });
  limits = wanted;
  showSheet(0);
}

onmessage = (event: MessageEvent<SpreadsheetRequest>) => {
  const request = event.data;
  const failed = (error: unknown) =>
    reply({ type: (error as { code?: string } | null)?.code === "tooLarge" ? "tooLarge" : "unreadable" });
  try {
    if (request.type === "open") void open(request).catch(failed);
    else showSheet(request.sheet);
  } catch (error) {
    failed(error);
  }
};
