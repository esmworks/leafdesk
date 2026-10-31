/**
 * Which files of an email the AI chat and agents read (server/mail-client/ai-files.ts), and as
 * what. A file's type and name are the sender's word: they only pick a reader, which refuses what
 * isn't that kind of file, and an image's real type is read from its first bytes.
 */

/**
 * A document read to text (`pdf`, Word, Excel, PowerPoint), an image described by a model that
 * has no tools, plain text (CSV, calendars, contacts, XML such as e-invoices, JSON), an HTML page
 * read to text, or an email forwarded as a file.
 */
export type MailFileKind = { kind: "document"; document: "pdf" | "docx" | "xlsx" | "pptx" } | { kind: "image" } | { kind: "text" } | { kind: "html" } | { kind: "message" };

const DOCUMENT_TYPES: Record<string, "pdf" | "docx" | "xlsx" | "pptx"> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "application/csv",
  "text/comma-separated-values",
  "text/tab-separated-values",
  "text/calendar",
  "text/vcard",
  "text/x-vcard",
  "text/xml",
  "application/xml",
  "application/json",
]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "ics", "vcf", "xml", "json", "log"]);
/** Types that say nothing of their own: the file's name decides. */
const VAGUE_TYPES = new Set(["", "application/octet-stream", "application/zip", "application/x-zip-compressed", "application/download", "binary/octet-stream"]);

/** How a mail file is read, by its type, else (for a vague type) its name's extension; null when it isn't read. */
export function mailFileKind(contentType: string, name: string): MailFileKind | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  if (DOCUMENT_TYPES[type]) return { kind: "document", document: DOCUMENT_TYPES[type] };
  if (IMAGE_TYPES.has(type)) return { kind: "image" };
  if (type === "text/html") return { kind: "html" };
  if (type === "message/rfc822") return { kind: "message" };
  if (TEXT_TYPES.has(type) || type.endsWith("+xml") || type.endsWith("+json")) return { kind: "text" };
  // Windows mail programs send a CSV file as an Excel type (chat-attachments.ts reads it so too).
  if (ext === "csv" && type === "application/vnd.ms-excel") return { kind: "text" };
  if (!VAGUE_TYPES.has(type)) return null;
  if (DOCUMENT_EXTENSIONS.has(ext)) return { kind: "document", document: ext as "pdf" | "docx" | "xlsx" | "pptx" };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image" };
  if (ext === "html" || ext === "htm") return { kind: "html" };
  if (ext === "eml") return { kind: "message" };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text" };
  return null;
}

/** An image's type by its first bytes (PNG, JPEG, GIF, WebP: what models take); null for anything else. */
export function imageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const starts = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}
