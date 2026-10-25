import { ImportError } from "./result";

/**
 * Reading a single-file web page (MHTML: `.mht`, `.mhtml`), the format OneNote exports a page or a
 * section to as *Single File Web Page*, and Word, Internet Explorer and Chromium browsers save web
 * pages in. It is a MIME message (RFC 2557): a `multipart/related` body whose parts are the page's
 * HTML and the files it uses (pictures, style sheets), each with its own headers. A part is found
 * by its `Content-Location` (the address the HTML uses for it, absolute or relative to the HTML's
 * own) or by its `Content-ID` (`cid:` references).
 *
 * Read here: headers (folded lines too), boundaries (with or without the closing one), parts in
 * nested multiparts (one level down), `base64`, `quoted-printable` and unencoded (7bit, 8bit,
 * binary) bodies, and each text part's character set (its `charset`, else a byte order mark or the
 * HTML's own `<meta charset>`, else UTF-8 or Windows-1252). Nothing is fetched: a reference no part
 * answers stays unanswered. The server part (server/import/mhtml) turns the HTML into a page.
 */

export const MHTML_LIMITS = {
  /** Parts of one file (pictures and style sheets included). */
  parts: 2000,
  /** Multiparts inside the outer one that are read. */
  nesting: 1,
};

export type MhtmlPart = {
  /** The media type, lowercase and without its parameters ("text/html"). */
  type: string;
  charset: string | null;
  /** Its `Content-Location` as written, or null. */
  location: string | null;
  /** Its `Content-ID` without the angle brackets, or null. */
  id: string | null;
  data: Uint8Array;
};

export type MhtmlArchive = {
  /** The page: the part the message names as its start, else its first HTML part. */
  root: MhtmlPart;
  parts: MhtmlPart[];
};

/** A file's bytes as a string of one character per byte (Latin-1), for finding headers and boundaries. */
function binaryString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function bytesOf(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** `base64` content (line breaks and stray characters ignored, missing padding forgiven). */
export function decodeBase64(text: string): Uint8Array {
  let clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  return bytesOf(atob(clean));
}

/** `quoted-printable` content: `=XX` is a byte, `=` at a line's end joins it to the next. */
export function decodeQuotedPrintable(text: string): Uint8Array {
  const binary = text
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return bytesOf(binary);
}

/** A header's value and parameters: `text/html; charset="utf-8"` → type and { charset: "utf-8" }. */
export function headerParams(value: string): { value: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  const at = value.indexOf(";");
  const head = (at === -1 ? value : value.slice(0, at)).trim();
  const rest = at === -1 ? "" : value.slice(at + 1);
  const PARAM = /\s*([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))\s*;?/g;
  for (let m = PARAM.exec(rest); m; m = PARAM.exec(rest)) {
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
    if (!params.has(m[1].toLowerCase())) params.set(m[1].toLowerCase(), raw);
  }
  return { value: head, params };
}

/** The headers starting at `from` (names lowercased, folded lines joined) and where the body starts. */
function readHeaders(s: string, from: number, end: number): { headers: Map<string, string>; body: number } {
  // No headers at all: the body starts after the blank line.
  const blank = /\r?\n\r?\n/g;
  let body: number;
  let block: string;
  if (s.startsWith("\r\n", from) || s.startsWith("\n", from)) {
    body = from + (s.startsWith("\r\n", from) ? 2 : 1);
    block = "";
  } else {
    blank.lastIndex = from;
    const m = blank.exec(s);
    const stop = m && m.index < end ? m.index : end;
    block = s.slice(from, stop);
    body = m && m.index < end ? m.index + m[0].length : end;
  }
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/** The [start, end) of each part between the boundaries of a multipart body. */
function splitParts(s: string, start: number, end: number, boundary: string): [number, number][] {
  const delimiter = `--${boundary}`;
  const parts: [number, number][] = [];
  let partStart = -1;
  for (let i = s.indexOf(delimiter, start); i !== -1 && i < end; i = s.indexOf(delimiter, i + delimiter.length)) {
    if (i !== start && s[i - 1] !== "\n") continue;
    if (partStart !== -1) parts.push([partStart, i === start ? i : s[i - 2] === "\r" ? i - 2 : i - 1]);
    const after = i + delimiter.length;
    if (s.startsWith("--", after)) return parts;
    const eol = s.indexOf("\n", after);
    if (eol === -1 || eol >= end) return parts;
    partStart = eol + 1;
  }
  // No closing boundary (a file cut short): the last part runs to the end.
  if (partStart !== -1) parts.push([partStart, end]);
  return parts;
}

function decodeBody(body: string, encoding: string): Uint8Array {
  if (encoding === "base64") return decodeBase64(body);
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return bytesOf(body);
}

/** Reads the entity (headers and body) at [start, end) into `out`: its parts, or itself. */
function readEntity(name: string, s: string, start: number, end: number, depth: number, out: MhtmlPart[]) {
  const { headers, body } = readHeaders(s, start, end);
  const contentType = headerParams(headers.get("content-type") ?? "text/plain");
  const type = contentType.value.toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    if (!boundary) throw new ImportError(`“${name}” can't be read as a web archive`, "badMhtml", { name });
    if (depth > MHTML_LIMITS.nesting) return;
    for (const [a, b] of splitParts(s, body, end, boundary)) readEntity(name, s, a, b, depth + 1, out);
    return;
  }
  if (out.length >= MHTML_LIMITS.parts) {
    throw new ImportError(`An import can hold at most ${MHTML_LIMITS.parts} files`, "tooManyFiles", { limit: MHTML_LIMITS.parts });
  }
  const id = headers.get("content-id")?.replace(/^<|>$/g, "").trim();
  out.push({
    type,
    charset: contentType.params.get("charset")?.trim().toLowerCase() || null,
    location: headers.get("content-location")?.trim() || null,
    id: id || null,
    data: decodeBody(s.slice(body, end), (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase()),
  });
}

const isHtml = (part: MhtmlPart) => part.type === "text/html" || part.type === "application/xhtml+xml";

/** Reads an MHTML file; ImportError `badMhtml` for one that isn't (no HTML in it), `tooManyFiles` past MHTML_LIMITS.parts. */
export function readMhtml(name: string, bytes: Uint8Array): MhtmlArchive {
  const s = binaryString(bytes);
  // Blank lines or a byte order mark before the headers are passed over.
  const start = /^(?:\uFEFF|\u00EF\u00BB\u00BF)?\s*/.exec(s)![0].length;
  const top = readHeaders(s, start, s.length).headers;
  if (!top.has("content-type") && !top.has("mime-version")) {
    throw new ImportError(`“${name}” can't be read as a web archive`, "badMhtml", { name });
  }
  const parts: MhtmlPart[] = [];
  readEntity(name, s, start, s.length, 0, parts);
  const startId = headerParams(top.get("content-type") ?? "").params.get("start")?.replace(/^<|>$/g, "").trim().toLowerCase();
  const root = (startId ? parts.find((p) => p.id?.toLowerCase() === startId && isHtml(p)) : undefined) ?? parts.find(isHtml);
  if (!root) throw new ImportError(`“${name}” can't be read as a web archive`, "badMhtml", { name });
  return { root, parts };
}

/** The `charset` a page's HTML declares in its first bytes (`<meta charset>` or http-equiv), or null. */
function metaCharset(head: string): string | null {
  return /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head)?.[1]?.toLowerCase() ?? null;
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

/** A text part's text in its character set (see above). */
export function partText(part: MhtmlPart): string {
  const { data } = part;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder("utf-8").decode(data);
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  const declared = part.charset ?? metaCharset(binaryString(data.subarray(0, 4096)));
  const decoded = declared ? decodeWith(declared, data) : null;
  if (decoded !== null) return decoded;
  return new TextDecoder(isUtf8(data) ? "utf-8" : "windows-1252").decode(data);
}

function isUtf8(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A location as a key to compare by: its URL normalized (escaped; a file path without case), else as written. */
function locationKey(value: string, base?: string | null): string | null {
  try {
    const url = new URL(value.trim(), base ?? undefined);
    url.hash = "";
    return url.protocol === "file:" ? url.href.toLowerCase() : url.href;
  } catch {
    return base ? null : value.trim();
  }
}

/**
 * The part a reference in the HTML stands for: `cid:<id>` by its Content-ID, anything else by its
 * Content-Location, resolved against `base` (the HTML's own location) when relative. A relative
 * reference no location matches that way finds a part whose location ends with it (writers that
 * give no location to the HTML). Null when no part is it.
 */
export function findPart(archive: MhtmlArchive, ref: string, base: string | null): MhtmlPart | null {
  const value = ref.trim();
  if (!value) return null;
  if (/^cid:/i.test(value)) {
    let id = value.slice(4);
    try {
      id = decodeURIComponent(id);
    } catch {}
    id = id.replace(/^<|>$/g, "").toLowerCase();
    return archive.parts.find((p) => p.id?.toLowerCase() === id) ?? null;
  }
  const key = locationKey(value, base) ?? locationKey(value);
  const exact = archive.parts.find((p) => p.location !== null && (p.location === value || locationKey(p.location) === key));
  if (exact || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return exact ?? null;
  let tail: string;
  try {
    tail = new URL(value, "http://archive.invalid/").pathname.toLowerCase();
  } catch {
    return null;
  }
  return (
    archive.parts.find((p) => {
      if (!p.location) return false;
      try {
        return new URL(p.location, "http://archive.invalid/").pathname.toLowerCase().endsWith(tail);
      } catch {
        return false;
      }
    }) ?? null
  );
}
