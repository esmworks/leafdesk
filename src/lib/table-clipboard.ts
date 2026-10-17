import { dateValueText } from "./date-value";
import { isErrorValue } from "./derived";
import { asFiles } from "./files";
import { cellValue, detectDateFormat, INVALID, isImportableType, parseCsv, type DateFormat } from "./import/csv";
import { asChecklist, displayValue } from "./properties";
import { holdsPeople } from "./property-types";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";

/**
 * A database table as a grid of cells: the cell the keyboard is on, the range Shift extends from
 * it, and copying and pasting ranges as tab-separated text, the way spreadsheets put cells on the
 * clipboard. Pure, so the table and its tests run the same code.
 */

/** A cell by its place in the table: the row's line (as shown) and the column (0 is the title). */
export type CellPoint = { row: number; col: number };

/** A range of cells: where it started and the opposite corner, which arrows with Shift move. */
export type CellRange = { anchor: CellPoint; focus: CellPoint };

export type CellBounds = { top: number; left: number; bottom: number; right: number };

export function rangeBounds({ anchor, focus }: CellRange): CellBounds {
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    right: Math.max(anchor.col, focus.col),
  };
}

export function inBounds(b: CellBounds, row: number, col: number) {
  return row >= b.top && row <= b.bottom && col >= b.left && col <= b.right;
}

export const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as const;
export type Arrow = keyof typeof ARROWS;
export const isArrow = (key: string): key is Arrow => key in ARROWS;

/**
 * The range after an arrow key: the active cell (the anchor) moves one step and the range collapses
 * onto it, or, with Shift, the opposite corner moves and the anchor stays. Edges stop it.
 */
export function moveRange(range: CellRange, key: Arrow, extend: boolean, size: { rows: number; cols: number }): CellRange {
  const [dRow, dCol] = ARROWS[key];
  const from = extend ? range.focus : range.anchor;
  const to = {
    row: Math.max(0, Math.min(size.rows - 1, from.row + dRow)),
    col: Math.max(0, Math.min(size.cols - 1, from.col + dCol)),
  };
  return extend ? { anchor: range.anchor, focus: to } : { anchor: to, focus: to };
}

/** A range kept inside a table that shrank (rows filtered out, columns hidden); null when it is empty. */
export function clampRange(range: CellRange, size: { rows: number; cols: number }): CellRange | null {
  if (!size.rows || !size.cols) return null;
  const clamp = (p: CellPoint) => ({ row: Math.min(p.row, size.rows - 1), col: Math.min(p.col, size.cols - 1) });
  const anchor = clamp(range.anchor);
  const focus = clamp(range.focus);
  if (anchor.row === range.anchor.row && anchor.col === range.anchor.col && focus.row === range.focus.row && focus.col === range.focus.col) {
    return range;
  }
  return { anchor, focus };
}

// ---------------------------------------------------------------------------------------------
// Copying

type CellProperty = { id: string; name: string; type: PropertyType; options: PropertyOptions };

export type CellTextContext = {
  /** Row titles of related rows, by id. */
  titleOf: ReadonlyMap<string, string>;
  /** People's names, by id. */
  nameOf: ReadonlyMap<string, string>;
  /** How an uploaded file is written. */
  fileText: (file: { name: string; url: string }) => string;
};

/**
 * A property value as one cell of text, as exports write it (and imports read back): option and
 * people names, related rows' titles, dates as `2026-10-12` or `2026-10-12 → 2026-10-14`,
 * checklists one `[x] item` per line. Numbers stay numbers.
 */
export function cellText(prop: CellProperty, value: unknown, ctx: CellTextContext): string | number | null {
  // A formula that fails on this row says why.
  if (isErrorValue(value)) return `#ERROR: ${value.error.message}`;
  if (prop.type === "files") return asFiles(value).map(ctx.fileText).join("\n") || null;
  if (prop.type === "date") return dateValueText(value);
  if (prop.type === "checklist") {
    return (
      asChecklist(value)
        .map((item) => `[${item.checked ? "x" : " "}] ${item.text}`)
        .join("\n") || null
    );
  }
  const shown = displayValue(prop, value);
  if (shown === null || shown === undefined || shown === "") return null;
  const names = holdsPeople(prop.type) ? ctx.nameOf : ctx.titleOf;
  if (Array.isArray(shown)) return shown.map((v) => names.get(String(v)) ?? String(v)).join(", ");
  if (typeof shown === "boolean") return shown ? "true" : "false";
  return typeof shown === "number" ? shown : String(shown);
}

/**
 * Cells as tab-separated text, rows ending in a line break, the way spreadsheets copy them: a cell
 * holding a tab, a line break or a quote is quoted (quotes doubled). Text a spreadsheet would run
 * as a formula gets a leading apostrophe; pasting it back here takes it off (see pastedGrid).
 */
export function toTsv(cells: (string | number | null)[][]): string {
  const cell = (value: string | number | null) => {
    if (value === null) return "";
    if (typeof value === "number") return String(value);
    const text = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return cells.map((row) => row.map(cell).join("\t")).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Pasting

/**
 * Pasted text as rows of cells. Spreadsheets put tab-separated rows on the clipboard, quoting
 * cells with line breaks; plain text is one cell per line. A last empty line is dropped, and so is
 * the apostrophe toTsv puts before formula-like text.
 */
export function pastedGrid(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, "\n");
  // A single line pastes as one cell as it is: commas and quotes in it are text.
  if (!/[\t\n]/.test(normalized.replace(/\n$/, ""))) return normalized.replace(/\n$/, "") === "" ? [] : [[unguard(normalized.replace(/\n$/, ""))]];
  const rows = parseCsv(normalized, "\t");
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => unguard(r[i] ?? "")));
}

const unguard = (cell: string) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell);

/** A column a paste can write to: the title, or a property (by id) of `type`. */
export type PasteColumn = { key: string; type: PropertyType | "title" };

export type PasteInput = {
  grid: string[][];
  /** The selected range; the paste starts at its top-left cell (a single pasted value fills it). */
  target: CellBounds;
  /** The ids of the rows as they show, top to bottom. */
  rowIds: string[];
  /** The table's columns, left to right. */
  columns: PasteColumn[];
  /** Whether the viewer may write this cell; `rowId` null for a row the paste adds. */
  canEdit: (rowId: string | null, key: string) => boolean;
  /** Whether the paste may add rows below the last one. */
  canAddRows: boolean;
  /** Times written without a zone are the viewer's. */
  timeZone?: string;
};

/** The values a row gets: its title under `title` when pasted, property values (option names, people, titles) by id. */
export type PastedRow = { title?: string; values: Record<string, unknown> };

export type PastePlan = {
  updates: (PastedRow & { rowId: string })[];
  newRows: PastedRow[];
  /** Cells that couldn't be a value of their column (a word in a number column). */
  invalid: number;
  /** Cells left alone: read-only columns, values the viewer may not change, past the last column. */
  skipped: number;
};

/**
 * What pasting `grid` at the target writes, cell by cell: each pasted cell goes to the cell as many
 * rows and columns from the target's top-left corner, read the way a CSV import reads it into
 * that column's type (see import/csv cellValue). Rows past the last one become new rows when the
 * paste may add them. One pasted value fills every selected cell.
 */
export function planPaste({ grid, target, rowIds, columns, canEdit, canAddRows, timeZone }: PasteInput): PastePlan {
  const plan: PastePlan = { updates: [], newRows: [], invalid: 0, skipped: 0 };
  if (!grid.length || !grid[0].length) return plan;
  const single = grid.length === 1 && grid[0].length === 1;
  const height = single ? target.bottom - target.top + 1 : grid.length;
  const width = single ? target.right - target.left + 1 : grid[0].length;
  const at = (r: number, c: number) => (single ? grid[0][0] : (grid[r]?.[c] ?? ""));

  // Dates read in the way the pasted column writes them (a day over 12 makes 3/4/2026 day first).
  const formats = new Map<number, DateFormat | undefined>();
  for (let c = 0; c < width; c++) {
    const column = columns[target.left + c];
    if (column?.type !== "date") continue;
    formats.set(c, detectDateFormat(Array.from({ length: height }, (_, r) => at(r, c))) ?? undefined);
  }

  for (let r = 0; r < height; r++) {
    const rowId = rowIds[target.top + r] ?? null;
    if (!rowId && !canAddRows) {
      plan.skipped += width;
      continue;
    }
    const row: PastedRow = { values: {} };
    let filled = false;
    for (let c = 0; c < width; c++) {
      const column = columns[target.left + c];
      const raw = at(r, c);
      if (!column || !writable(column.type) || !canEdit(rowId, column.key)) {
        if (column || raw.trim()) plan.skipped++;
        continue;
      }
      if (column.type === "title") {
        const title = raw.replace(/\s+/g, " ").trim();
        if (!title && !rowId) continue;
        row.title = title;
        filled = true;
        continue;
      }
      const value = cellValue(column.type, raw, { dateFormat: formats.get(c), timeZone });
      if (value === INVALID) {
        plan.invalid++;
        continue;
      }
      // A new row leaves empty cells out; an existing row's are cleared.
      if (value === null && !rowId) continue;
      row.values[column.key] = value;
      filled = true;
    }
    if (rowId) {
      if (filled) plan.updates.push({ ...row, rowId });
    } else if (filled) plan.newRows.push(row);
    // Rows between two pasted ones stay in place even when empty, so later rows land where they should.
    else plan.newRows.push({ values: {} });
  }
  // Empty rows at the end aren't worth adding.
  while (plan.newRows.length && isBlank(plan.newRows[plan.newRows.length - 1])) plan.newRows.pop();
  return plan;
}

const writable = (type: PasteColumn["type"]) => type === "title" || isImportableType(type);
const isBlank = (row: PastedRow) => !row.title && !Object.keys(row.values).length;
