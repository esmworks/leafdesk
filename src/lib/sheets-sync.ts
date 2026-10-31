import type { WorkspaceRole } from "@/db/schema/app";
import type { JiraSyncError } from "./jira-sync";
import type { PropertyType } from "./property-types";
import { isDay } from "./date-value";
import { dayNumber, localDay, zonedInstant, zoneOffset } from "./time-zone";
import { contentRole } from "./workspace-roles";

/**
 * Keeping a database in step with one sheet of a Google spreadsheet (server/sheets-sync for setting
 * it up, reading and writing, server/jira-sync/run for the runs every synced database shares).
 * The sheet is read through a workspace's Google Sheets connection (an outbound MCP connection,
 * see server/connections) with its `get_spreadsheet` tool, as typed cells, so numbers and dates
 * don't depend on how the spreadsheet's language writes them. Pure, shared by the server, the
 * import dialog and the sync's dialog on the database.
 *
 * The header row names the columns: each row below it with a key becomes a row, found again by
 * its key column's text, named by its title column, with a property for each other named column
 * (SheetsMapping, by header). Rows above the header are left out, as are columns without a
 * header. Rows that leave the sheet stay as they are; a row repeating an earlier row's key is
 * left out (`repeatedKeys`).
 *
 * A sheet without a column whose values differ in every row is synced by place (`keyColumn` ""):
 * each row below the header with anything in it is found again by its sheet row number, kept in a
 * hidden number property (the mapping's key), the title column is a property too, and a row whose
 * place has nothing in it any more goes to the trash, its number taken off first so it never
 * stands for a later row there. Inserting, deleting or sorting rows in the sheet moves values
 * between rows. Such a sync only reads.
 *
 * A sync reads only, or writes back too (`direction` "both"): then changes made to its rows in
 * Leafdesk wait in `sheets_write` and the next run writes them to the sheet with the connection's
 * `update_values` (planWrites) before it reads. A change is written only where the sheet's cell
 * still holds what the row had before it; where both changed, the sheet's value stays. The key
 * column and columns of formulas are never written; rows made in Leafdesk are added below the
 * sheet's last row once they have a key; deleting a row deletes nothing in the sheet.
 */

/** The connection's tool a sync reads with. */
export const SHEETS_TOOL = "get_spreadsheet";
/** The connection's tools a sync writes back with: cells of a range, and rows added to a sheet with no room left. */
export const WRITE_TOOLS = ["update_values", "insert_dimension"] as const;
export type SheetsWriteTool = (typeof WRITE_TOOLS)[number];

/** Whether a sync only reads the sheet, or writes changes made in Leafdesk back to it too. */
export const SHEETS_DIRECTIONS = ["read", "both"] as const;
export type SheetsDirection = (typeof SHEETS_DIRECTIONS)[number];
/** Rows a run writes to the sheet at most; the rest wait for the next one. */
export const MAX_SHEET_WRITES = 200;
/** The field of `sheets_write.before` that holds the title (the others are property ids). */
export const TITLE_FIELD = "title";

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
  /** "" for a sync by place (see above). */
  keyColumn: string;
  titleColumn: string;
  /** "read" when left out. */
  direction?: SheetsDirection;
  /** Rows the last run left out for repeating an earlier row's key. */
  repeatedKeys?: number;
  /** Why the last run couldn't write to the sheet (its reading went on), with Google's words. */
  writeError?: SheetsSyncError | null;
  writeErrorDetail?: string | null;
  /** The columns the last run found formulas in: never written. */
  formulaColumns?: string[];
};

/** How a column's values are written: the kind of property it became. */
export const SHEETS_KINDS = ["text", "number", "checkbox", "date", "time"] as const;
export type SheetsKind = (typeof SHEETS_KINDS)[number];

/** Whether a sync finds rows by their place in the sheet, having no key column. */
export const byPlace = (query: Pick<SheetsQuery, "keyColumn">) => !query.keyColumn;

/** The type of a sync's key property: the key column's text, or the sheet row number of a sync by place. */
export const keyType = (query: Pick<SheetsQuery, "keyColumn">): PropertyType => (byPlace(query) ? "number" : "text");

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
  /** "" for a sync by place. */
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
  direction: SheetsDirection;
  /** Whether the viewer may have the sync write back (sheetsWriteAccess). */
  canWrite: boolean;
  writeError: SheetsSyncError | null;
  writeErrorDetail: string | null;
  formulaColumns: string[];
  /** Rows whose changes wait to be written. */
  pendingWrites: number;
  /** Rows the last run left out for repeating an earlier row's key. */
  repeatedKeys: number;
};

/** A connection the person may sync through, as the import dialog shows it (never its secrets). */
export type SheetsSource = { id: string; name: string; canWrite: boolean };

/** Whether a person may read spreadsheets through a connection, given their role. */
export function sheetsAccess(row: { status: string; tools: { name: string }[]; chatTools: string[] }, role: WorkspaceRole): boolean {
  if (row.status !== "ready" || !row.tools.some((t) => t.name === SHEETS_TOOL)) return false;
  // Owners manage the connection; members read through it only what an owner lets their AI chat read.
  return role === "owner" || (contentRole(role) === "member" && row.chatTools.includes(SHEETS_TOOL));
}

/** Whether a person may also write spreadsheets through a connection: its write tools, as sheetsAccess has its read tool. */
export function sheetsWriteAccess(row: { status: string; tools: { name: string }[]; chatTools: string[] }, role: WorkspaceRole): boolean {
  if (!sheetsAccess(row, role) || !WRITE_TOOLS.every((tool) => row.tools.some((t) => t.name === tool))) return false;
  return role === "owner" || WRITE_TOOLS.every((tool) => row.chatTools.includes(tool));
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
/** What it asks for then: each cell's typed value, its text as shown, its number format and its formula. */
export const GRID_FIELDS = [
  "sheets.data.rowData.values.effectiveValue",
  "sheets.data.rowData.values.formattedValue",
  "sheets.data.rowData.values.effectiveFormat.numberFormat.type",
  "sheets.data.rowData.values.userEnteredValue.formulaValue",
];

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
  userEnteredValue?: { formulaValue?: string };
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

/** The spreadsheet's zone, or UTC when it is none Leafdesk knows. */
function zoneOr(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** A date-time serial as the instant it names in the spreadsheet's zone (ISO, UTC), to the minute. */
export function serialTime(serial: number, timeZone: string): string | null {
  const day = Math.floor(serial);
  const minutes = Math.round((serial - day) * 1440);
  const at = new Date(zonedInstant(day - SERIAL_EPOCH, minutes, zoneOr(timeZone)));
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

/**
 * The sheet's rows below the header as synced items, in the sheet's order: those with a key, or for
 * a sync by place those with anything in a named column, keyed by their sheet row number. Null
 * when the key column is gone.
 */
export function sheetItems(
  grid: SheetCell[][],
  query: Pick<SheetsQuery, "keyColumn" | "titleColumn" | "headerRow">,
  mapping: Partial<SheetsMapping>,
  timeZone: string,
) {
  const headers = sheetHeaders(grid[0] ?? []);
  const at = (name: string) => headers.find((h) => h.name === name)?.index;
  const columns = (mapping.columns ?? []).flatMap((c) => {
    const index = at(c.column);
    return index === undefined ? [] : [{ ...c, index }];
  });
  if (byPlace(query)) {
    const title = at(query.titleColumn);
    return grid.slice(1).flatMap((row, i) => {
      if (!headers.some((h) => cellText(row[h.index]).trim())) return [];
      const place = query.headerRow + i + 1;
      const values: Record<string, unknown> = {};
      if (mapping.key) values[mapping.key] = place;
      for (const c of columns) values[c.property] = cellValue(c.kind, row[c.index], timeZone);
      return [{ key: String(place), title: title === undefined ? "" : cellText(row[title]).trim().slice(0, 2000), values }];
    });
  }
  const key = at(query.keyColumn);
  if (key === undefined) return null;
  const title = at(query.titleColumn) ?? key;
  return grid.slice(1).flatMap((row) => {
    const keyText = cellText(row[key]).trim().slice(0, 2000);
    if (!keyText) return [];
    const values: Record<string, unknown> = {};
    if (mapping.key) values[mapping.key] = keyText;
    for (const c of columns) values[c.property] = cellValue(c.kind, row[c.index], timeZone);
    return [{ key: keyText, title: cellText(row[title]).trim().slice(0, 2000) || keyText, values }];
  });
}

/** How many items repeat an earlier item's key (a run keeps the first). */
export const repeatedKeys = (items: { key: string }[]) => items.length - new Set(items.map((item) => item.key)).size;

/** Whether a cell holds a formula. */
const isFormula = (cell: SheetCell | undefined) => typeof cell?.userEnteredValue?.formulaValue === "string";

/** The columns (by index) with a formula in a cell below the header: a sync never writes them. */
export function formulaColumns(grid: SheetCell[][]): Set<number> {
  const found = new Set<number>();
  for (const row of grid.slice(1)) row.forEach((cell, index) => isFormula(cell) && found.add(index));
  return found;
}

/** A value as a cell takes it: what `update_values` writes. */
export type CellInput = string | number | boolean;

/**
 * A row's value as its column's cell takes it ("" to empty it, false for an unticked box), the
 * start of a range of dates, to the minute; undefined for what isn't written: text starting with
 * "=", which a sheet could take for a formula.
 */
export function sheetInput(kind: SheetsKind, value: unknown, timeZone: string): CellInput | undefined {
  if (value === null || value === undefined || value === "") return kind === "checkbox" ? false : "";
  switch (kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "checkbox":
      return value === true;
    case "date":
    case "time": {
      const start = String(value).split("/")[0];
      if (isDay(start)) return dayNumber(start) + SERIAL_EPOCH;
      const at = Date.parse(start);
      if (Number.isNaN(at)) return undefined;
      const zone = zoneOr(timeZone);
      if (kind === "date") return localDay(at, zone) + SERIAL_EPOCH;
      return Math.round(((at + zoneOffset(at, zone)) / 86_400_000 + SERIAL_EPOCH) * 1440) / 1440;
    }
    default: {
      const text = typeof value === "string" ? value : String(value);
      return /^\s*=/.test(text) ? undefined : text;
    }
  }
}

/** Whether two values of a column's kind are the same (a missing value, "" and an unticked box alike; times to the minute). */
export function sameValue(kind: SheetsKind, a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === "" || v === false;
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  switch (kind) {
    case "number":
      return Number(a) === Number(b);
    case "checkbox":
      return true;
    case "date":
      return String(a).split("/")[0] === String(b).split("/")[0];
    case "time": {
      const minute = (v: unknown) => Math.round(Date.parse(String(v).split("/")[0]) / 60_000);
      return minute(a) === minute(b);
    }
    default:
      return String(a).trim() === String(b).trim();
  }
}

/**
 * What a database's page shows of a sync that writes back: how many changes wait for the sheet,
 * whether the last write failed, and whether the viewer may write them now (Sync now).
 */
/** A change waiting to be written (a `sheets_write` row). */
export type PendingWrite = { id: string; rowId: string; created: boolean; before: Record<string, unknown> };

/** What a run writes: cells of rows the sheet has, rows to add after its last, and the changes it is done with. */
export type WritePlan = {
  /** One per sheet row: its number (from 1), the first column (from 0) and the cells from there (null leaves one as it is). */
  updates: { row: number; column: number; values: (CellInput | null)[] }[];
  /** Rows to add, from column A, at sheet row `appendAt` on (right below the last row with anything in it). */
  appends: (CellInput | null)[][];
  appendAt: number;
  /** The entries written, already the same, given up (the sheet changed too, the row is gone) or left out. */
  done: string[];
  /** New rows that take their key from their title (the key column names rows): their key property gets it first. */
  keyed: { rowId: string; key: string }[];
  /**
   * By entry, of rows the sheet has (or gets): what each field it looked at holds in the sheet once
   * written, which an entry changed again meanwhile takes as its `before`.
   */
  settled: Record<string, Record<string, unknown>>;
};

/**
 * What to write for the changes waiting (lib/sheets-sync explains the rules), given the sheet as
 * just read (`grid` from the header row down) and the rows as they are now (missing once gone or
 * in the trash). Entries left out of `done` wait: new rows without a key yet. `taken`: the keys rows
 * of the database already have: a new row titled like one of them stays in Leafdesk alone, so two
 * rows never share a key.
 */
export function planWrites(
  grid: SheetCell[][],
  query: Pick<SheetsQuery, "keyColumn" | "titleColumn" | "headerRow">,
  mapping: SheetsMapping,
  timeZone: string,
  pending: PendingWrite[],
  rows: Map<string, { title: string; properties: Record<string, unknown> }>,
  taken: Set<string> = new Set(),
): WritePlan {
  const lastData = grid.findLastIndex((cells) => cells.some((cell) => cellText(cell).trim() !== ""));
  const plan: WritePlan = { updates: [], appends: [], appendAt: query.headerRow + Math.max(lastData, 0) + 1, done: [], keyed: [], settled: {} };
  const headers = sheetHeaders(grid[0] ?? []);
  const at = (name: string) => headers.find((h) => h.name === name)?.index;
  const keyIndex = at(query.keyColumn);
  if (keyIndex === undefined) return plan;
  const formulas = formulaColumns(grid);
  const fields = new Map<string, { index: number; kind: SheetsKind }>();
  for (const c of mapping.columns) {
    const index = at(c.column);
    if (index !== undefined && index !== keyIndex && !formulas.has(index)) fields.set(c.property, { index, kind: c.kind });
  }
  const titleIndex = query.titleColumn === query.keyColumn ? undefined : at(query.titleColumn);
  if (titleIndex !== undefined && !formulas.has(titleIndex)) fields.set(TITLE_FIELD, { index: titleIndex, kind: "text" });

  // A key's sheet row, the first with it (as a run reads them).
  const byKey = new Map<string, number>();
  grid.forEach((cells, i) => {
    const key = cellText(cells[keyIndex]).trim();
    if (i > 0 && key && !byKey.has(key)) byKey.set(key, i);
  });
  const valueOf = (row: { title: string; properties: Record<string, unknown> }, field: string) =>
    field === TITLE_FIELD ? row.title.trim() || null : row.properties[field];

  for (const entry of pending) {
    const row = rows.get(entry.rowId);
    if (!row) {
      plan.done.push(entry.id);
      continue;
    }
    const own = row.properties[mapping.key];
    let key = typeof own === "string" ? own.trim() : "";
    // A new row in a sheet whose key column names rows is found by its title.
    const fromTitle = !key && entry.created && query.titleColumn === query.keyColumn ? row.title.trim() : "";
    key ||= fromTitle;
    if (!key) {
      if (!entry.created) plan.done.push(entry.id);
      continue;
    }
    plan.done.push(entry.id);
    if (fromTitle && taken.has(key)) continue;
    if (fromTitle) plan.keyed.push({ rowId: entry.rowId, key });
    const index = byKey.get(key);
    if (index === undefined) {
      // A row that left the sheet stays out of it; one made in Leafdesk is added.
      if (!entry.created) continue;
      const cells: (CellInput | null)[] = Array(Math.max(keyIndex, ...[...fields.values()].map((f) => f.index)) + 1).fill(null);
      cells[keyIndex] = key;
      const settled: Record<string, unknown> = {};
      for (const [field, { index: column, kind }] of fields) {
        const input = sheetInput(kind, valueOf(row, field), timeZone);
        if (input !== undefined && input !== "" && input !== false) cells[column] = input;
        settled[field] = input === undefined ? null : valueOf(row, field);
      }
      plan.settled[entry.id] = settled;
      plan.appends.push(cells);
      byKey.set(key, -1);
      continue;
    }
    if (index < 0) continue;
    const cells = grid[index];
    const changed = new Map<number, CellInput>();
    const settled: Record<string, unknown> = {};
    plan.settled[entry.id] = settled;
    for (const field of entry.created ? fields.keys() : Object.keys(entry.before)) {
      const target = fields.get(field);
      if (!target || isFormula(cells[target.index])) continue;
      const cell = cells[target.index];
      const now = field === TITLE_FIELD ? cellText(cell).trim() || null : cellValue(target.kind, cell, timeZone);
      const current = valueOf(row, field);
      settled[field] = now;
      if (sameValue(target.kind, current, now)) continue;
      // Changed in the sheet too: the sheet's value stays (and comes back to the row).
      if (!sameValue(target.kind, now, entry.created ? null : entry.before[field])) continue;
      const input = sheetInput(target.kind, current, timeZone);
      if (input === undefined) continue;
      changed.set(target.index, input);
      settled[field] = current;
    }
    if (!changed.size) continue;
    const columns = [...changed.keys()].sort((a, b) => a - b);
    const first = columns[0];
    const values = Array.from({ length: columns.at(-1)! - first + 1 }, (_, i) => changed.get(first + i) ?? null);
    plan.updates.push({ row: query.headerRow + index, column: first, values });
  }
  return plan;
}

/** The A1 range of `rows` × `columns` cells from sheet row `row` and column `column` (both from the sheet's start: 1 and 0). */
export function cellRange(sheetTitle: string, row: number, column: number, columns: number, rows = 1) {
  return `'${sheetTitle.replace(/'/g, "''")}'!${columnLetter(column)}${row}:${columnLetter(column + columns - 1)}${row + rows - 1}`;
}
