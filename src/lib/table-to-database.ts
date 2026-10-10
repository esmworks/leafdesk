import { recordsTable, type CsvTable } from "./import/csv";

/**
 * Turning an editor table block into a database: the table's cells as plain text, then as the
 * header and rows a new database is made of (see server/embeds tableToDatabase). Pure and
 * client-safe.
 */

type Inline = { type?: string; text?: unknown; content?: unknown };
type Cell = Inline[] | { type: "tableCell"; content?: unknown; props?: { colspan?: number; rowspan?: number } };
/** A table block's content as the editor gives it (BlockNote's TableContent), loosely typed. */
export type TableBlockContent = { type?: string; rows?: { cells?: Cell[] }[] };

/** Inline content as plain text: text and the text of links (and anything else holding text), formatting dropped. */
export function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: Inline | string) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      return inlineText(item.content);
    })
    .join("");
}

const span = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 1 ? n : 1);

/**
 * A table block's cells as rows of text, every row as wide as the widest. A merged cell's text goes
 * to its first (top left) position; the positions it covers stay empty, as empty cells do.
 */
export function tableRecords(content: TableBlockContent | null | undefined): string[][] {
  const grid: (string | undefined)[][] = [];
  (content?.rows ?? []).forEach((row, r) => {
    const line = (grid[r] ??= []);
    let c = 0;
    for (const cell of row.cells ?? []) {
      // Positions a cell above still covers are skipped.
      while (line[c] !== undefined) c++;
      const isCell = !Array.isArray(cell) && cell?.type === "tableCell";
      const text = inlineText(isCell ? cell.content : cell);
      const cols = isCell ? span(cell.props?.colspan) : 1;
      const rows = isCell ? span(cell.props?.rowspan) : 1;
      for (let dr = 0; dr < rows; dr++) {
        const covered = (grid[r + dr] ??= []);
        for (let dc = 0; dc < cols; dc++) covered[c + dc] = dr === 0 && dc === 0 ? text : "";
      }
      c += cols;
    }
  });
  // Rows a merged cell reaches past the table's end aren't the table's.
  const rows = grid.slice(0, content?.rows?.length ?? 0);
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}

/**
 * The first row as the property names (blank ones named "Column N" and repeats numbered, as CSV
 * imports name them), the other rows as they are, empty ones included: one database row each.
 */
export function tableAsDatabase(records: string[][]): CsvTable {
  const [head = [], ...body] = records;
  const { headers } = recordsTable([head], { guarded: false });
  return { headers, rows: body.map((row) => headers.map((_, i) => row[i] ?? "")) };
}
