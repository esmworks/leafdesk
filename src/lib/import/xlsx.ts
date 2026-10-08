import { unzipSync } from "fflate";
import { CSV_MAX_COLUMNS, CSV_MAX_ROWS, csvTable, decodeText, recordsTable, type CsvTable } from "./csv";
import { IMPORT_LIMITS } from "./markdown";
import { ImportError, type WarningList } from "./result";

/**
 * Reading Excel workbooks (.xlsx) for import: one worksheet's cells as the records a CSV file
 * would give (see lib/import/csv), so the CSV import guesses types, title columns and yes/no words
 * the same way. Pure and without a DOM, so the import dialog previews a workbook with the same
 * code the server imports it with.
 *
 * Only what values need is read: the workbook's sheets (and its 1904 date system), the shared
 * strings, which cell styles are dates and times, and each cell's value (a formula's last
 * result). Formatting, merged cells, comments and pictures are ignored; cells with an error
 * (#N/A, #DIV/0!) read as empty. Old binary workbooks (.xls) and password-protected ones are
 * refused with their own error.
 *
 * The parts are unpacked within IMPORT_LIMITS.unpackedBytes (counted as for ZIP imports, see
 * server/import/archive), and a sheet is read only until it passes the CSV import's row and
 * column limits.
 */

/** A small strict XML reader: elements, attributes, text, comments, CDATA; no DOCTYPE or entities of its own. */
export type XmlHandler = {
  /** An element starts; `name` and the attributes' keys are local names (no namespace prefix). */
  open?: (name: string, attrs: Record<string, string>, empty: boolean) => void;
  close?: (name: string) => void;
  /** Character data, already decoded. */
  text?: (text: string) => void;
};

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML character data or an attribute value with its entity and character references resolved. */
export function decodeXml(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&]{0,10});?/g, (match, ref: string) => {
    if (!match.endsWith(";")) throw new XmlError(`Bad reference "${match}"`);
    if (ref in ENTITIES) return ENTITIES[ref];
    const code = /^#x([0-9a-f]{1,6})$/i.exec(ref) ? parseInt(ref.slice(2), 16) : /^#(\d{1,7})$/.test(ref) ? Number(ref.slice(1)) : NaN;
    if (!Number.isInteger(code) || code > 0x10ffff) throw new XmlError(`Unknown entity "${match}"`);
    return String.fromCodePoint(code);
  });
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Walks `xml`, calling `on` for each element and text; throws XmlError when it isn't well formed. */
export function scanXml(xml: string, on: XmlHandler) {
  const stack: string[] = [];
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let rooted = false;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const end = lt === -1 ? n : lt;
    if (end > i) {
      const raw = xml.slice(i, end);
      if (stack.length) on.text?.(decodeXml(raw));
      else if (raw.trim()) throw new XmlError("Text outside the root element");
    }
    if (lt === -1) break;
    if (xml.startsWith("<?", lt)) {
      i = after(xml, "?>", lt + 2);
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      i = after(xml, "-->", lt + 4);
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      i = after(xml, "]]>", lt + 9);
      if (!stack.length) throw new XmlError("CDATA outside the root element");
      on.text?.(xml.slice(lt + 9, i - 3));
      continue;
    }
    // A DOCTYPE could declare entities that expand without end; workbooks never have one.
    if (xml.startsWith("<!", lt)) throw new XmlError("DOCTYPE isn't allowed");

    // The tag's end: the first ">" outside a quoted attribute value.
    let gt = lt + 1;
    let quote = 0;
    for (; gt < n; gt++) {
      const c = xml.charCodeAt(gt);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
      else if (c === 60) throw new XmlError("Unclosed tag");
    }
    if (gt >= n) throw new XmlError("Unclosed tag");
    i = gt + 1;

    if (xml.charCodeAt(lt + 1) === 47) {
      const name = xml.slice(lt + 2, gt).trim();
      if (stack.pop() !== name) throw new XmlError(`Unexpected </${name}>`);
      on.close?.(localName(name));
      continue;
    }
    const empty = xml.charCodeAt(gt - 1) === 47;
    const inner = xml.slice(lt + 1, empty ? gt - 1 : gt);
    const space = inner.search(/\s/);
    const name = space === -1 ? inner : inner.slice(0, space);
    if (!name || /[<>"'=]/.test(name)) throw new XmlError("Bad element name");
    if (!stack.length && rooted) throw new XmlError("More than one root element");
    const attrs: Record<string, string> = {};
    if (space !== -1) {
      const rest = inner.slice(space);
      let consumed = 0;
      for (const m of rest.matchAll(ATTRIBUTE)) {
        if (rest.slice(consumed, m.index).trim()) throw new XmlError(`Bad attribute in <${name}>`);
        consumed = m.index + m[0].length;
        attrs[localName(m[1])] = decodeXml(m[2] ?? m[3]);
      }
      if (rest.slice(consumed).trim()) throw new XmlError(`Bad attribute in <${name}>`);
    }
    on.open?.(localName(name), attrs, empty);
    if (empty) on.close?.(localName(name));
    else stack.push(name);
    rooted = true;
  }
  if (stack.length) throw new XmlError(`<${stack.at(-1)}> isn't closed`);
}

function after(xml: string, token: string, from: number) {
  const at = xml.indexOf(token, from);
  if (at === -1) throw new XmlError(`Missing "${token}"`);
  return at + token.length;
}

/** `_xHHHH_`: how workbooks write a character XML can't hold (a control character); `_x005F_` is "_". */
export function decodeEscapes(text: string): string {
  return text.includes("_x") ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text;
}

// ---------------------------------------------------------------------------------------------
// The package

/** OLE compound files: old binary workbooks (.xls), and .xlsx files saved with a password. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOleFile(bytes: Uint8Array) {
  return OLE_MAGIC.every((b, i) => bytes[i] === b);
}

const unreadable = () => new ImportError("The workbook can't be read", "badWorkbook");

/** A workbook's ZIP: parts read one at a time, all of them within one unpacked-size budget. */
class Package {
  private names = new Map<string, string>();
  private budget = IMPORT_LIMITS.unpackedBytes;

  constructor(private bytes: Uint8Array) {
    if (isOleFile(bytes)) {
      throw new ImportError("Only .xlsx workbooks without a password can be imported", "unsupportedWorkbook");
    }
    try {
      unzipSync(bytes, {
        filter: (entry) => {
          // Part names don't depend on case.
          this.names.set(entry.name.replace(/^\/+/, "").toLowerCase(), entry.name);
          return false;
        },
      });
    } catch {
      throw unreadable();
    }
  }

  /** A part's text, or null when the package doesn't have it. */
  read(path: string): string | null {
    const name = this.names.get(path.replace(/^\/+/, "").toLowerCase());
    if (name === undefined) return null;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(this.bytes, {
        filter: (entry) => {
          if (entry.name !== name) return false;
          this.budget -= Math.max(entry.size, entry.originalSize);
          if (this.budget < 0) {
            throw new ImportError("The unpacked files are too large to import", "tooLarge", { limit: IMPORT_LIMITS.unpackedBytes });
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw unreadable();
    }
    const data = entries[name];
    if (!data) return null;
    // XML parts are UTF-8, or UTF-16 with a byte order mark.
    const utf16 = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : null;
    return new TextDecoder(utf16 ?? "utf-8").decode(data);
  }

  /** Parses a part (null when missing), turning malformed XML into the workbook error. */
  scan(path: string, on: XmlHandler): boolean {
    const xml = this.read(path);
    if (xml === null) return false;
    try {
      scanXml(xml, on);
    } catch (error) {
      if (error instanceof XmlError) throw unreadable();
      throw error;
    }
    return true;
  }
}

/** A target of a relationship, from the part that has it: relative to its folder, or from the root. */
function resolvePath(from: string, target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return ""; // An external link.
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** The relationships of a part, by id: their type (its last segment, e.g. "worksheet") and target. */
function relationships(pkg: Package, part: string) {
  const slash = part.lastIndexOf("/");
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const rels = new Map<string, { type: string; target: string }>();
  pkg.scan(relsPath, {
    open(name, attrs) {
      if (name !== "Relationship" || !attrs.Id || !attrs.Target || attrs.TargetMode === "External") return;
      rels.set(attrs.Id, { type: (attrs.Type ?? "").split("/").at(-1) ?? "", target: resolvePath(part, attrs.Target) });
    },
  });
  return rels;
}

// ---------------------------------------------------------------------------------------------
// Number formats

/** Built-in number formats that are dates or times (the others are numbers or text). */
const BUILTIN_FORMATS: Record<number, string> = {
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
};
// East Asian locales' built-in date formats.
for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) BUILTIN_FORMATS[id] = "yyyy-mm-dd";

export type DateKind = "date" | "time" | "dateTime" | null;

/**
 * Whether a number format shows a date, a time of day, both, or neither: its d, m, y, h and s
 * outside quoted text, `[…]` (colors, conditions, locales, elapsed hours) and escaped characters.
 * An m without d, y, h or s (`mmm`) is a month.
 */
export function formatKind(code: string): DateKind {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\.|[_*]./g, "");
  const date = /[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
  const time = /[hs]/i.test(bare);
  // Elapsed times ("[h]:mm:ss") only show minutes and seconds outside their brackets.
  const elapsed = /\[(h+|m+|s+)\]/i.test(code);
  if (date && (time || elapsed)) return "dateTime";
  if (date) return "date";
  if (time || elapsed) return "time";
  return null;
}

/** Which cell styles (indexes into cellXfs) show dates or times. */
function dateStyles(pkg: Package, path: string | undefined): DateKind[] {
  const formats = new Map<number, string>(Object.entries(BUILTIN_FORMATS).map(([id, code]) => [Number(id), code]));
  const styles: DateKind[] = [];
  let inCellXfs = false;
  const ids: number[] = [];
  if (path) {
    pkg.scan(path, {
      open(name, attrs) {
        if (name === "numFmt" && attrs.numFmtId && attrs.formatCode !== undefined) formats.set(Number(attrs.numFmtId), attrs.formatCode);
        else if (name === "cellXfs") inCellXfs = true;
        else if (name === "xf" && inCellXfs) ids.push(Number(attrs.numFmtId ?? 0));
      },
      close(name) {
        if (name === "cellXfs") inCellXfs = false;
      },
    });
  }
  for (const id of ids) {
    const code = formats.get(id);
    styles.push(code === undefined ? null : formatKind(code));
  }
  return styles;
}

// ---------------------------------------------------------------------------------------------
// Values

const DAY_MS = 86_400_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * A date serial as text the CSV import reads: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS` when it has a
 * time of day, `HH:MM:SS` for a time alone (hours past 24 for durations). Null when out of range.
 */
export function serialText(serial: number, kind: Exclude<DateKind, null>, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const seconds = Math.round(serial * 86_400);
  const days = Math.floor(seconds / 86_400);
  const time = seconds - days * 86_400;
  const clock = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  if (kind === "time") return clock(seconds);
  // The 1900 system counts a 29 February 1900 that never was (serial 60): days before it start a day later.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * DAY_MS);
  if (d.getUTCFullYear() > 9999 || (!date1904 && days < 1)) return null;
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return time && kind === "dateTime" ? `${day}T${clock(time)}` : day;
}

/** A number cell as text: rounded to the 15 digits spreadsheets show, so 0.1+0.2 reads 0.3. */
function numberText(value: number) {
  return String(Number(value.toPrecision(15)));
}

type Context = { strings: string[]; styles: DateKind[]; date1904: boolean };

/**
 * A worksheet's rows as records: rows with nothing in them left out, every record as wide as the
 * widest. Stops with the CSV import's errors once a row or column is past its limits.
 */
function sheetRecords(pkg: Package, path: string, ctx: Context): string[][] {
  const records: string[][] = [];
  let row: string[] | null = null;
  let filled = false;
  let col = -1;
  let cell: { type: string; style: number } | null = null;
  let value: string | null = null;
  let inline: string | null = null;
  let depth: "v" | "t" | null = null;
  let phonetic = false;
  let width = 0;

  const finishCell = () => {
    if (!cell || !row) return;
    const text = cellText(cell.type, cell.style, value, inline, ctx);
    if (text !== "") {
      if (col >= CSV_MAX_COLUMNS) {
        throw new ImportError(`CSV files can have at most ${CSV_MAX_COLUMNS} columns`, "tooManyColumns", { limit: CSV_MAX_COLUMNS });
      }
      while (row.length < col) row.push("");
      row[col] = text;
      filled = true;
    }
  };

  const found = pkg.scan(path, {
    open(name, attrs) {
      if (name === "row") {
        row = [];
        filled = false;
        col = -1;
      } else if (name === "c" && row) {
        const ref = attrs.r ? cellColumn(attrs.r) : null;
        col = ref ?? col + 1;
        cell = { type: attrs.t ?? "n", style: Number(attrs.s ?? 0) };
        value = null;
        inline = null;
      } else if (cell && name === "v") {
        depth = "v";
        value = "";
      } else if (cell && name === "is") inline = "";
      else if (cell && name === "rPh") phonetic = true;
      else if (cell && inline !== null && name === "t" && !phonetic) depth = "t";
    },
    text(text) {
      if (depth === "v") value += text;
      else if (depth === "t") inline += text;
    },
    close(name) {
      if (name === "v" || name === "t") depth = null;
      else if (name === "rPh") phonetic = false;
      else if (name === "c") {
        finishCell();
        cell = null;
      } else if (name === "row" && row) {
        if (filled) {
          if (records.length > CSV_MAX_ROWS) {
            throw new ImportError(`CSV files can have at most ${CSV_MAX_ROWS} rows`, "tooManyRows", { limit: CSV_MAX_ROWS });
          }
          records.push(row);
          width = Math.max(width, row.length);
        }
        row = null;
      }
    },
  });
  if (!found) throw unreadable();
  for (const r of records) while (r.length < width) r.push("");
  return records;
}

/** The column of a cell reference ("C7" → 2); null when it isn't one. */
export function cellColumn(ref: string): number | null {
  const m = /^\$?([A-Z]{1,3})\$?\d*$/i.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

function cellText(type: string, style: number, value: string | null, inline: string | null, ctx: Context): string {
  switch (type) {
    case "s": {
      if (value === null || value.trim() === "") return "";
      const text = ctx.strings[Number(value)];
      if (text === undefined) throw unreadable();
      return text;
    }
    case "inlineStr":
      return decodeEscapes(inline ?? value ?? "");
    case "str":
      return decodeEscapes(value ?? "");
    case "b":
      return value === null || value.trim() === "" ? "" : value.trim() === "1" || value.trim() === "true" ? "TRUE" : "FALSE";
    case "e":
      return "";
    case "d":
      // An ISO 8601 date: the day, with the time when it has one.
      return (value ?? "").trim().replace(/(?:\.\d+)?Z?$/, "").replace(/T00:00(?::00)?$/, "");
    default: {
      if (value === null || value.trim() === "") return "";
      const number = Number(value);
      if (!Number.isFinite(number)) throw unreadable();
      const kind = ctx.styles[style] ?? null;
      return (kind && serialText(number, kind, ctx.date1904)) ?? numberText(number);
    }
  }
}

function sharedStrings(pkg: Package, path: string | undefined): string[] {
  const strings: string[] = [];
  if (!path) return strings;
  let item: string | null = null;
  let inText = false;
  let phonetic = false;
  pkg.scan(path, {
    open(name, _attrs, empty) {
      if (name === "si") item = "";
      else if (name === "rPh") phonetic = true;
      else if (name === "t" && item !== null && !phonetic && !empty) inText = true;
    },
    text(text) {
      if (inText) item += text;
    },
    close(name) {
      if (name === "t") inText = false;
      else if (name === "rPh") phonetic = false;
      else if (name === "si") {
        strings.push(decodeEscapes(item ?? ""));
        item = null;
      }
    },
  });
  return strings;
}

// ---------------------------------------------------------------------------------------------
// Workbooks

export type WorkbookSheet = { name: string };

export type Workbook = {
  /** The worksheets one can import, in the workbook's order (hidden ones left out while others show). */
  sheets: WorkbookSheet[];
  /** A worksheet's cells as a table, the header its first row with anything in it. */
  table(sheet: number): CsvTable;
};

/** Opens a workbook (.xlsx). Throws an ImportError when it can't be read or isn't one. */
export function readWorkbook(bytes: Uint8Array): Workbook {
  const pkg = new Package(bytes);
  const root = relationships(pkg, "");
  const workbookPath = [...root.values()].find((r) => r.type === "officeDocument")?.target || "xl/workbook.xml";
  const sheets: { name: string; path: string; hidden: boolean }[] = [];
  let date1904 = false;
  const rels = relationships(pkg, workbookPath);
  const found = pkg.scan(workbookPath, {
    open(name, attrs) {
      if (name === "workbookPr") date1904 = attrs.date1904 === "1" || attrs.date1904 === "true";
      else if (name === "sheet") {
        const rel = rels.get(attrs.id ?? "");
        // Chart sheets and macro sheets have no cells to import.
        if (rel?.type === "worksheet" && rel.target) {
          sheets.push({ name: attrs.name ?? `Sheet${sheets.length + 1}`, path: rel.target, hidden: !!attrs.state && attrs.state !== "visible" });
        }
      }
    },
  });
  if (!found || !sheets.length) throw unreadable();
  const visible = sheets.some((s) => !s.hidden) ? sheets.filter((s) => !s.hidden) : sheets;

  const byType = (type: string) => [...rels.values()].find((r) => r.type === type)?.target;
  let ctx: Context | null = null;
  return {
    sheets: visible.map(({ name }) => ({ name })),
    table(index) {
      const sheet = visible[index];
      if (!sheet) throw new ImportError("The workbook has no such sheet", "badRequest");
      ctx ??= { strings: sharedStrings(pkg, byType("sharedStrings")), styles: dateStyles(pkg, byType("styles")), date1904 };
      return recordsTable(sheetRecords(pkg, sheet.path, ctx), { guarded: false });
    },
  };
}

/** Whether a file is a workbook (.xlsx, or an old .xls the import refuses), by its name. */
export function isWorkbookFile(name: string) {
  return /\.xlsx?$/i.test(name);
}

/**
 * A file the CSV import takes as a table: a workbook's sheet (see workbookTable), or a CSV file.
 * A file that is a workbook whatever its name says is read as one.
 */
export function spreadsheetTable(name: string, bytes: Uint8Array, sheet: number | null = null, warnings?: WarningList): CsvTable {
  if (isWorkbook(name, bytes)) return workbookTable(bytes, sheet, warnings);
  return csvTable(decodeText(bytes));
}

/** Whether a file is read as a workbook: by its name, or by its bytes (a ZIP, an OLE file) whatever the name. */
export function isWorkbook(name: string, bytes: Uint8Array) {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  return isWorkbookFile(name) || zip || isOleFile(bytes);
}

/**
 * The table of a workbook's sheet `sheet` (an index into its sheets), or of its first one: then
 * `warnings`, when given, gets one for each other sheet that was left out.
 */
export function workbookTable(bytes: Uint8Array, sheet: number | null = null, warnings?: WarningList): CsvTable {
  const book = readWorkbook(bytes);
  if (sheet === null && warnings) {
    for (const other of book.sheets.slice(1)) warnings.add({ code: "skipped", path: other.name, reason: "otherSheet" });
  }
  return book.table(sheet ?? 0);
}
