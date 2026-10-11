/**
 * Uploaded files, as the editor, the file route and the server share them. Pure helpers only: no
 * database, no storage, so both sides (and tests) can use them.
 */

/** Where files are served from: `/api/files/<id>`. Page bodies hold this path as the block's URL. */
export const FILE_ROUTE = "/api/files";

/** Ids are 18 random bytes in base64url: 24 characters, 144 bits, never guessable. */
export const FILE_ID_LENGTH = 24;
const FILE_ID = /^[A-Za-z0-9_-]{24}$/;

export const isFileId = (value: unknown): value is string => typeof value === "string" && FILE_ID.test(value);

/** The URL a block stores for an uploaded file. Same-origin and relative, so it survives APP_URL changes. */
export const fileUrl = (id: string) => `${FILE_ROUTE}/${id}`;

/**
 * File ids referenced by text (a page's Markdown, a block URL), in order of first appearance.
 * Absolute URLs (`https://host/api/files/<id>`) count too. Keep in sync with the trigger in
 * drizzle/0015_file_uploads.sql, which does the same in Postgres.
 */
export function fileIdsIn(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\/api\/files\/([A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])/g)) ids.add(match[1]);
  return [...ids];
}

/**
 * The id of an uploaded file a URL points at: `/api/files/<id>`, the same on any host
 * (`https://host/api/files/<id>`, what MCP hands out), or the bare id. Null for anything else.
 */
export function fileIdOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const value = url.trim();
  if (isFileId(value)) return value;
  const match = /^(?:https?:\/\/[^/\s]+)?\/api\/files\/([A-Za-z0-9_-]{24})(?:[?#][^\s]*)?$/.exec(value);
  return match ? match[1] : null;
}

/**
 * One file of a files property value, as stored: the file's path (`/api/files/<id>`), and its name
 * and type as the server read them from the file when it was attached (never what a client says).
 */
export type FileValue = { url: string; name: string; type: string };

/** Most files one files property value holds. */
export const MAX_FILES_PER_VALUE = 100;

/** A stored files value as a list; entries that aren't uploaded files are left out. */
export function asFiles(value: unknown): FileValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry as Partial<FileValue> | null;
    if (!item || typeof item !== "object") return [];
    const id = fileIdOf(item.url);
    if (!id) return [];
    return [
      {
        url: fileUrl(id),
        name: typeof item.name === "string" && item.name ? item.name : "file",
        type: typeof item.type === "string" && item.type ? item.type : "application/octet-stream",
      },
    ];
  });
}

/**
 * File ids a row's property values hold: the `url` of every entry of every list value. Keep in sync
 * with the trigger in drizzle/0016_files_property_references.sql, which does the same in Postgres
 * (`$.*[*].url`), so only files property values count, never text that merely contains a path.
 */
export function fileIdsInProperties(properties: Record<string, unknown> | null | undefined): string[] {
  const ids = new Set<string>();
  for (const value of Object.values(properties ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const url = entry && typeof entry === "object" ? (entry as { url?: unknown }).url : undefined;
      if (typeof url !== "string") continue;
      const match = /^\/api\/files\/([A-Za-z0-9_-]{24})$/.exec(url);
      if (match) ids.add(match[1]);
    }
  }
  return [...ids];
}

/** Whether browsers show a file of this type as an image thumbnail (raster images only, like isSafeInline). */
export function isImageFile(type: string): boolean {
  return INLINE_IMAGES.has(type);
}

/** The first image of a files value, for gallery covers; null without one. */
export function firstImageFile(value: unknown): FileValue | null {
  return asFiles(value).find((f) => isImageFile(f.type)) ?? null;
}

/**
 * The uploaded PDF a file block shows, by its URL and name: an uploaded file (`/api/files/<id>`,
 * same-origin only) whose name ends in `.pdf`. Blocks keep no content type, so the name decides;
 * the viewer loads `pdfViewUrl`, which the file route serves only for files that really are PDFs.
 */
export function pdfFileId(url: unknown, name: unknown): string | null {
  if (typeof url !== "string" || typeof name !== "string") return null;
  const match = /^\/api\/files\/([A-Za-z0-9_-]{24})$/.exec(url.trim());
  return match && /\.pdf$/i.test(name.trim()) ? match[1] : null;
}

/**
 * Where an inline PDF viewer loads a file from: the file route with `view=pdf`, which answers 404
 * instead of the bytes unless the file is stored as application/pdf, so a frame never downloads
 * or shows anything else (see api/files/[id]).
 */
export const pdfViewUrl = (id: string) => `${fileUrl(id)}?view=pdf`;

/** Longest file name kept; longer names are cut, keeping the extension. */
export const MAX_FILE_NAME = 200;

/** A file name safe to store and show: no path, no control characters, not empty, not too long. */
export function cleanFileName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  // Only the last path segment; browsers send bare names, other clients may not.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= MAX_FILE_NAME) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_FILE_NAME - ext.length) + ext;
}

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The type a file is stored and served with: the one the client declared when it is a well-formed
 * media type, else a guess from the extension, else application/octet-stream. Parameters
 * (`; charset=…`) are dropped. Whatever it says, only SAFE_INLINE types are ever shown in the
 * browser (see dispositionOf), so a wrong label can't turn a file into a page.
 */
export function contentTypeFor(declared: unknown, name: string): string {
  const type = typeof declared === "string" ? declared.split(";")[0].trim().toLowerCase() : "";
  if (type && type !== "application/octet-stream" && MEDIA_TYPE.test(type)) return type;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : "application/octet-stream";
}

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);

/**
 * Types the browser may show in place: raster images, video, audio and PDF. SVG is not among them
 * (it can carry script), nor is anything that renders as a document (HTML, XML, text).
 */
export function isSafeInline(contentType: string): boolean {
  return (
    INLINE_IMAGES.has(contentType) ||
    /^video\/[a-z0-9.+-]+$/.test(contentType) ||
    /^audio\/[a-z0-9.+-]+$/.test(contentType) ||
    contentType === "application/pdf"
  );
}

/** `Content-Disposition` for serving a file: inline only for safe types, a download otherwise. */
export function dispositionOf(contentType: string, name: string): string {
  const kind = isSafeInline(contentType) ? "inline" : "attachment";
  // An ASCII fallback for old clients, and the real name in RFC 5987 form.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** The BlockNote block that shows a file of this type. */
export function blockTypeFor(contentType: string): "image" | "video" | "audio" | "file" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

/** "25 MB" and the like, for limits in messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * A single `Range: bytes=…` request against a file of `size` bytes, as inclusive offsets. Null
 * means "send the whole file" (no header, or several ranges); "unsatisfiable" means 416.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (!from && !to) return null;
  let start: number;
  let end: number;
  if (!from) {
    // The last N bytes.
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to ? Math.min(Number(to), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
