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

/**
 * `text` without the spaces and tabs that end its lines (before a CRLF or LF). Scanned back from
 * each line break, never past the one before: a regex finding those runs starts again at every
 * space of a long run that ends in something else, which takes time growing with its square.
 */
function withoutTrailingBlanks(text: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    const end = at > from && text[at - 1] === "\r" ? at - 1 : at;
    let start = end;
    while (start > from && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
    out += text.slice(from, start);
    from = end;
  }
  return out + text.slice(from);
}

/** `quoted-printable` content: `=XX` is a byte, `=` at a line's end joins it to the next. */
export function decodeQuotedPrintable(text: string): Uint8Array {
  const binary = withoutTrailingBlanks(text)
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
  // Each `=` with a name right before it starts a parameter. The name is found by looking back
  // from the `=`: a regex searching forward would try every character of a long run without one.
  const PARAM = /([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))\s*;?/y;
  let from = 0;
  for (let eq = rest.indexOf("="); eq !== -1; eq = rest.indexOf("=", Math.max(eq + 1, from))) {
    let start = eq;
    while (start > from && /\s/.test(rest[start - 1])) start--;
    const end = start;
    while (start > from && /[^=;\s]/.test(rest[start - 1])) start--;
    if (start === end) continue;
    PARAM.lastIndex = start;
    const m = PARAM.exec(rest)!;
    from = PARAM.lastIndex;
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

/** A path's segments from the last one back, each leading to the first part (by its index) whose path ends so. */
type PathNode = { first: number; next: Map<string, PathNode> };

/**
 * What findPart looks parts up by, worked out once per archive (a page can have as many pictures
 * as parts, and comparing each with each would take their product): the first part (its index)
 * by Content-ID, by Content-Location as written and as a key, and by the segments its location's
 * path ends with.
 */
type PartIndex = { ids: Map<string, number>; locations: Map<string, number>; keys: Map<string, number>; paths: PathNode };

const ARCHIVE_BASE = "http://archive.invalid/";
const partIndexes = new WeakMap<MhtmlArchive, PartIndex>();

function partIndex(archive: MhtmlArchive): PartIndex {
  const known = partIndexes.get(archive);
  if (known) return known;
  const index: PartIndex = { ids: new Map(), locations: new Map(), keys: new Map(), paths: { first: -1, next: new Map() } };
  const add = (map: Map<string, number>, key: string, i: number) => {
    if (!map.has(key)) map.set(key, i);
  };
  archive.parts.forEach((part, i) => {
    if (part.id) add(index.ids, part.id.toLowerCase(), i);
    if (part.location === null) return;
    add(index.locations, part.location, i);
    add(index.keys, locationKey(part.location)!, i);
    let path: string;
    try {
      path = new URL(part.location, ARCHIVE_BASE).pathname.toLowerCase();
    } catch {
      return;
    }
    // "/a/b.png" is reached by "b.png", then "a": the paths that end with "/b.png" and "/a/b.png".
    const segments = path.split("/").slice(1);
    let node = index.paths;
    for (let s = segments.length - 1; s >= 0; s--) {
      let child = node.next.get(segments[s]);
      if (!child) node.next.set(segments[s], (child = { first: i, next: new Map() }));
      node = child;
    }
  });
  partIndexes.set(archive, index);
  return index;
}

/**
 * The part a reference in the HTML stands for: `cid:<id>` by its Content-ID, anything else by its
 * Content-Location, resolved against `base` (the HTML's own location) when relative. A relative
 * reference no location matches that way finds a part whose location ends with it (writers that
 * give no location to the HTML). Null when no part is it. When several parts answer, the first.
 */
export function findPart(archive: MhtmlArchive, ref: string, base: string | null): MhtmlPart | null {
  const value = ref.trim();
  if (!value) return null;
  const index = partIndex(archive);
  const part = (i: number | undefined) => (i !== undefined && i >= 0 && i < archive.parts.length ? archive.parts[i] : null);
  if (/^cid:/i.test(value)) {
    let id = value.slice(4);
    try {
      id = decodeURIComponent(id);
    } catch {}
    id = id.replace(/^<|>$/g, "").toLowerCase();
    return part(index.ids.get(id));
  }
  const key = locationKey(value, base) ?? locationKey(value)!;
  const exact = part(Math.min(index.locations.get(value) ?? Infinity, index.keys.get(key) ?? Infinity));
  if (exact || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return exact;
  let tail: string;
  try {
    tail = new URL(value, ARCHIVE_BASE).pathname.toLowerCase();
  } catch {
    return null;
  }
  // A path ends with the tail ("/img/a.png") when its last segments are the tail's.
  const segments = tail.split("/").slice(1);
  let node: PathNode | undefined = index.paths;
  for (let s = segments.length - 1; s >= 0 && node; s--) node = node.next.get(segments[s]);
  return part(node?.first);
}
