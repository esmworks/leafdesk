// Client-safe: CSV files attached to a question of the AI chat: their limits, names and sizes. The
// box (src/components/ai-chat) reads a file (chat-attachment-table.ts, loaded only then) to show
// its size and refuse one too large before sending; the server (server/ai-chat.ts) reads the text
// again with the same limits, keeps the table with the conversation and gives it to the model, cut
// to fit (attachmentCsv).

/** The largest CSV file a question takes (its text, in characters), its most rows and columns. */
export const CHAT_CSV_MAX_CHARS = 1_000_000;
export const CHAT_CSV_MAX_ROWS = 1_000;
export const CHAT_CSV_MAX_COLUMNS = 100;
/** Files one question may have, and the longest name kept. */
export const CHAT_MAX_ATTACHMENTS = 3;
export const CHAT_ATTACHMENT_NAME = 200;

/** An attached file as a question shows it: its name and size. */
export type ChatAttachmentView = { name: string; rows: number; columns: number };

/** Why a file can't be attached. */
export type AttachmentProblem = "notCsv" | "tooLarge" | "tooManyRows" | "tooManyColumns" | "empty" | "tooMany";

/** Whether a file is a CSV file, by its name or type. */
export function isCsvFile(file: { name: string; type: string }): boolean {
  return /\.csv$/i.test(file.name) || /^(text\/csv|application\/csv|text\/comma-separated-values)$/i.test(file.type);
}

/** A file's name as kept: one line, at most CHAT_ATTACHMENT_NAME characters. */
export function cleanAttachmentName(name: string): string {
  const flat = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return flat.slice(0, CHAT_ATTACHMENT_NAME) || "data.csv";
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
