/**
 * The file viewer's pure parts (components/file-viewer): which way a file is shown, by its name and
 * the type the server stores it with, and how much of a text file is read and shown. No DOM, no
 * fetch, so tests can use them.
 *
 * Blocks keep no content type (see lib/files pdfFileId), so the viewer asks the file route for it
 * (a one-byte range request) and decides with both. A file's bytes are never shown as a page:
 * text of every kind is read as text and drawn as text, a table or rendered Markdown.
 */
import { CODE_LANGUAGES, codeLanguage, PLAIN_TEXT } from "./code-languages";
import { isImageFile } from "./files";
import { parseCsv } from "./import/csv";

export type ViewerKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "spreadsheet"
  | "docx"
  | "csv"
  | "markdown"
  | "json"
  | "code"
  | "text"
  | "other";

/** How a file shows in the viewer: its kind and, for code, the language to color it as. */
export type ViewerFormat = { kind: ViewerKind; language?: string; tsv?: boolean };

/** Kinds read as text in the browser (fetched with a size cap, see TEXT_PREVIEW_BYTES). */
export const TEXT_KINDS: ReadonlySet<ViewerKind> = new Set(["csv", "markdown", "json", "code", "text"]);

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "oga", "ogg", "opus", "wav", "flac"]);
const TEXT_EXTENSIONS = new Set(["txt", "text", "log", "env", "gitignore", "editorconfig"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);
const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5", "geojson", "webmanifest"]);
/** Code languages by file names that have no extension. */
const CODE_FILE_NAMES: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };
/** Extensions of code the language list (lib/code-languages) has no alias for. */
const CODE_EXTENSIONS: Record<string, string> = { cxx: "cpp", hh: "cpp", hxx: "cpp", m: "objective-c", mm: "objective-c", psm1: "powershell", tfvars: "terraform", conf: "ini", xsd: "xml", rss: "xml", atom: "xml", bat: "text", cmd: "text" };

/** A file name's extension, lowercased, without the dot; "" when it has none. */
export function extensionOf(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // ".gitignore" is a name with no extension, which the text list knows as such.
  if (dot === 0) return base.slice(1).toLowerCase();
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The code language of a file by its name; null when it isn't code we know. */
function codeLanguageOf(name: string, ext: string): string | null {
  const base = (name.trim().split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!ext && Object.hasOwn(CODE_FILE_NAMES, base)) return CODE_FILE_NAMES[base];
  if (!ext || IMAGE_EXTENSIONS.has(ext) || MARKDOWN_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext) || JSON_EXTENSIONS.has(ext)) return null;
  if (Object.hasOwn(CODE_EXTENSIONS, ext)) return CODE_EXTENSIONS[ext];
  const id = codeLanguage(ext);
  return id && id !== PLAIN_TEXT && Object.hasOwn(CODE_LANGUAGES, id) ? id : null;
}

/**
 * How the viewer shows a file named `name` stored as `type` (empty or application/octet-stream
 * when unknown).
 *
 * Text by its name comes first: browsers label a TypeScript file `video/mp2t` and plenty of code as
 * octet-stream, and a text file read as text shows at worst odd characters. Otherwise the stored
 * type decides; without one, the name. A PDF shows in the PDF viewer only when stored as a PDF
 * (the route refuses the viewer anything else), and only raster images and SVG are images: other
 * image types (HEIC, TIFF) most browsers can't draw.
 */
export function viewerFormat(name: string, type: string | null | undefined): ViewerFormat {
  const ext = extensionOf(name);
  const stored = (type ?? "").split(";")[0].trim().toLowerCase();
  const known = stored !== "" && stored !== "application/octet-stream";

  if (MARKDOWN_EXTENSIONS.has(ext)) return { kind: "markdown" };
  if (JSON_EXTENSIONS.has(ext)) return { kind: "json" };
  if (ext === "csv") return { kind: "csv" };
  if (ext === "tsv" || ext === "tab") return { kind: "csv", tsv: true };
  const language = codeLanguageOf(name, ext);
  if (language) return language === PLAIN_TEXT ? { kind: "text" } : { kind: "code", language };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text" };

  if (known) {
    if (stored === "image/svg+xml" || isImageFile(stored)) return { kind: "image" };
    if (stored.startsWith("video/")) return { kind: "video" };
    if (stored.startsWith("audio/")) return { kind: "audio" };
    if (stored === "application/pdf") return { kind: "pdf" };
    if (stored === XLSX_TYPE) return { kind: "spreadsheet" };
    if (stored === DOCX_TYPE) return { kind: "docx" };
    if (stored === "text/csv") return { kind: "csv" };
    if (stored === "text/tab-separated-values") return { kind: "csv", tsv: true };
    if (stored === "text/markdown" || stored === "text/x-markdown") return { kind: "markdown" };
    if (stored === "application/json" || stored.endsWith("+json")) return { kind: "json" };
    if (stored === "text/html") return { kind: "code", language: "html" };
    if (stored === "text/xml" || stored === "application/xml" || stored.endsWith("+xml")) return { kind: "code", language: "xml" };
    if (stored === "text/javascript" || stored === "application/javascript") return { kind: "code", language: "javascript" };
    if (stored.startsWith("text/")) return { kind: "text" };
    // An Office document a browser sent as a ZIP: its name says which.
    if (stored !== "application/zip") return { kind: "other" };
  }

  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image" };
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: "video" };
  if (AUDIO_EXTENSIONS.has(ext)) return { kind: "audio" };
  // Unknown type: the PDF viewer checks the stored type itself (pdfViewUrl), the readers the bytes.
  if (ext === "pdf" && !known) return { kind: "pdf" };
  if (ext === "xlsx") return { kind: "spreadsheet" };
  if (ext === "docx") return { kind: "docx" };
  return { kind: "other" };
}

/** Kinds a viewer loads straight from the file's URL: the browser's image, video and audio, the PDF viewer. */
export type UrlKind = "image" | "video" | "audio" | "pdf";
const URL_KINDS: ReadonlySet<ViewerKind> = new Set<UrlKind>(["image", "video", "audio", "pdf"]);

/**
 * The format to show a file in before the file route answers what it is (see probeResult), when
 * what the page already knows decides it: the stored type (a files value keeps one), or else the
 * kind the block showing the file shows it as (`shows`: an image block shows an image). Only kinds
 * loaded by URL qualify; null means waiting for the answer: text needs the size, the other
 * previews show the details it gives. A stored type the page knows wins over the block, and a
 * name that reads as text (a `.ts` in a video block) waits too, as the stored type may agree.
 */
export function knownFormat(name: string, type: string | null | undefined, shows?: UrlKind | null): ViewerFormat | null {
  const stored = (type ?? "").split(";")[0].trim().toLowerCase();
  if (stored !== "" && stored !== "application/octet-stream") {
    const format = viewerFormat(name, stored);
    return URL_KINDS.has(format.kind) ? format : null;
  }
  if (!shows || TEXT_KINDS.has(viewerFormat(name, "").kind)) return null;
  return { kind: shows };
}

const MB = 1024 * 1024;

/** How much of a text file the viewer reads; a longer file shows its start and says so. */
export const TEXT_PREVIEW_BYTES = 2 * MB;
/** Rows of a CSV or TSV file shown (after the header). */
export const CSV_PREVIEW_ROWS = 1000;
/** Columns of a CSV or TSV file shown. */
export const CSV_PREVIEW_COLUMNS = 100;

/**
 * How many of `bytes` end on a whole UTF-8 character: a file cut at a byte limit can end inside
 * one, which would otherwise make the whole text fail to read as UTF-8. Bytes that aren't UTF-8 at
 * all are left as they are.
 */
export function wholeUtf8Length(bytes: Uint8Array): number {
  const end = bytes.length;
  // A character is at most 4 bytes: look back over at most 3 continuation bytes for its lead.
  for (let i = end - 1, back = 0; i >= 0 && back < 4; i--, back++) {
    const byte = bytes[i];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte
    const need = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    return end - i < need ? i : end;
  }
  return end;
}

/**
 * The text of the first bytes of a file (at most `limit` of them) and whether some of it was
 * left out: `total` is the file's size when known (from the range the server answered). A cut text
 * ends at its last line break, so no half line shows, unless that would leave little of it.
 */
export function previewText(bytes: Uint8Array, { total, limit = TEXT_PREVIEW_BYTES }: { total?: number | null; limit?: number } = {}) {
  const cut = bytes.length > limit || (total != null && total > Math.min(bytes.length, limit));
  let slice = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  if (cut) slice = slice.subarray(0, wholeUtf8Length(slice));
  let text = decodeBytes(slice);
  if (cut) {
    const line = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    if (line > text.length / 2) text = text.slice(0, line);
  }
  return { text, truncated: cut };
}

/**
 * Bytes as text: UTF-8 when they are (a BOM dropped), else Windows-1254, what spreadsheets on a
 * Turkish (or, for the letters they share, Western) Windows save text in; UTF-16 by its BOM.
 */
export function decodeBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}

export type CsvPreview = {
  /** The header's cells, or null when the first row is data. */
  header: string[] | null;
  rows: string[][];
  /** Columns of the widest row shown. */
  width: number;
  /** Rows (or columns) of the file not shown. */
  partial: boolean;
};

const NUMBERISH = /^[-+]?[$€£₺¥]?\s?[-+]?(\d[\d.,\s']*)(%|[eE][-+]?\d+)?$|^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

/**
 * Whether the first row of `records` reads as a header: every cell filled, none repeated, none a
 * number or a date, and (when there are rows below) at least one cell that the rows below never
 * repeat in its column, the way a label sits over its values. A first row of words over more words
 * can't be told from data; it is read as a header, as spreadsheets do.
 */
export function looksLikeHeader(records: string[][]): boolean {
  const [head, ...body] = records;
  if (!head?.length) return false;
  const cells = head.map((c) => c.trim().toLowerCase());
  if (cells.some((c) => !c || NUMBERISH.test(c))) return false;
  if (new Set(cells).size !== cells.length) return false;
  const sample = body.slice(0, 200);
  return cells.some((cell, i) => !sample.some((row) => (row[i] ?? "").trim().toLowerCase() === cell));
}

/**
 * A CSV or TSV file's text as a table to show: at most `rows` rows below the header and `columns`
 * columns. `truncated` says the text is only the file's start: its last record may be cut, so it
 * is left out.
 */
export function csvPreview(
  text: string,
  { tsv = false, truncated = false, rows = CSV_PREVIEW_ROWS, columns = CSV_PREVIEW_COLUMNS }: { tsv?: boolean; truncated?: boolean; rows?: number; columns?: number } = {},
): CsvPreview {
  const records = tsv ? parseCsv(text, "\t") : parseCsv(text);
  if (truncated && records.length > 1) records.pop();
  const header = looksLikeHeader(records) ? records[0] : null;
  const body = header ? records.slice(1) : records;
  let partial = truncated || body.length > rows;
  const shown = body.slice(0, rows);
  let width = Math.max(header?.length ?? 0, ...shown.map((r) => r.length), 0);
  if (width > columns) {
    width = columns;
    partial = true;
  }
  const fit = (row: string[]) => (row.length > width ? row.slice(0, width) : row);
  return { header: header ? fit(header) : null, rows: shown.map(fit), width, partial };
}

/** A JSON file's text laid out two spaces deep, or as it is when it isn't whole, valid JSON. */
export function prettyJson(text: string, truncated: boolean): string {
  if (truncated) return text;
  try {
    return JSON.stringify(JSON.parse(text.replace(/^﻿/, "")), null, 2);
  } catch {
    return text;
  }
}

/**
 * A file's size and stored type from the file route's answer to a one-byte range request
 * (`Range: bytes=0-0`): 206 with `Content-Range: bytes 0-0/<size>`, or 416 with `bytes *\/0` for an
 * empty file, or 200 with the whole file where ranges aren't served.
 */
export function probeResult(status: number, headers: { get(name: string): string | null }): { size: number | null; type: string; name: string | null } | null {
  if (status !== 200 && status !== 206 && status !== 416) return null;
  const range = /\/(\d+)\s*$/.exec(headers.get("content-range") ?? "");
  const length = headers.get("content-length");
  const size = range ? Number(range[1]) : status === 200 && length ? Number(length) : null;
  const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { size, type, name: dispositionName(headers.get("content-disposition")) };
}

/** The file name a `Content-Disposition` header gives (its UTF-8 form first); null without one. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}
