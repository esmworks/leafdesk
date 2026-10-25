/**
 * Tables written back from Markdown keep how they looked. Markdown holds a table's text only: its
 * column widths, header rows and columns, cell colors and alignment would all go on every rewrite
 * (MCP, the REST API, the Markdown source view). After a rewrite's blocks got their ids back
 * (lib/page-markdown carryOverBlockIds), each table takes those settings from the table it was:
 * the one with its id, else, when the rewrite changed the text of as many tables as it found
 * unmatched, the one in the same place among those. Pure, shared by the server and the preview.
 */
import { cellGrid } from "./table-to-database";

type Block = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: Block[] };
type Cell = { type?: unknown; props?: Record<string, unknown>; content?: unknown } | unknown[];
type Row = { cells?: Cell[] };
type TableContent = { type: "tableContent"; columnWidths?: unknown[]; headerRows?: unknown; headerCols?: unknown; rows?: Row[] };

/** Cell settings Markdown can't hold, and the value a cell read from Markdown has. */
const CELL_LOOKS: Record<string, unknown> = { backgroundColor: "default", textColor: "default", textAlignment: "left" };

const tableContent = (block: Block): TableContent | null => {
  const content = block.content as TableContent | undefined;
  return block.type === "table" && content?.type === "tableContent" ? content : null;
};

/** The tables among the blocks, in document order. */
function tablesIn(blocks: readonly Block[], out: Block[] = []): Block[] {
  for (const block of blocks) {
    if (tableContent(block)) out.push(block);
    tablesIn(block.children ?? [], out);
  }
  return out;
}

const width = (grid: unknown[][]) => Math.max(0, ...grid.map((row) => row.length));

const cellText = (cell: Cell | null) => JSON.stringify(Array.isArray(cell) ? cell : (cell?.content ?? null));

/**
 * Pairs the rows of the rewrite with the rows they were: by place when there are as many, else by
 * the same text, in order. Rows it can't pair (added ones) are left out.
 */
function pairRows(after: (Cell | null)[][], before: (Cell | null)[][]): [number, number][] {
  if (after.length === before.length) return after.map((_, r) => [r, r]);
  const keys = before.map((row) => row.map(cellText).join("\u0001"));
  const pairs: [number, number][] = [];
  let from = 0;
  after.forEach((row, r) => {
    const at = keys.indexOf(row.map(cellText).join("\u0001"), from);
    if (at < 0) return;
    pairs.push([r, at]);
    from = at + 1;
  });
  return pairs;
}

function restoreTable(table: Block, was: Block) {
  const after = tableContent(table)!;
  const before = tableContent(was)!;
  const gridAfter = cellGrid(after.rows ?? []);
  const gridBefore = cellGrid(before.rows ?? []);
  // A table whose columns changed is a new layout: nothing to take over.
  if (!gridAfter.length || width(gridAfter) !== width(gridBefore)) return;
  if (Array.isArray(before.columnWidths) && before.columnWidths.length === width(gridAfter)) after.columnWidths = [...before.columnWidths];
  if (before.headerRows === undefined) delete after.headerRows;
  else after.headerRows = before.headerRows;
  if (before.headerCols === undefined) delete after.headerCols;
  else after.headerCols = before.headerCols;
  const color = was.props?.textColor;
  if (color !== undefined && (table.props?.textColor ?? "default") === "default") table.props = { ...table.props, textColor: color };
  for (const [r, b] of pairRows(gridAfter, gridBefore)) {
    gridAfter[r].forEach((cell, c) => {
      const old = gridBefore[b][c];
      if (!cell || Array.isArray(cell) || !old || Array.isArray(old)) return;
      for (const [key, plain] of Object.entries(CELL_LOOKS)) {
        const value = old.props?.[key];
        if (value === undefined || value === plain || (cell.props?.[key] ?? plain) !== plain) continue;
        cell.props = { ...cell.props, [key]: value };
      }
    });
  }
}

/**
 * Gives the tables of a rewrite (`blocks`, ids carried over) the settings of the tables they were
 * in `existing`, in place.
 */
export function restoreTableLooks(blocks: Block[], existing: readonly Block[]) {
  const before = tablesIn(existing);
  if (!before.length) return;
  const after = tablesIn(blocks);
  const byId = new Map(before.flatMap((table) => (table.id ? [[table.id, table] as const] : [])));
  const used = new Set<Block>();
  const unpaired: Block[] = [];
  for (const table of after) {
    const was = table.id ? byId.get(table.id) : undefined;
    if (was && !used.has(was)) {
      used.add(was);
      restoreTable(table, was);
    } else unpaired.push(table);
  }
  // Tables whose text changed got no id: paired by place, only when the counts leave no doubt.
  const left = before.filter((table) => !used.has(table));
  if (unpaired.length === left.length) unpaired.forEach((table, i) => restoreTable(table, left[i]));
}
