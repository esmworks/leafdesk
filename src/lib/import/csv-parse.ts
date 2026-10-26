/**
 * Reading CSV files into a header and rows (RFC 4180, the separator detected, Excel's encodings),
 * without anything else of the importer (lib/import/csv.ts): light enough for the AI chat's box,
 * which reads a CSV file attached to a question in the browser.
 */
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
  // The number each name's next repeat tries first: the ones below it are taken already (counting
  // from 2 again for each repeat would take time growing with the square of the repeats).
  const nextNumber = new Map<string, number>();
  head.forEach((raw, i) => {
    const base = clean(raw).replace(/\s+/g, " ").trim().slice(0, 100) || `Column ${i + 1}`;
    let name = base;
    if (taken.has(name.toLowerCase())) {
      let n = nextNumber.get(base.toLowerCase()) ?? 2;
      for (name = `${base} ${n}`; taken.has(name.toLowerCase()); name = `${base} ${n}`) n++;
      nextNumber.set(base.toLowerCase(), n + 1);
    }
    taken.add(name.toLowerCase());
    headers.push(name);
  });
  const rows = body
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => headers.map((_, i) => clean(r[i] ?? "")));
  return { headers, rows };
}
