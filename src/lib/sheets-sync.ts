import type { WorkspaceRole } from "@/db/schema/app";
import type { JiraSyncError } from "./jira-sync";
import type { PropertyType } from "./property-types";
import { zonedInstant } from "./time-zone";
import { contentRole } from "./workspace-roles";

/**
 * Keeping a database in step with one sheet of a Google spreadsheet, one way (server/sheets-sync
 * for setting it up and reading, server/jira-sync/run for the runs every synced database shares).
 * The sheet is read through a workspace's Google Sheets connection (an outbound MCP connection,
 * see server/connections) with its `get_spreadsheet` tool, as typed cells, so numbers and dates
 * don't depend on how the spreadsheet's language writes them. Pure, shared by the server, the
 * import dialog and the sync's dialog on the database.
 *
 * The header row names the columns: each row below it with a key becomes a row, found again by
 * its key column's text, named by its title column, with a property for each other named column
 * (SheetsMapping, by header). Rows above the header are left out, as are columns without a
 * header. Rows that leave the sheet stay as they are.
 */

/** The connection's tool a sync reads with. */
export const SHEETS_TOOL = "get_spreadsheet";

/** Cells (rows below the header times columns) a sheet may have: a bigger one stops the run. */
export const MAX_SHEET_CELLS = 100_000;
/** Columns a sync makes properties of at most, in the sheet's order. */
export const MAX_SHEET_COLUMNS = 50;
/** The most text a value keeps. */
export const MAX_SHEET_TEXT = 10_000;
/** How far down the header row may be. */
export const MAX_HEADER_ROW = 50;

/** What a sync reads: one sheet of a spreadsheet, through one connection, and the columns that find and name its rows. */
export type SheetsQuery = {
  connectionId: string;
  spreadsheetId: string;
  /** The sheet's id (the link's `gid`): it stays when the sheet is renamed. */
  sheetId: number;
  /** The sheet's name when it was last read, for the dialog. */
  sheetTitle: string;
  /** The row of column names, counted from 1. */
  headerRow: number;
  keyColumn: string;
  titleColumn: string;
};

/** How a column's values are written: the kind of property it became. */
export const SHEETS_KINDS = ["text", "number", "checkbox", "date", "time"] as const;
export type SheetsKind = (typeof SHEETS_KINDS)[number];

/** The properties a sync writes: the key, and one per column, by its header (their ids in the database). */
export type SheetsMapping = {
  key: string;
  columns: { column: string; property: string; kind: SheetsKind }[];
};

/** The type a column's property has, by its kind. */
export const KIND_TYPES: Record<SheetsKind, PropertyType> = {
  text: "text",
  number: "number",
  checkbox: "checkbox",
  date: "date",
  time: "date",
};

/**
 * Why a run didn't happen, in the codes every synced database uses: "unauthorized" (the connection
 * needs signing in to Google again), "forbidden" (the connection may no longer be used for it),
 * "notFound" (the connection, the spreadsheet or the sheet is gone), "badQuery" (Google refused the
 * read; lastErrorDetail says why), "tooManyIssues" (more than MAX_SHEET_CELLS cells), "keyGone" (the
 * key property, or the key column's header, is gone), "unreachable" and "failed" (passing), and
 * "runAsGone", "accessLost" as for Jira.
 */
export type SheetsSyncError = JiraSyncError;
export type SheetsErrorCode = SheetsSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A sync as its dialog on the database shows it. */
export type SheetsSyncView = {
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  connectionId: string;
  /** The connection's name; null once it is gone. */
  connection: string | null;
  /** With full access: the connections the viewer may read through, to switch to. */
  choices: SheetsSource[];
  headerRow: number;
  keyColumn: string;
  titleColumn: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: SheetsSyncError | null;
  lastErrorDetail: string | null;
  canManage: boolean;
};

/** A connection the person may sync through, as the import dialog shows it (never its secrets). */
export type SheetsSource = { id: string; name: string };

/** Whether a person may read spreadsheets through a connection, given their role. */
export function sheetsAccess(row: { status: string; tools: { name: string }[]; chatTools: string[] }, role: WorkspaceRole): boolean {
  if (row.status !== "ready" || !row.tools.some((t) => t.name === SHEETS_TOOL)) return false;
  // Owners manage the connection; members read through it only what an owner lets their AI chat read.
  return role === "owner" || (contentRole(role) === "member" && row.chatTools.includes(SHEETS_TOOL));
}

const ID = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * The spreadsheet and sheet a link names (`/spreadsheets/d/<id>/edit?gid=<sheet>#gid=<sheet>`), or
 * an id itself; sheetId is null when the link names none (the first sheet). Null for anything else.
 */
export function parseSheetLink(text: unknown): { spreadsheetId: string; sheetId: number | null } | null {
  if (typeof text !== "string" || text.length > 2000) return null;
  const value = text.trim();
  if (ID.test(value)) return { spreadsheetId: value, sheetId: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "docs.google.com") return null;
  const spreadsheetId = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  if (!spreadsheetId || !ID.test(spreadsheetId)) return null;
  const gid = /(?:^|[#&])gid=(\d{1,10})(?:&|$)/.exec(url.hash.slice(1))?.[1] ?? url.searchParams.get("gid");
  return { spreadsheetId, sheetId: gid && /^\d{1,10}$/.test(gid) ? Number(gid) : null };
}

/** The link that opens a sheet. */
export const sheetLink = (spreadsheetId: string, sheetId: number) => `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;

/** A spreadsheet as the tool's answer describes it (fields requested by META_FIELDS). */
export type SheetsMeta = {
  title: string;
  timeZone: string;
  sheets: { sheetId: number; title: string; rows: number; columns: number; frozenRows: number }[];
};

/** What a run asks for first: the spreadsheet's name and zone, and its sheets. */
export const META_FIELDS = ["properties.title", "properties.timeZone", "sheets.properties.sheetId", "sheets.properties.title", "sheets.properties.gridProperties"];
/** What it asks for then: each cell's typed value, its text as shown, and its number format. */
export const GRID_FIELDS = ["sheets.data.rowData.values.effectiveValue", "sheets.data.rowData.values.formattedValue", "sheets.data.rowData.values.effectiveFormat.numberFormat.type"];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

/** The spreadsheet's description in the tool's answer, or null when it is none. */
export function readMeta(json: Record<string, unknown> | null): SheetsMeta | null {
  if (!json || !Array.isArray(json.sheets)) return null;
  const props = isObject(json.properties) ? json.properties : {};
  const sheets: SheetsMeta["sheets"] = [];
  for (const sheet of json.sheets) {
    const p = isObject(sheet) && isObject(sheet.properties) ? sheet.properties : null;
    if (!p || typeof p.title !== "string") continue;
    const grid = isObject(p.gridProperties) ? p.gridProperties : {};
    // The first sheet's id is 0, which Google leaves out.
    sheets.push({ sheetId: count(p.sheetId), title: p.title, rows: count(grid.rowCount), columns: count(grid.columnCount), frozenRows: count(grid.frozenRowCount) });
  }
  const zone = typeof props.timeZone === "string" ? props.timeZone : "UTC";
  return { title: typeof props.title === "string" ? props.title : "", timeZone: zone, sheets };
}

/** The header row a sheet's own layout suggests: the last frozen row, else the first. */
export const defaultHeaderRow = (sheet: { frozenRows: number }) => Math.min(Math.max(sheet.frozenRows, 1), MAX_HEADER_ROW);

/** Column `index` (from 0) as A1 writes it: A … Z, AA … */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Cells (rows from the header down, times columns) a run of the sheet reads. */
export const sheetCells = (sheet: { rows: number; columns: number }, headerRow: number) =>
  Math.max(sheet.rows - headerRow + 1, 0) * Math.min(sheet.columns, MAX_SHEET_COLUMNS * 4);

/** The A1 range a run reads: the header row down to the sheet's end, every column it has. */
export function sheetRange(sheet: { title: string; rows: number; columns: number }, headerRow: number) {
  const last = columnLetter(Math.max(Math.min(sheet.columns, MAX_SHEET_COLUMNS * 4), 1) - 1);
  return `'${sheet.title.replace(/'/g, "''")}'!A${headerRow}:${last}${Math.max(sheet.rows, headerRow)}`;
}

/** One cell as the tool answers with GRID_FIELDS. */
export type SheetCell = {
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; errorValue?: unknown };
  formattedValue?: string;
  effectiveFormat?: { numberFormat?: { type?: string } };
};

/** The rows of cells in the tool's answer for one range (an empty row is []). */
export function readGrid(json: Record<string, unknown> | null): SheetCell[][] | null {
  const sheet = Array.isArray(json?.sheets) ? json.sheets[0] : null;
  if (!isObject(sheet)) return null;
  const data = Array.isArray(sheet.data) ? sheet.data[0] : null;
  // An empty sheet comes without its data.
  if (!isObject(data)) return [];
  const rows = Array.isArray(data.rowData) ? data.rowData : [];
  return rows.map((row) => (isObject(row) && Array.isArray(row.values) ? row.values.map((cell) => (isObject(cell) ? (cell as SheetCell) : {})) : []));
}

/** A cell's text as the sheet shows it ("" when empty). */
export function cellText(cell: SheetCell | undefined): string {
  if (!cell) return "";
  if (typeof cell.formattedValue === "string") return cell.formattedValue;
  const value = cell.effectiveValue;
  if (typeof value?.stringValue === "string") return value.stringValue;
  if (typeof value?.numberValue === "number") return String(value.numberValue);
  if (typeof value?.boolValue === "boolean") return String(value.boolValue);
  return "";
}

/** The named columns of a header row: by their text (spaces closed up, a repeated name numbered), the empty ones left out. */
export function sheetHeaders(row: SheetCell[]): { index: number; name: string }[] {
  const headers: { index: number; name: string }[] = [];
  const taken = new Set<string>();
  row.forEach((cell, index) => {
    const base = cellText(cell).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!base) return;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    headers.push({ index, name });
  });
  return headers;
}

/**
 * The kind a column's cells make (the cells below the header): one kind for all, else text. A
 * number formatted as a time of day alone (TIME) is text: there is no property for it.
 */
export function kindOf(cells: (SheetCell | undefined)[]): SheetsKind {
  let kind: SheetsKind | null = null;
  for (const cell of cells) {
    const value = cell?.effectiveValue;
    if (!value || value.errorValue !== undefined) continue;
    if (typeof value.stringValue === "string" && !value.stringValue.trim()) continue;
    const format = cell?.effectiveFormat?.numberFormat?.type;
    const next: SheetsKind =
      typeof value.boolValue === "boolean"
        ? "checkbox"
        : typeof value.numberValue === "number"
          ? format === "DATE"
            ? "date"
            : format === "DATE_TIME"
              ? "time"
              : format === "TIME"
                ? "text"
                : "number"
          : "text";
    if (kind && kind !== next) return "text";
    kind = next;
  }
  return kind ?? "text";
}

/** Day 0 of a spreadsheet's dates (1899-12-30) is this many days before 1970-01-01. */
const SERIAL_EPOCH = 25_569;

/** A date serial's day ("YYYY-MM-DD"). */
export function serialDay(serial: number): string | null {
  const at = new Date((Math.floor(serial) - SERIAL_EPOCH) * 86_400_000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/** A date-time serial as the instant it names in the spreadsheet's zone (ISO, UTC), to the minute. */
export function serialTime(serial: number, timeZone: string): string | null {
  const day = Math.floor(serial);
  const minutes = Math.round((serial - day) * 1440);
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const at = new Date(zonedInstant(day - SERIAL_EPOCH, minutes, zone));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A cell's value as its column's property takes it; null when empty or not of the column's kind. */
export function cellValue(kind: SheetsKind, cell: SheetCell | undefined, timeZone: string): unknown {
  const value = cell?.effectiveValue;
  if (!value || value.errorValue !== undefined) return null;
  switch (kind) {
    case "number":
      // Spreadsheet arithmetic leaves noise in the last digits (164.54988000000003).
      return typeof value.numberValue === "number" && Number.isFinite(value.numberValue) ? Number(value.numberValue.toPrecision(15)) : null;
    case "checkbox":
      return value.boolValue === true;
    case "date":
      return typeof value.numberValue === "number" ? serialDay(value.numberValue) : null;
    case "time":
      return typeof value.numberValue === "number" ? serialTime(value.numberValue, timeZone) : null;
    default: {
      const text = cellText(cell).trim();
      return text ? text.slice(0, MAX_SHEET_TEXT) : null;
    }
  }
}

/** The sheet's rows below the header as synced items: those with a key, in the sheet's order. */
export function sheetItems(grid: SheetCell[][], query: Pick<SheetsQuery, "keyColumn" | "titleColumn">, mapping: Partial<SheetsMapping>, timeZone: string) {
  const headers = sheetHeaders(grid[0] ?? []);
  const at = (name: string) => headers.find((h) => h.name === name)?.index;
  const key = at(query.keyColumn);
  if (key === undefined) return null;
  const title = at(query.titleColumn) ?? key;
  const columns = (mapping.columns ?? []).flatMap((c) => {
    const index = at(c.column);
    return index === undefined ? [] : [{ ...c, index }];
  });
  return grid.slice(1).flatMap((row) => {
    const keyText = cellText(row[key]).trim().slice(0, 2000);
    if (!keyText) return [];
    const values: Record<string, unknown> = {};
    if (mapping.key) values[mapping.key] = keyText;
    for (const c of columns) values[c.property] = cellValue(c.kind, row[c.index], timeZone);
    return [{ key: keyText, title: cellText(row[title]).trim().slice(0, 2000) || keyText, values }];
  });
}
