// The table of a CSV file attached to the AI chat (chat-attachments.ts): read with the chat's limits,
// and written back as CSV for the model. Apart from chat-attachments.ts so the box loads the
// parser only when a file is attached.
import { CHAT_CSV_MAX_CHARS, CHAT_CSV_MAX_COLUMNS, CHAT_CSV_MAX_ROWS, type AttachmentProblem } from "./chat-attachments";
import { csvTable, type CsvTable } from "./import/csv-parse";

export { decodeText } from "./import/csv-parse";

/** A CSV file's text as a table, or why it can't be attached. */
export function readCsvAttachment(text: string): { ok: true; table: CsvTable } | { ok: false; problem: AttachmentProblem } {
  if (text.length > CHAT_CSV_MAX_CHARS) return { ok: false, problem: "tooLarge" };
  const table = csvTable(text);
  if (!table.headers.length) return { ok: false, problem: "empty" };
  if (table.headers.length > CHAT_CSV_MAX_COLUMNS) return { ok: false, problem: "tooManyColumns" };
  if (table.rows.length > CHAT_CSV_MAX_ROWS) return { ok: false, problem: "tooManyRows" };
  return { ok: true, table };
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
