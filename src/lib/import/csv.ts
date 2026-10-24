import type { PropertyType } from "../property-types";
import { fromPercentPoints, stripNumberDecor } from "../number-format";
import { checkDateInput } from "../date-value";
import { isEmailAddress, isPhoneNumber } from "../properties";
import { dayNumber, zonedInstant } from "../time-zone";

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

export { csvTable, decodeText, detectDelimiter, parseCsv, recordsTable, type CsvTable } from "./csv-parse";

// English, Turkish, German, Spanish, French, Italian, Portuguese, Polish, Russian, Ukrainian,
// Arabic, Hebrew, Persian, Japanese, Korean, Chinese, Indonesian, Thai and Vietnamese. Ukrainian's
// apostrophe comes typed three ways.
const TITLE_HEADERS = [
  ...["name", "title", "page", "ad", "isim", "başlık", "baslik", "sayfa", "titel", "seite", "nombre", "título", "titulo", "página", "titre", "nom"],
  ...["nome", "titolo", "pagina", "nazwa", "imię", "tytuł", "tytul", "strona"],
  ...["название", "наименование", "имя", "заголовок", "страница", "назва", "ім'я", "ім’я", "імʼя", "сторінка"],
  ...["الاسم", "اسم", "العنوان", "عنوان", "الصفحة", "שם", "כותרת", "עמוד", "نام", "صفحه"],
  ...["名前", "名称", "タイトル", "題名", "件名", "ページ", "이름", "제목", "페이지", "名字", "标题", "页面"],
  ...["nama", "judul", "halaman", "ชื่อ", "หัวข้อ", "หน้า", "tên", "tiêu đề", "trang"],
];

/** The column that becomes each row's title: one called Name or Title (or Ad, Başlık, Nome, Название, 名前…), else the first. */
export function guessTitleColumn(headers: string[]): number {
  // Both ways of lower-casing: Turkish makes "TITLE" "tıtle", others make "BAŞLIK" "başlik".
  const i = headers.findIndex((h) => [h.trim().toLowerCase(), h.trim().toLocaleLowerCase("tr")].some((l) => TITLE_HEADERS.includes(l)));
  return i === -1 ? 0 : i;
}

// Values

/**
 * A number as people write it: `1234.5`, `-3`, `1e6`, `1,234,567.89` (comma thousands),
 * `1.234,5` (dot thousands, comma decimals) or `3,14` (comma decimals), with a currency symbol
 * (`₺1.234,50`, `$12`) or a percent sign (`15%` is 0.15, as Leafdesk stores percentages). Null
 * for anything else.
 */
export function parseNumber(raw: string): number | null {
  const { text, percent } = stripNumberDecor(raw);
  let s = text.replace(/[\s  ]/g, "");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return percent ? fromPercentPoints(n) : n;
}

/** Whether every filled cell of a column is a percentage ("15%"): its number property then shows percentages. */
export function percentColumn(values: string[]): boolean {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  return filled.length > 0 && filled.every((v) => stripNumberDecor(v).percent && parseNumber(v) !== null);
}

/**
 * Numbers that would lose something as a number: a leading zero (postcodes, phone numbers) or more
 * digits than a double keeps exactly (ids).
 */
function looksLikeCode(raw: string) {
  const s = raw.trim();
  return /^[+-]?0\d/.test(s) || s.replace(/\D/g, "").length > 15;
}

// No word is "yes" in one language and "no" in another. Persian خیر ("no") only with the Persian
// ye: with the Arabic one it is "good".
const TRUE_WORDS = new Set([
  ...["true", "yes", "y", "evet", "ja", "wahr", "sí", "si", "verdadero", "oui", "vrai", "checked", "✓", "✔", "[x]", "x"],
  ...["vero", "sim", "verdadeiro", "tak", "prawda", "да", "истина", "так", "істина", "نعم", "صح", "صحيح", "כן", "אמת", "بله", "آره", "درست"],
  ...["はい", "真", "예", "네", "참", "是", "对"],
  ...["ya", "benar", "ใช่", "จริง", "có", "đúng"],
]);
const FALSE_WORDS = new Set([
  ...["false", "no", "n", "hayır", "hayir", "nein", "falsch", "falso", "non", "faux", "unchecked", "[ ]", "✗"],
  ...["não", "nao", "nie", "fałsz", "falsz", "нет", "ложь", "ні", "хибність", "لا", "خطأ", "לא", "שקר", "نه", "خیر", "نادرست"],
  ...["いいえ", "偽", "아니요", "아니오", "거짓", "否", "错", "假"],
  ...["tidak", "salah", "ไม่", "ไม่ใช่", "เท็จ", "không", "sai"],
]);

/**
 * A checkbox cell: yes/no words (English, Turkish, German, Spanish, French, Italian, Portuguese,
 * Polish, Russian, Ukrainian, Arabic, Hebrew, Persian, Japanese, Korean, Chinese, Indonesian,
 * Thai, Vietnamese), true/false, 1/0, ✓. Null for anything else.
 */
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

/** The day of a date written in `format`, without its time; null when it isn't one. */
function parseDay(s: string, format: DateFormat): string | null {
  let m: RegExpExecArray | null;
  switch (format) {
    case "iso":
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
      return m ? isoDay(+m[1], +m[2], +m[3]) : null;
    case "ymd":
      m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
      return m ? isoDay(+m[1], +m[2], +m[3]) : null;
    case "dmy":
      m = /^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/.exec(s);
      return m ? isoDay(+m[3], +m[2], +m[1]) : null;
    case "mdy":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      return m ? isoDay(+m[3], +m[1], +m[2]) : null;
    case "dmy-slash":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      return m ? isoDay(+m[3], +m[2], +m[1]) : null;
    case "text": {
      // "September 28, 2026", "28 Sep 2026": needs a month name and a year.
      if (!/[a-z]{3}/i.test(s) || !/\b\d{4}\b/.test(s) || s.length > 40) return null;
      const time = Date.parse(s);
      if (Number.isNaN(time)) return null;
      const d = new Date(time);
      return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }
}

/** A time of day written after a date ("14:30", "2:30 PM", "T10:00:00.000Z", "10:00 (GMT+3)"). */
const TIME = /(?:[T\s]+(?:at\s+)?|^)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AP]M)?\s*(Z|[+-]\d{2}:?\d{2}|\((?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\))?$/i;

type CellTime = { minutes: number; offset: number | null };

/** A cell side split into its date text and its time (null without one). */
function splitTime(s: string): { rest: string; time: CellTime | null } | null {
  const m = TIME.exec(s);
  if (!m) return { rest: s, time: null };
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59 || hours > 23 || (m[4] && (hours < 1 || hours > 12))) return null;
  if (m[4]) hours = (hours % 12) + (/pm/i.test(m[4]) ? 12 : 0);
  let offset: number | null = null;
  const zone = m[5];
  if (zone && /^z$/i.test(zone)) offset = 0;
  else if (zone && /^[+-]/.test(zone)) {
    const [, sign, h, mm] = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    offset = (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(mm));
  } else if (zone) offset = m[6] ? (m[6] === "-" ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8] ?? 0)) : 0;
  return { rest: s.slice(0, m.index).replace(/[,\s]+$/, ""), time: { minutes: hours * 60 + minutes, offset } };
}

/** The instant of `day` at `time`: its own offset when it was written with one, else `timeZone`'s. */
function cellInstant(day: string, time: CellTime, timeZone: string): string {
  const at =
    time.offset === null
      ? zonedInstant(dayNumber(day), time.minutes, timeZone)
      : dayNumber(day) * 86_400_000 + (time.minutes - time.offset) * 60_000;
  return new Date(at).toISOString();
}

/**
 * A date cell in the given format as a date property value (see lib/date-value): a day, or a time
 * when the cell has one ("Sep 28, 2026 10:00 AM"), placed in its own zone when written ("Z",
 * "+03:00", "(GMT+3)") or else in `timeZone` (the importing person's). A range written with an
 * arrow ("May 1, 2026 → May 3, 2026", "Oct 12, 2026 2:30 PM → 4:00 PM") keeps both ends; one
 * whose ends don't fit together keeps its start. Null when the cell isn't a date.
 */
export function parseDate(raw: string, format: DateFormat, timeZone = "UTC"): string | null {
  const [first, second] = raw.split(/\s+(?:→|->)\s+/).map((s) => s.trim());
  const start = splitTime(first);
  const day = start && parseDay(start.rest, format);
  if (!start || !day) return null;
  const value = start.time ? cellInstant(day, start.time, timeZone) : day;
  if (!second) return value;
  const end = splitTime(second);
  // An end that is only a time ends on the start's day.
  const endDay = end && (end.rest ? parseDay(end.rest, format) : start.time && end.time ? day : null);
  if (!end || !endDay || Boolean(end.time) !== Boolean(start.time)) return value;
  // An end written without a zone is in the start's.
  const endTime = end.time && { ...end.time, offset: end.time.offset ?? start.time!.offset };
  const checked = checkDateInput({ start: value, end: endTime ? cellInstant(endDay, endTime, timeZone) : endDay }, "");
  return checked.ok ? checked.value : value;
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
  return !["created_by", "created_time", "last_edited_by", "last_edited_time", "formula", "rollup", "files", "unique_id"].includes(type);
}

export const INVALID = Symbol("invalid");

/**
 * A cell as a value for a property of `type`, in the form the server's row writes take (option
 * and people names, row titles for relations). Null for an empty cell, INVALID when the cell
 * can't be one (a word in a number column): the import leaves those cells empty and says how many.
 */
export function cellValue(
  type: PropertyType,
  raw: string,
  { dateFormat, timeZone }: { dateFormat?: DateFormat; timeZone?: string } = {},
): unknown {
  const s = raw.trim();
  if (!s) return null;
  switch (type) {
    case "number":
      return parseNumber(s) ?? INVALID;
    case "checkbox":
      return parseCheckbox(s) ?? INVALID;
    case "date": {
      // Times written without a zone are the importing person's (`timeZone`).
      const format = dateFormat ?? detectDateFormat([s]);
      return (format && parseDate(s, format, timeZone)) || INVALID;
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
    case "place":
      // Coordinates or an address, which the server looks up when the row is written.
      return s.slice(0, 500);
    default:
      return INVALID;
  }
}
