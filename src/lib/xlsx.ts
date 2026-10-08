import { strToU8, zipSync } from "fflate";

/**
 * Writing Excel workbooks (.xlsx): one sheet of typed cells, header row bold and frozen. The parts
 * are written by hand (Office Open XML, ECMA-376) and zipped with fflate; reading them back is
 * lib/import/xlsx.
 *
 * Text goes in as inline strings, which spreadsheets never run as formulas, so unlike the CSV
 * export (lib/csv) a cell starting with "=" needs no guard.
 */

/**
 * A cell: text, a number, a checkbox (TRUE/FALSE), or a date: `YYYY-MM-DD` for a day, a full ISO
 * timestamp for a point in time (written in UTC, the way the CSV export writes it).
 */
export type XlsxValue = string | number | boolean | { date: string } | null | undefined;

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Most characters a cell holds; spreadsheets refuse files with longer ones. */
const MAX_CELL_CHARS = 32767;

/** Characters XML 1.0 doesn't allow (control characters, U+FFFE/U+FFFF, unpaired surrogates). */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text as XML character data or an attribute value: invalid characters dropped, markup escaped. */
export function xmlText(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A cell's text: `_xHHHH_` is how spreadsheets spell a character in their XML, so one that is
 * really in the text gets its underscore escaped (`_x005F_`) to come back as typed.
 */
function cellText(text: string): string {
  let s = text.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1");
  if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS);
  return xmlText(s);
}

/** A sheet name spreadsheets accept: no `[]:*?/\`, no apostrophe at either end, at most 31 characters. */
export function sheetName(title: string): string {
  const name = title
    .replace(INVALID_XML, "")
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  // "History" is reserved (the change history of a shared workbook).
  if (!name) return "Sheet1";
  return name.toLowerCase() === "history" ? `${name}_` : name;
}

/** A column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const DAY_MS = 86_400_000;
/** Day 0 of the 1900 date system, as spreadsheets count it from March 1900 on. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);

/** A date (`YYYY-MM-DD`) or timestamp as a spreadsheet serial; null when it isn't one. */
export function dateSerial(value: string): { serial: number; time: boolean } | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ms = day ? Date.UTC(+day[1], +day[2] - 1, +day[3]) : /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  const serial = (ms - EPOCH_1900) / DAY_MS;
  // Before March 1900 the 1900 system counts a 29 February that never was; 9999-12-31 is its last day.
  if (serial < 61 || serial >= 2958466) return null;
  return { serial: Math.round(serial * 86_400) / 86_400, time: !day };
}

/** Style indexes in styles.xml's cellXfs. */
const STYLE = { header: 1, date: 2, dateTime: 3 } as const;

/**
 * A workbook of one sheet: `rows[0]` is the header row (bold, frozen when scrolling). Column
 * widths follow the longest value, within limits.
 */
export function toXlsx(rows: XlsxValue[][], { name = "Sheet1" }: { name?: string } = {}): Uint8Array<ArrayBuffer> {
  const widths: number[] = [];
  const fit = (col: number, chars: number) => {
    widths[col] = Math.max(widths[col] ?? 8, Math.min(60, chars + 2));
  };
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const style = r === 0 ? ` s="${STYLE.header}"` : "";
      if (value === null || value === undefined || value === "") return "";
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return "";
        fit(c, String(value).length);
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      if (typeof value === "boolean") {
        fit(c, 5);
        return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
      }
      if (typeof value === "object") {
        const date = dateSerial(value.date);
        if (date) {
          fit(c, date.time ? 19 : 10);
          return `<c r="${ref}" s="${date.time ? STYLE.dateTime : STYLE.date}"><v>${date.serial}</v></c>`;
        }
        value = value.date;
      }
      const longest = Math.max(...value.split("\n").map((line) => line.length));
      fit(c, longest);
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${cellText(value)}</t></is></c>`;
    });
    return `<row r="${r + 1}">${cells.join("")}</row>`;
  });

  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w ?? 8}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const frozen = rows.length > 1 ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` : "";
  const sheet =
    `${XML_HEAD}<worksheet xmlns="${NS.main}" xmlns:r="${NS.officeRels}">` +
    `<sheetViews><sheetView workbookViewId="0">${frozen}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;

  // fflate writes the archive into an ArrayBuffer of its own.
  return zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(ROOT_RELS),
      "xl/workbook.xml": strToU8(
        `${XML_HEAD}<workbook xmlns="${NS.main}" xmlns:r="${NS.officeRels}"><bookViews><workbookView/></bookViews>` +
          `<sheets><sheet name="${xmlText(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
      "xl/styles.xml": strToU8(STYLES),
    },
    { level: 6, mtime: new Date("2000-01-01T00:00:00Z") },
  ) as Uint8Array<ArrayBuffer>;
}

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  officeRels: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  packageRels: "http://schemas.openxmlformats.org/package/2006/relationships",
};

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `${XML_HEAD}<Relationships xmlns="${NS.packageRels}">` +
  `<Relationship Id="rId1" Type="${NS.officeRels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS =
  `${XML_HEAD}<Relationships xmlns="${NS.packageRels}">` +
  `<Relationship Id="rId1" Type="${NS.officeRels}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS.officeRels}/styles" Target="styles.xml"/></Relationships>`;

// cellXfs: 0 plain, 1 bold (the header), 2 a date, 3 a date and time.
const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${NS.main}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;
