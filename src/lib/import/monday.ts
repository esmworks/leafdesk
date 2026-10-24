import { CSV_MAX_COLUMNS, CSV_MAX_ROWS, decodeText, parseCsv } from "./csv";
import { cleanTitle } from "./markdown";
import { ImportError } from "./result";
import { readWorkbook, isWorkbook } from "./xlsx";
import {
  boardDateFormat,
  boardPlace,
  breakLoops,
  checkBoardSize,
  exportInstant,
  findItems,
  guessBoardColumn,
  inheritGroups,
  itemFinder,
  oneLine,
  statusGroupFor,
  type Board,
  type BoardColumn,
  type BoardColumnType,
  type BoardItem,
  type BoardOption,
} from "./board";
import { isEmailAddress, isPhoneNumber } from "../properties";

/**
 * Reading a Monday.com board exported to Excel (the board's menu → *Export board to Excel*), or
 * the same sheet saved as CSV, for import as a database (see lib/import/board).
 *
 * The sheet: the board's name on top, then each group as a block: the group's name on a row of
 * its own, a header row of column names (the item's name first), and a row per item. An item's
 * subitems follow it, one column in: a header row of the subitems' columns, then a row per
 * subitem. A workbook exported with updates has a sheet of them too (a row per update or reply:
 * the item's name or id, who wrote it, when, and its text); they become comments in the rows'
 * bodies. Other sheets are left out.
 *
 * The export doesn't say what kind each column is, so it is guessed from the column's name and
 * values (see guessMondayColumn); the import dialog lets the importer pick another. Monday's
 * "Subitems" column (the subitems' names) and "Item ID" column aren't properties: they place
 * subitems and find the items updates belong to.
 */

const isSubitemsHeader = (name: string) => /^sub-?items?$/i.test(name.trim());
const isItemIdHeader = (name: string) => /^(item|pulse) id$/i.test(name.trim());
const isDependencyHeader = (name: string) => /^(dependency|dependencies|depends on|blocked by)$/i.test(name.trim());

/** A link to a Monday item (…monday.com/boards/<board>/pulses/<item>, …/views/…/pulses/<item>); the item's id. */
export function mondayItemId(url: string): string | null {
  return /^https?:\/\/[a-z0-9-]+\.monday\.com\/boards\/\d+(?:\/views\/\d+)?\/pulses\/(\d+)(?:[/?#]|$)/i.exec(url)?.[1] ?? null;
}

/**
 * A column's kind from its name and values. By name: Status (and Stage, State) is a status whose
 * options' groups follow their names (Done is done, Working on it and Stuck in progress); Person,
 * People, Owner, Assignee and the like are people (matched by name); Tags and Dropdown a
 * multi-select; Phone a phone number when every value is one; Email an email address; Location
 * (Address, Place) a place when every value carries its coordinates (an address alone stays text:
 * the import doesn't look addresses up). By values:
 * numbers, dates and timelines ("2026-10-01 - 2026-10-05", a range), "v" checkboxes, links
 * ("Docs - https://…" keeps the address), yes/no words, repeating values (a select) and lists of
 * them (a multi-select), else text.
 */
export function guessMondayColumn(name: string, values: string[]): { type: BoardColumnType; options?: BoardOption[] } {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  const header = name.trim().toLowerCase();
  if (/^(status|stage|state)$|status$/.test(header) && filled.every((v) => v.length <= 50)) {
    return { type: "status", options: distinct(filled).map((label) => ({ name: label, group: statusGroupFor(label) })) };
  }
  if (/^(person|people|persons|owners?|assignees?|assigned to|responsible|team|members?|reviewers?)$/.test(header)) return { type: "person" };
  if (/^(tags?|labels?|dropdown)$/.test(header) && filled.every((v) => v.length <= 200)) return { type: "multi_select" };
  if (/phone|mobile/.test(header) && filled.length && filled.every((v) => isPhoneNumber(v))) return { type: "phone" };
  if (/e-?mail/.test(header) && filled.length && filled.every((v) => isEmailAddress(v.replace(/^.* - /, "")))) return { type: "email" };
  if (/timeline|date|deadline|due/.test(header) && boardDateFormat(filled)) return { type: "date" };
  if (/^(location|address|place|venue|map)$/.test(header) && filled.length && filled.every((v) => boardPlace(v))) return { type: "place" };
  return guessBoardColumn(filled);
}

function distinct(values: string[]) {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v.slice(0, 200));
  return [...seen.values()];
}

/** Whether a sheet's rows look like a Monday board: a header row under a group's name. */
export function isMondayBoard(rows: string[][]) {
  return headerRow(rows) !== -1;
}

const filledCount = (row: string[]) => row.filter((c) => c.trim()).length;
const single = (row: string[] | undefined) => !!row && !!row[0]?.trim() && filledCount(row) === 1;
const sameRow = (a: string[] | undefined, b: string[]) =>
  !!a && Math.max(a.length, b.length) > 0 && b.every((cell, i) => (a[i] ?? "").trim().toLowerCase() === cell.trim().toLowerCase()) && filledCount(a) === filledCount(b);

/** The first header row: a row of several names under a group's name (a plain table has its header on top). */
function headerRow(rows: string[][]) {
  return rows.findIndex((row, i) => filledCount(row) >= 2 && !!row[0]?.trim() && single(rows[i - 1]));
}

/**
 * A sheet of updates: a header with the update's text and the item it is on (by name or id),
 * and who wrote it and when when the sheet has them.
 */
function updatesColumns(header: string[]) {
  const find = (test: RegExp) => header.findIndex((h) => test.test(h.trim()));
  const text = find(/^(update content|update|updates|content|text|body)$/i);
  const item = find(/^(item name|item|name|pulse name)$/i);
  const itemId = find(/^(item id|pulse id)$/i);
  if (text === -1 || (item === -1 && itemId === -1)) return null;
  return { text, item, itemId, author: find(/^(user|author|created by|creator|written by)$/i), date: find(/^(created at|date|time|posted at|created)$/i) };
}

/**
 * The board in a sheet's rows (`rows` as the sheet has them: blank rows left out, cells from column
 * A on) and, when the workbook has them, its updates (a sheet's rows, the header first).
 */
export function readMondayRows(rows: string[][], { fileName = "", updates }: { fileName?: string; updates?: string[][] } = {}): Board {
  const start = headerRow(rows);
  if (start === -1) throw notMonday();
  const header = rows[start].map((h) => oneLine(h).slice(0, 100));

  // Single-cell rows over the first header: the board's name, then the first group's.
  let above = 0;
  while (single(rows[start - 1 - above])) above++;
  const title = above >= 2 ? oneLine(rows[start - above][0]) : cleanTitle(fileName);
  const groups: string[] = [];
  const addGroup = (name: string) => {
    const s = oneLine(name).slice(0, 200);
    const i = groups.findIndex((g) => g.toLowerCase() === s.toLowerCase());
    return i === -1 ? groups.push(s) - 1 : i;
  };
  let group: number | null = above >= 1 ? addGroup(rows[start - 1][0]) : null;

  // Columns by name: the items' and the subitems', those of the same name as one.
  const columns: { name: string }[] = [];
  const columnOf = (name: string) => {
    const key = name.toLowerCase();
    let i = columns.findIndex((c) => c.name.toLowerCase() === key);
    if (i === -1) i = columns.push({ name }) - 1;
    return i;
  };
  type Raw = { title: string; id: string | null; group: number | null; parent: number | null; values: Map<number, string>; subitemNames: string[]; dependsOn: string };
  const raw: Raw[] = [];
  const layout = (names: string[]) =>
    names.map((name, i) => (i === 0 || !name || isSubitemsHeader(name) || isItemIdHeader(name) || isDependencyHeader(name) ? -1 : columnOf(name)));
  const itemLayout = layout(header);
  const itemHeader = header;
  let subLayout: number[] | null = null;
  let subHeader: string[] = [];
  let lastItem: number | null = null;

  const read = (cells: string[], names: string[], at: number[], parent: number | null): Raw => {
    const values = new Map<number, string>();
    at.forEach((col, i) => {
      if (col !== -1 && (cells[i] ?? "").trim()) values.set(col, cells[i]);
    });
    const cell = (test: (name: string) => boolean) => {
      const i = names.findIndex((n) => test(n));
      return i === -1 ? "" : (cells[i] ?? "").trim();
    };
    return {
      title: oneLine(cells[0] ?? ""),
      id: cell(isItemIdHeader) || null,
      group,
      parent,
      values,
      subitemNames: cell(isSubitemsHeader) ? cell(isSubitemsHeader).split(/\s*,\s*/).filter(Boolean) : [],
      dependsOn: cell(isDependencyHeader),
    };
  };

  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r];
    if (sameRow(row, itemHeader)) {
      subLayout = null;
      lastItem = null;
      continue;
    }
    // A group's name over its header (repeated for every group).
    if (single(row) && sameRow(rows[r + 1], itemHeader)) {
      group = addGroup(row[0]);
      r++;
      subLayout = null;
      lastItem = null;
      continue;
    }
    if (row[0]?.trim()) {
      raw.push(read(row, itemHeader, itemLayout, null));
      lastItem = raw.length - 1;
      subLayout = null;
      continue;
    }
    // Rows one column in: the subitems' header right under an item, then its subitems.
    if (lastItem === null || !row[1]?.trim()) continue;
    const shifted = row.slice(1);
    if (!subLayout) {
      subHeader = shifted.map((h) => oneLine(h).slice(0, 100));
      subLayout = layout(subHeader);
      continue;
    }
    if (sameRow(shifted, subHeader)) continue;
    raw.push({ ...read(shifted, subHeader, subLayout, lastItem), group: raw[lastItem].group });
  }

  // Subitems named in an item's Subitems column but not exported under it: rows of their own, by name.
  for (let i = 0, n = raw.length; i < n; i++) {
    if (raw[i].parent !== null || !raw[i].subitemNames.length || raw.some((s) => s.parent === i)) continue;
    for (const name of raw[i].subitemNames) raw.push({ title: oneLine(name), id: null, group: raw[i].group, parent: i, values: new Map(), subitemNames: [], dependsOn: "" });
  }
  // Each item followed by its subitems.
  const order = raw.flatMap((item, i) => (item.parent === null ? [i, ...raw.flatMap((s, j) => (s.parent === i ? [j] : []))] : []));
  const index = new Map(order.map((old, i) => [old, i]));
  const sorted = order.map((i) => raw[i]);
  checkBoardSize(sorted.length, columns.length);

  const boardColumns: BoardColumn[] = columns.map((c, i) => ({
    name: c.name,
    ...guessMondayColumn(c.name, sorted.map((item) => item.values.get(i) ?? "")),
  }));
  const items: BoardItem[] = sorted.map((item) => ({
    id: item.id,
    title: item.title,
    group: item.group,
    parent: item.parent === null ? null : index.get(item.parent)!,
    blockedBy: [],
    done: null,
    dates: null,
    cells: columns.map((_, i) => item.values.get(i) ?? ""),
    body: "",
    attachments: [],
    comments: [],
  }));

  const find = itemFinder(items);
  const missing = { dependencies: { count: 0 }, updates: { count: 0 } };
  sorted.forEach((item, i) => {
    for (const b of findItems(find, item.dependsOn, missing.dependencies)) if (b !== i && !items[i].blockedBy.includes(b)) items[i].blockedBy.push(b);
  });
  const loops = breakLoops(items);
  inheritGroups(items);

  // Updates, oldest first on each item.
  const [updatesHeader = [], ...updateRows] = updates ?? [];
  const at = updatesColumns(updatesHeader);
  if (at) {
    for (const row of updateRows) {
      const text = (row[at.text] ?? "").trim();
      if (!text) continue;
      const i = (at.itemId !== -1 ? find((row[at.itemId] ?? "").trim()) : null) ?? (at.item !== -1 ? find(row[at.item] ?? "") : null);
      if (i === null) {
        missing.updates.count++;
        continue;
      }
      const date = at.date === -1 ? null : updateTime(row[at.date] ?? "");
      items[i].comments.push({ author: oneLine(at.author === -1 ? "" : (row[at.author] ?? "")) || "?", date, text });
    }
    for (const item of items) item.comments.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  const dependencyHeader = [...header, ...subHeader].find(isDependencyHeader) ?? "";
  const unlinked = [
    { column: dependencyHeader, count: missing.dependencies.count + loops.dependencies },
    { column: (at && (updatesHeader[at.item] ?? updatesHeader[at.itemId])) || "", count: missing.updates.count },
  ].filter((u) => u.count > 0 && u.column);
  return { source: "monday", title, groups, columns: boardColumns, items, leftOut: [], otherSheets: [], unlinked, linkedId: mondayItemId };
}

/** An update's time: an ISO time as the workbook writes it (UTC without a zone), else null. */
function updateTime(raw: string): string | null {
  return exportInstant(raw.trim()) ?? (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? `${raw.trim()}T00:00:00.000Z` : null);
}

const notMonday = () => new ImportError("The file isn't a Monday.com board export", "badMonday");

/** Most rows a board's sheet may have: the items with their group and header rows. */
const SHEET_ROWS = CSV_MAX_ROWS * 2;

/**
 * Reads an export: a workbook (its first sheet the board, a sheet of updates when there is one) or
 * a CSV file of the board's sheet. Throws ImportError("badMonday") when it is neither, or a size
 * error past an import's limits.
 */
export function readMondayExport(fileName: string, bytes: Uint8Array): Board {
  if (!isWorkbook(fileName, bytes)) {
    const records = parseCsv(decodeText(bytes)).filter((r) => r.some((c) => c.trim()));
    if (records.length > SHEET_ROWS) throw new ImportError(`A board can have at most ${CSV_MAX_ROWS} items`, "tooManyRows", { limit: CSV_MAX_ROWS });
    if (!isMondayBoard(records)) throw notMonday();
    return readMondayRows(records, { fileName });
  }
  const book = readWorkbook(bytes);
  const sheet = (i: number) => {
    const cells = book.cells(i, { rows: SHEET_ROWS, columns: CSV_MAX_COLUMNS });
    if (cells.partial) throw new ImportError(`A board can have at most ${CSV_MAX_ROWS} items`, "tooManyRows", { limit: CSV_MAX_ROWS });
    return cells.rows.map((r) => r.cells);
  };
  const rows = sheet(0);
  if (!isMondayBoard(rows)) throw notMonday();
  let updates: string[][] | undefined;
  const otherSheets: string[] = [];
  for (const [i, { name }] of book.sheets.entries()) {
    if (i === 0) continue;
    const other = updates ? null : sheet(i);
    if (other && updatesColumns(other[0] ?? [])) updates = other;
    else otherSheets.push(name);
  }
  return { ...readMondayRows(rows, { fileName, updates }), otherSheets };
}
