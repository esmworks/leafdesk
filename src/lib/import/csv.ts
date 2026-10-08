import type { PropertyType } from "../property-types";
import { isEmailAddress, isPhoneNumber } from "../properties";

/**
 * Reading CSV files for import (see server/import/csv.ts): parsing, guessing each column's
 * property type, and turning cells into property values. Pure, so the import dialog runs the same
 * code to preview a file as the server runs to import it.
 */

/** Most rows and columns one CSV import takes. */
export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_COLUMNS = 100;

/** Property types a new database's columns can be imported as. */
export const CSV_COLUMN_TYPES = ["text", "number", "select", "multi_select", "date", "checkbox", "url", "email", "phone"] as const;
export type CsvColumnType = (typeof CSV_COLUMN_TYPES)[number];

export type CsvTable = { headers: string[]; rows: string[][] };

/**
 * A text file's bytes as text: UTF-8 when they are (with or without a BOM), else Windows-1254,
 * what Excel on a Turkish (or, for the letters they share, Western) Windows saves CSV files in.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}

/** The field separator a file uses: whichever of comma, semicolon and tab its first line has most of. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * RFC 4180 records: quoted fields may hold separators, quotes ("") and line breaks; CRLF, LF and
 * CR all end a record. A leading BOM is dropped, and so is a last empty line.
 */
export function parseCsv(text: string, delimiter = detectDelimiter(text.replace(/^\uFEFF/, ""))): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === "\r" || ch === "\n") {
      endRecord();
      if (ch === "\r" && input[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (field !== "" || record.length) endRecord();
  return records;
}

/**
 * Leafdesk's CSV export (lib/csv) puts an apostrophe before cells a spreadsheet would run as a
 * formula; importing takes it off again.
 */
function unguard(cell: string) {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/**
 * A CSV file as a header and rows: header names trimmed, blank ones named "Column N" and repeats
 * numbered, every row as wide as the header, and rows with nothing in them left out.
 */
export function csvTable(text: string): CsvTable {
  return recordsTable(parseCsv(text));
}

/**
 * Records (the first one the header) as a table, the way csvTable reads a CSV file's. Workbooks
 * (lib/import/xlsx) come in here too; their cells are never guarded with an apostrophe, so
 * `guarded: false` keeps one that starts a cell.
 */
export function recordsTable([head = [], ...body]: string[][], { guarded = true } = {}): CsvTable {
  const clean = guarded ? unguard : (cell: string) => cell;
  const headers: string[] = [];
  const taken = new Set<string>();
  head.forEach((raw, i) => {
    const base = clean(raw).replace(/\s+/g, " ").trim().slice(0, 100) || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    headers.push(name);
  });
  const rows = body
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => headers.map((_, i) => clean(r[i] ?? "")));
  return { headers, rows };
}

// English, Turkish, German, Spanish and French.
const TITLE_HEADERS = ["name", "title", "page", "ad", "isim", "başlık", "baslik", "sayfa", "titel", "seite", "nombre", "título", "titulo", "página", "titre", "nom"];

/** The column that becomes each row's title: one called Name or Title (or Ad, Başlık, Titel, Nombre, Titre…), else the first. */
export function guessTitleColumn(headers: string[]): number {
  // Both ways of lower-casing: Turkish makes "TITLE" "tıtle", others make "BAŞLIK" "başlik".
  const i = headers.findIndex((h) => [h.trim().toLowerCase(), h.trim().toLocaleLowerCase("tr")].some((l) => TITLE_HEADERS.includes(l)));
  return i === -1 ? 0 : i;
}

// Values

/**
 * A number as people write it: `1234.5`, `-3`, `1e6`, `1,234,567.89` (comma thousands),
 * `1.234,5` (dot thousands, comma decimals) or `3,14` (comma decimals). Null for anything else.
 */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s  ]/g, "");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Numbers that would lose something as a number: a leading zero (postcodes, phone numbers) or more
 * digits than a double keeps exactly (ids).
 */
function looksLikeCode(raw: string) {
  const s = raw.trim();
  return /^[+-]?0\d/.test(s) || s.replace(/\D/g, "").length > 15;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "evet", "ja", "wahr", "sí", "si", "verdadero", "oui", "vrai", "checked", "✓", "✔", "[x]", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "hayır", "hayir", "nein", "falsch", "falso", "non", "faux", "unchecked", "[ ]", "✗"]);

/** A checkbox cell: yes/no words (English, Turkish, German, Spanish, French), true/false, 1/0, ✓. Null for anything else. */
export function parseCheckbox(raw: string, { numbers = true } = {}): boolean | null {
  const s = raw.trim().toLocaleLowerCase("tr").replace(/ı/g, "i");
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word) || TRUE_WORDS.has(s) || (numbers && s === "1")) return true;
  if (FALSE_WORDS.has(word) || FALSE_WORDS.has(s) || (numbers && s === "0")) return false;
  return null;
}

/**
 * How a column writes its dates. Slash dates that could be either way round read month first
 * (spreadsheets in English write them so); a day over 12 anywhere in the column switches to day
 * first. Dots are always day first (1.2.2026 is 1 February).
 */
export const DATE_FORMATS = ["iso", "ymd", "dmy", "mdy", "dmy-slash", "text"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const pad = (n: number) => String(n).padStart(2, "0");

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || year < 1 || year > 9999) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** A date cell as YYYY-MM-DD in the given format; null when it isn't one. Times are dropped. */
export function parseDate(raw: string, format: DateFormat): string | null {
  // A Notion date range ("May 1, 2026 → May 3, 2026") keeps its start.
  const s = raw.split(/\s+(?:→|->)\s+/)[0].trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case "iso":
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
      return m ? isoDay(+m[1], +m[2], +m[3]) : null;
    case "ymd":
      m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
      return m ? isoDay(+m[1], +m[2], +m[3]) : null;
    case "dmy":
      m = /^(\d{1,2})[.-](\d{1,2})[.-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
      return m ? isoDay(+m[3], +m[2], +m[1]) : null;
    case "mdy":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i.exec(s);
      return m ? isoDay(+m[3], +m[1], +m[2]) : null;
    case "dmy-slash":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
      return m ? isoDay(+m[3], +m[2], +m[1]) : null;
    case "text": {
      // "September 28, 2026", "28 Sep 2026", "Sep 28, 2026 10:00 AM": needs a month name and a year.
      if (!/[a-z]{3}/i.test(s) || !/\b\d{4}\b/.test(s) || s.length > 40) return null;
      const time = Date.parse(s);
      if (Number.isNaN(time)) return null;
      const d = new Date(time);
      return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }
}

/** The first format every value parses in; null when there is none. */
export function detectDateFormat(values: string[]): DateFormat | null {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return null;
  return DATE_FORMATS.find((f) => filled.every((v) => parseDate(v, f) !== null)) ?? null;
}

/** A multi-value cell's values: split at commas (and semicolons), blanks and repeats dropped. */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const v = part.trim();
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

const isUrl = (s: string) => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(s.trim());

/** Longest option name a guessed select column may have, and most distinct options. */
const MAX_OPTION_LENGTH = 50;
const MAX_OPTIONS = 30;

export type ColumnGuess = {
  type: CsvColumnType;
  /** Select and multi-select columns: their options, in order of first appearance. */
  options?: string[];
  /** Date columns: how their dates are written. */
  dateFormat?: DateFormat;
};

/**
 * The property type a column's values suggest: number, checkbox, date, URL or email when every
 * filled cell reads as one; select when few distinct values repeat, multi-select when cells list
 * such values separated by commas; text otherwise (and for an empty column).
 */
export function guessColumn(values: string[]): ColumnGuess {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return { type: "text" };
  if (filled.every((v) => parseCheckbox(v, { numbers: false }) !== null)) return { type: "checkbox" };
  if (filled.every((v) => parseNumber(v) !== null && !looksLikeCode(v))) return { type: "number" };
  const dateFormat = detectDateFormat(filled);
  if (dateFormat) return { type: "date", dateFormat };
  if (filled.every(isUrl)) return { type: "url" };
  if (filled.every(isEmailAddress)) return { type: "email" };
  if (filled.some((v) => /[\r\n]/.test(v))) return { type: "text" };

  const fewEnough = (distinct: number, total: number) =>
    distinct <= MAX_OPTIONS && distinct < total && distinct <= Math.max(2, Math.ceil(total * 0.6));
  const lists = filled.map(splitList);
  if (lists.some((l) => l.length > 1)) {
    const tokens = lists.flat();
    const options = distinct(tokens);
    if (tokens.every((t) => t.length <= MAX_OPTION_LENGTH) && fewEnough(options.length, tokens.length)) {
      return { type: "multi_select", options };
    }
    return { type: "text" };
  }
  const options = distinct(filled);
  if (filled.every((v) => v.length <= MAX_OPTION_LENGTH) && fewEnough(options.length, filled.length)) {
    return { type: "select", options };
  }
  return { type: "text" };
}

function distinct(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
}

/** Checklist cells as Leafdesk exports them: one item per line, `[x] Done` or `[ ] Open`. */
export function parseChecklist(raw: string): { text: string; checked: boolean }[] {
  return raw
    .split(/\r?\n/)
    .map((line) => /^\s*(?:[-*]\s+)?(?:\[([ xX])\]\s*)?(.*)$/.exec(line)!)
    .filter((m) => m[2].trim())
    .map((m) => ({ text: m[2].trim(), checked: (m[1] ?? " ").toLowerCase() === "x" }));
}

/** Types a CSV column can be imported into; the rest are worked out by Leafdesk or hold uploads. */
export function isImportableType(type: PropertyType) {
  return !["created_by", "created_time", "last_edited_by", "last_edited_time", "formula", "rollup", "files"].includes(type);
}

export const INVALID = Symbol("invalid");

/**
 * A cell as a value for a property of `type`, in the form the server's row writes take (option
 * and people names, row titles for relations). Null for an empty cell, INVALID when the cell
 * can't be one (a word in a number column): the import leaves those cells empty and says how many.
 */
export function cellValue(type: PropertyType, raw: string, { dateFormat }: { dateFormat?: DateFormat } = {}): unknown {
  const s = raw.trim();
  if (!s) return null;
  switch (type) {
    case "number":
      return parseNumber(s) ?? INVALID;
    case "checkbox":
      return parseCheckbox(s) ?? INVALID;
    case "date": {
      const format = dateFormat ?? detectDateFormat([s]);
      return (format && parseDate(s, format)) || INVALID;
    }
    case "url":
      return isUrl(s) ? s : INVALID;
    case "email":
      return isEmailAddress(s.replace(/^mailto:/i, "")) ? s.replace(/^mailto:/i, "") : INVALID;
    case "phone":
      return isPhoneNumber(s.replace(/^tel:/i, "")) ? s.replace(/^tel:/i, "") : INVALID;
    case "select":
    case "status":
      return s.slice(0, 200);
    case "multi_select":
    case "person":
    case "relation":
      return splitList(s).map((v) => v.slice(0, 200));
    case "checklist": {
      const items = parseChecklist(raw);
      return items.length ? items : null;
    }
    case "text":
      return raw;
    default:
      return INVALID;
  }
}
