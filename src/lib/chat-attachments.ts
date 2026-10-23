// Client-safe: CSV files attached to a question of the AI chat. The box (src/components/ai-chat)
// reads a file to show its size and refuse one too large before sending; the server
// (server/ai-chat.ts) reads the text again with the same limits, keeps the table with the
// conversation and gives it to the model, cut to fit (attachmentCsv).
import { csvTable, type CsvTable } from "./import/csv-parse";

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
  const flat = name.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  return flat.slice(0, CHAT_ATTACHMENT_NAME) || "data.csv";
}

/** A CSV file's text as a table, or why it can't be attached. */
export function readCsvAttachment(text: string): { ok: true; table: CsvTable } | { ok: false; problem: AttachmentProblem } {
  if (text.length > CHAT_CSV_MAX_CHARS) return { ok: false, problem: "tooLarge" };
  const table = csvTable(text);
  if (!table.headers.length) return { ok: false, problem: "empty" };
  if (table.headers.length > CHAT_CSV_MAX_COLUMNS) return { ok: false, problem: "tooManyColumns" };
  if (table.rows.length > CHAT_CSV_MAX_ROWS) return { ok: false, problem: "tooManyRows" };
  return { ok: true, table };
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

/** A cell as CSV: quoted when it holds a separator, a quote or a line break. */
function cell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A table as CSV text for the model: the header, then the rows from `from` (0-based) as many as fit
 * in `maxChars` (at least the header). `shown` is how many rows it has.
 */
export function attachmentCsv(table: CsvTable, { from = 0, maxChars }: { from?: number; maxChars: number }): { text: string; shown: number } {
  let text = table.headers.map(cell).join(",");
  let shown = 0;
  for (let i = Math.max(0, from); i < table.rows.length; i++) {
    const line = `\n${table.rows[i].map(cell).join(",")}`;
    if (text.length + line.length > maxChars) break;
    text += line;
    shown += 1;
  }
  return { text, shown };
}
