import { createBlockSpecFromTiptapNode, type ExtensionFactoryInstance } from "@blocknote/core";
import { Node } from "@tiptap/core";

/**
 * Columns: blocks side by side. A column list holds two to five columns, a column holds blocks.
 *
 * BlockNote's core already understands this structure (the `columnList` and `column` nodes its
 * multi-column package adds): blocks inside columns are ordinary blocks with ids, moving and
 * removing them keeps the lists valid, and Backspace and Delete step between columns. That package
 * is GPL-3.0 (or commercial), so the two nodes are defined here instead, shared by the editor
 * (components/page/columns.tsx adds resizing and cleanup) and the server (server/blocknote.ts),
 * like the other blocks. In the BlockNote API a column list is a block whose children are its
 * columns, and a column one whose children are its blocks; neither has content or text.
 *
 * A column's `width` is its share of the row (a flex-grow factor, 1 by default), so equal columns
 * need nothing stored and a resized one keeps its proportion at any page width.
 *
 * A column list's `wide` is how far it reaches past the text into the page's margins on a page of
 * standard width: 0 not at all (the default), 1 out to the page's edges less room for the block
 * handles (globals.css). Full-width pages, narrow screens and published pages show it at the
 * text's width.
 */

export const COLUMN_LIST_BLOCK = "columnList";
export const COLUMN_BLOCK = "column";
/** Columns a list may have: fewer read as one, more don't fit a page. */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 5;

export const isColumnBlockType = (type: unknown) => type === COLUMN_LIST_BLOCK || type === COLUMN_BLOCK;

/** A usable column width: a positive factor, bounded so one column can't squeeze the others to nothing. */
export function columnWidth(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(Math.max(n, 0.1), 10) * 100) / 100;
}

/** A usable `wide`: 0 to 1, in hundredths. */
export function columnsWide(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(Math.min(n, 1) * 100) / 100;
}

function domFor(name: string, className: string, attributes: Record<string, unknown>) {
  const dom = document.createElement("div");
  dom.className = className;
  dom.setAttribute("data-node-type", name);
  for (const [attribute, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined && attribute !== "class" && attribute !== "style") dom.setAttribute(attribute, String(value));
  }
  return dom;
}

export const ColumnListNode = Node.create({
  name: COLUMN_LIST_BLOCK,
  // "bnBlock": a BlockNote block (it has an id); "childContainer": its children are blocks;
  // "blockGroupChild": it goes wherever a block goes.
  group: "childContainer bnBlock blockGroupChild",
  content: "column column+",
  priority: 40,
  defining: true,
  addAttributes() {
    return {
      wide: {
        default: 0,
        parseHTML: (element) => columnsWide(element.getAttribute("data-wide")),
        renderHTML: (attributes) => (columnsWide(attributes.wide) ? { "data-wide": String(columnsWide(attributes.wide)) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: `div[data-node-type="${COLUMN_LIST_BLOCK}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = domFor(COLUMN_LIST_BLOCK, "leafdesk-columns", HTMLAttributes);
    return { dom, contentDOM: dom };
  },
});

export const ColumnNode = Node.create({
  name: COLUMN_BLOCK,
  group: "bnBlock childContainer",
  content: "blockContainer+",
  priority: 40,
  defining: true,
  addAttributes() {
    return {
      width: {
        default: 1,
        parseHTML: (element) => columnWidth(element.getAttribute("data-width")),
        renderHTML: (attributes) => ({ "data-width": String(columnWidth(attributes.width)) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: `div[data-node-type="${COLUMN_BLOCK}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = domFor(COLUMN_BLOCK, "leafdesk-column", HTMLAttributes);
    dom.style.flexGrow = String(columnWidth(HTMLAttributes["data-width"]));
    return { dom, contentDOM: dom };
  },
});

/** The two block specs, from the given nodes (the editor passes its own, with resizing). */
export function columnBlockSpecs({
  columnList = ColumnListNode,
  column = ColumnNode,
  extensions,
}: { columnList?: Node; column?: Node; extensions?: ExtensionFactoryInstance[] } = {}) {
  return {
    columnList: createBlockSpecFromTiptapNode({ node: columnList, type: COLUMN_LIST_BLOCK, content: "none" }, { wide: { default: 0 } }, extensions),
    column: createBlockSpecFromTiptapNode({ node: column, type: COLUMN_BLOCK, content: "none" }, { width: { default: 1 } }),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * Markdown has no columns. They are written as HTML comments around their blocks, in reading
 * order, so other Markdown readers still show everything (one column after another):
 *
 *   <!-- leafdesk:columns -->
 *   <!-- leafdesk:column -->
 *   Left column's blocks
 *   <!-- leafdesk:column width=2 -->
 *   Right column's blocks, twice as wide
 *   <!-- leafdesk:/columns -->
 *
 * A wide list says so on its first line: `<!-- leafdesk:columns wide=1 -->`.
 */
export type ColumnMarker = { kind: "columns"; wide?: number } | { kind: "column"; width: number } | { kind: "end" };

export function columnMarkerLine(marker: ColumnMarker): string {
  if (marker.kind === "columns") {
    const wide = columnsWide(marker.wide);
    return wide ? `<!-- leafdesk:columns wide=${wide} -->` : "<!-- leafdesk:columns -->";
  }
  if (marker.kind === "end") return "<!-- leafdesk:/columns -->";
  const width = columnWidth(marker.width);
  return width === 1 ? "<!-- leafdesk:column -->" : `<!-- leafdesk:column width=${width} -->`;
}

const MARKER_LINE = /^ {0,3}<!--\s*leafdesk:(columns|column|\/columns)(?:\s+(?:width|wide)=([0-9]*\.?[0-9]+))?\s*-->\s*$/;

export function parseColumnMarker(line: string): ColumnMarker | null {
  const match = MARKER_LINE.exec(line);
  if (!match) return null;
  if (match[1] === "columns") return columnsWide(match[2]) ? { kind: "columns", wide: columnsWide(match[2]) } : { kind: "columns" };
  if (match[1] === "/columns") return { kind: "end" };
  return { kind: "column", width: columnWidth(match[2] ?? 1) };
}

/**
 * The block a marker stands for between parsing and groupColumns. Its type is no block's, so one
 * left behind would fail loudly rather than write something odd.
 */
export const COLUMN_MARKER_BLOCK = "leafdesk:columnMarker";

type Tree = { type: string; props?: Record<string, unknown>; children?: Tree[] };

export function columnMarkerBlock<B>(marker: ColumnMarker): B {
  return { type: COLUMN_MARKER_BLOCK, props: { ...marker }, children: [] } as unknown as B;
}

const markerOf = (block: Tree): ColumnMarker | null =>
  block.type === COLUMN_MARKER_BLOCK ? (block.props as unknown as ColumnMarker) : null;

/**
 * Turns the markers left by Markdown import into column lists, at every level. Lenient: blocks
 * between "columns" and the first "column" go to the first column, a missing "/columns" closes at
 * the end, a column without blocks gets an empty line, columns past five join the fifth, and a
 * list with fewer than two columns is just its blocks. Stray markers are dropped.
 */
export function groupColumns<B extends Tree>(blocks: B[]): B[] {
  const out: B[] = [];
  const walk = (block: B): B => (block.children?.length ? { ...block, children: groupColumns(block.children as B[]) } : block);
  for (let i = 0; i < blocks.length; i++) {
    const marker = markerOf(blocks[i]);
    if (!marker) {
      out.push(walk(blocks[i]));
      continue;
    }
    if (marker.kind !== "columns") continue;
    const columns: { width: number; blocks: B[] }[] = [];
    // Blocks came before the first "column": they started the first column already.
    let started = false;
    for (i++; i < blocks.length; i++) {
      const inner = markerOf(blocks[i]);
      if (inner?.kind === "end") break;
      if (inner?.kind === "column") {
        if (started) columns[0].width = inner.width;
        else if (columns.length < MAX_COLUMNS) columns.push({ width: inner.width, blocks: [] });
        started = false;
        continue;
      }
      // Another "columns" inside: columns don't nest, so it's dropped.
      if (inner) continue;
      if (!columns.length) {
        columns.push({ width: 1, blocks: [] });
        started = true;
      }
      columns[columns.length - 1].blocks.push(walk(blocks[i]));
    }
    if (columns.length < MIN_COLUMNS) {
      for (const column of columns) out.push(...column.blocks);
      continue;
    }
    out.push({
      type: COLUMN_LIST_BLOCK,
      props: marker.wide ? { wide: columnsWide(marker.wide) } : {},
      children: columns.map((column) => ({
        type: COLUMN_BLOCK,
        props: { width: column.width },
        children: column.blocks.length ? column.blocks : [{ type: "paragraph", children: [] }],
      })),
    } as unknown as B);
  }
  return out;
}
