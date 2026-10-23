// Client-safe: files attached to the AI chat's questions, their kinds, limits and names. The box
// (src/components/ai-chat) uploads each file as it is attached (/api/ai/chat/files) and sends the
// question with their ids; the server (server/ai-chat-files.ts) checks and reads them: images go to
// the model as images, documents as their text (file-text.ts), CSV files as tables
// (chat-attachment-table.ts) the chat can read further and make a database of.

const MB = 1024 * 1024;

/**
 * What a question may attach: how many files, and how large each may be; images less, as providers
 * take a few megabytes per image.
 */
export const CHAT_FILE_LIMITS = { perQuestion: 5, bytes: 20 * MB, imageBytes: 5 * MB };

/** The largest CSV file the chat takes (its text, in characters), its most rows and columns. */
export const CHAT_CSV_MAX_CHARS = 1_000_000;
export const CHAT_CSV_MAX_ROWS = 1_000;
export const CHAT_CSV_MAX_COLUMNS = 100;
/** The longest file name kept. */
export const CHAT_ATTACHMENT_NAME = 200;

/** Images the chat shows a model (those providers take). */
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const CSV_TYPES = ["text/csv", "application/csv", "text/comma-separated-values"];
const TEXT_TYPES = ["text/plain", "text/markdown", "text/x-markdown"];

/** What the file chooser offers. */
export const CHAT_FILE_ACCEPT = [...CHAT_IMAGE_TYPES, ".pdf", ".docx", ".xlsx", ".csv", ".md", ".markdown", ".txt"].join(",");

export type ChatFileKind = "image" | "document" | "csv" | "text";

/**
 * How the chat reads a file: an image (shown to the model), a document (PDF, Word, Excel, read to
 * text), a CSV file (a table), plain text (Markdown, text); null for anything else, which can't be
 * attached.
 */
export function chatFileKind(contentType: string, name: string): ChatFileKind | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if ((CHAT_IMAGE_TYPES as readonly string[]).includes(type)) return "image";
  if (DOCUMENT_TYPES.includes(type)) return "document";
  if (CSV_TYPES.includes(type) || (ext === "csv" && (type === "text/plain" || type === "application/vnd.ms-excel"))) return "csv";
  if (TEXT_TYPES.includes(type)) return "text";
  if (ext === "docx" || ext === "xlsx" || ext === "pdf") return type === "application/octet-stream" || type === "application/zip" ? "document" : null;
  if (ext === "csv") return "csv";
  if (ext === "md" || ext === "markdown" || ext === "txt") return "text";
  return null;
}

/** Where the person who attached a chat file opens it (no one else can). */
export const chatFileUrl = (id: string) => `/api/ai/chat/files/${id}`;

/**
 * A file attached to a question, as the chat shows it: its name (unique in the conversation), type
 * and size, a CSV file's rows and columns; `url` opens it.
 */
export type ChatAttachmentView = { id: string; name: string; contentType: string; size: number; rows?: number; columns?: number; url: string };

/** Why a CSV file can't be attached. */
export type AttachmentProblem = "tooLarge" | "tooManyRows" | "tooManyColumns" | "empty";

/** A file's name as kept: one line, at most CHAT_ATTACHMENT_NAME characters. */
export function cleanAttachmentName(name: string): string {
  const flat = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return flat.slice(0, CHAT_ATTACHMENT_NAME) || "file";
}

/** `name`, or "name (2).csv" and so on when one of `taken` has it (compared without case). */
export function uniqueAttachmentName(taken: readonly string[], name: string): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const next = `${base} (${n})${ext}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}
