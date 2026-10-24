/**
 * The Markdown source view (components/page/markdown-source.tsx): what a page loses when it is
 * written back from Markdown, where its blocks start in the source, and how the preview follows the
 * editor's scrolling. Pure, shared by the browser and the server.
 */
import { mapSyncedRegions, syncedKey } from "./synced-blocks";
import { cellGrid } from "./table-to-database";

// ---------------------------------------------------------------------------------------------
// What Markdown can't hold

/**
 * Kinds of things a save from Markdown drops, in the order the view lists them. Found by writing
 * the page's blocks as Markdown and reading them back (server/markdown-source.ts), so the list
 * follows the dialect (lib/content-markdown) rather than a list kept by hand.
 */
export const MARKDOWN_LOSSES = [
  "textColor",
  "backgroundColor",
  "alignment",
  "mediaSize",
  "callout",
  "textStyle",
  "table",
  "blockSetting",
  "content",
] as const;
export type MarkdownLoss = (typeof MARKDOWN_LOSSES)[number];

type Block = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: Block[] };

/** Block props whose loss has a name of its own; any other changed prop is a "blockSetting". */
const PROP_LOSS: Record<string, MarkdownLoss> = {
  textColor: "textColor",
  backgroundColor: "backgroundColor",
  textAlignment: "alignment",
  previewWidth: "mediaSize",
  crop: "mediaSize",
};

/** Inline styles whose loss has a name of its own; any other is a "textStyle" (underline, say). */
const STYLE_LOSS: Record<string, MarkdownLoss> = { textColor: "textColor", backgroundColor: "backgroundColor" };

/** JSON with object keys sorted, so equal values compare equal whatever order their keys came in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * What `after` (the page's blocks written as Markdown and read back) lost of `before` (the blocks
 * as they are), by kind. Block ids don't count: Markdown has none, and writes keep them where the
 * blocks match.
 */
export function markdownLosses(before: readonly Block[], after: readonly Block[]): MarkdownLoss[] {
  const found = new Set<MarkdownLoss>();
  compareLists(before, after, found);
  return MARKDOWN_LOSSES.filter((kind) => found.has(kind));
}

function compareLists(before: readonly Block[], after: readonly Block[], found: Set<MarkdownLoss>) {
  // Matched from both ends while the block types agree, so one block missing in the middle doesn't
  // make every block after it read as changed. Whatever is left unmatched is lost content.
  let head = 0;
  while (head < before.length && head < after.length && before[head].type === after[head].type) {
    compareBlock(before[head], after[head], found);
    head++;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail].type === after[after.length - 1 - tail].type
  ) {
    compareBlock(before[before.length - 1 - tail], after[after.length - 1 - tail], found);
    tail++;
  }
  if (head + tail < Math.max(before.length, after.length)) found.add("content");
}

function compareBlock(before: Block, after: Block, found: Set<MarkdownLoss>) {
  const props = new Set([...Object.keys(before.props ?? {}), ...Object.keys(after.props ?? {})]);
  for (const key of props) {
    if (same(before.props?.[key], after.props?.[key])) continue;
    found.add(before.type === "callout" ? "callout" : (PROP_LOSS[key] ?? "blockSetting"));
  }
  compareContent(before.content, after.content, found);
  compareLists(before.children ?? [], after.children ?? [], found);
}

function compareContent(before: unknown, after: unknown, found: Set<MarkdownLoss>) {
  if (Array.isArray(before) && Array.isArray(after)) return compareInline(before, after, found);
  const table = (value: unknown) => (value as { type?: unknown } | null)?.type === "tableContent";
  if (table(before) && table(after)) return compareTable(before as TableContent, after as TableContent, found);
  const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
  if (empty(before) && empty(after)) return;
  if (!same(before, after)) found.add("content");
}

type Cell = { type?: string; props?: Record<string, unknown>; content?: unknown } | unknown[];
type TableContent = { type: "tableContent"; columnWidths?: unknown[]; rows?: { cells?: Cell[] }[] } & Record<string, unknown>;

function compareTable(before: TableContent, after: TableContent, found: Set<MarkdownLoss>) {
  const { rows: rowsBefore = [], ...restBefore } = before;
  const { rows: rowsAfter = [], ...restAfter } = after;
  // Column widths, header rows and the like.
  if (!same(restBefore, restAfter)) found.add("table");
  if (rowsBefore.length !== rowsAfter.length) found.add("content");
  // Compared place by place: Markdown has no merged cells, so a merged cell comes back as its
  // first place's cell and empty ones for the places it covered.
  const gridAfter = cellGrid(rowsAfter);
  const parts = (value: Cell) => (Array.isArray(value) ? { props: {}, content: value } : { props: value.props ?? {}, content: value.content });
  cellGrid(rowsBefore).forEach((cellsBefore, r) => {
    const cellsAfter = gridAfter[r] ?? [];
    if (cellsBefore.length !== cellsAfter.length) found.add("content");
    cellsBefore.forEach((cell, c) => {
      const other = cellsAfter[c];
      if (other === undefined) return;
      if (cell === null || other === null) {
        // A merge made or undone: the cell on the other side should be empty.
        found.add("table");
        const filled = cell ?? other;
        if (filled) compareContent(parts(filled).content ?? [], [], found);
        return;
      }
      const a = parts(cell);
      const b = parts(other);
      if (!same(a.props, b.props)) found.add("table");
      compareContent(a.content ?? [], b.content ?? [], found);
    });
  });
}

type Unit = { char: string; styles: Record<string, unknown>; link: string | null } | { node: string };

/** Inline content as one unit per character (with its styles and link), and one per other node. */
function units(content: unknown[], link: string | null = null, out: Unit[] = []): Unit[] {
  for (const raw of content) {
    const node = raw as { type?: string; text?: unknown; styles?: Record<string, unknown>; href?: unknown; content?: unknown };
    if (node?.type === "text" && typeof node.text === "string") {
      for (const char of node.text) out.push({ char, styles: node.styles ?? {}, link });
    } else if (node?.type === "link" && Array.isArray(node.content)) {
      units(node.content, String(node.href ?? ""), out);
    } else {
      out.push({ node: stable(node) });
    }
  }
  return out;
}

function compareInline(before: unknown[], after: unknown[], found: Set<MarkdownLoss>) {
  const a = units(before);
  const b = units(after);
  if (a.length !== b.length) return void found.add("content");
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if ("node" in x || "node" in y) {
      if (!("node" in x && "node" in y && x.node === y.node)) found.add("content");
      continue;
    }
    if (x.char !== y.char || x.link !== y.link) {
      found.add("content");
      continue;
    }
    for (const key of new Set([...Object.keys(x.styles), ...Object.keys(y.styles)])) {
      if (!same(x.styles[key], y.styles[key])) found.add(STYLE_LOSS[key] ?? "textStyle");
    }
  }
}

/**
 * How many synced blocks `edited` changes the blocks of. A synced block's blocks show in its
 * page's Markdown between its marker lines, but a write never takes them from there (they are
 * edited in the page itself, see lib/synced-blocks): such changes are lost.
 */
export function changedSyncedRegions(original: string, edited: string): number {
  const regions = (markdown: string) => {
    const found = new Map<string, string>();
    mapSyncedRegions(markdown, (ref, inner) => {
      found.set(syncedKey(ref), inner.trim());
      return null;
    });
    return found;
  };
  const before = regions(original);
  let changed = 0;
  for (const [key, inner] of regions(edited)) {
    const was = before.get(key);
    if (was !== undefined && was !== inner) changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Where the blocks start in the source

/** A top-level block of the source: the line it starts on (0-based) and its Markdown. */
export type SourceStart = { line: number; text: string };

/** Letters and digits only, lower-cased, without link targets, footnote marks or HTML comments. */
function letters(text: string) {
  return text
    .toLowerCase()
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** How much of a block's text identifies it. */
const KEY_LENGTH = 16;

/**
 * Pairs the preview's top-level blocks (by their text, in order) with the source's top-level blocks
 * (`starts`, in order): a block matches the first source block after the last match whose text
 * holds the start of the block's text. Blocks without text (images, dividers, databases) pair up
 * by position where the blocks and source blocks between two matches are equally many. Returns the
 * pairs in order; blocks it can't place are left out.
 */
export function lineAnchors(starts: readonly SourceStart[], blocks: readonly string[]): { block: number; line: number }[] {
  const sources = starts.map((start) => letters(start.text));
  const matched: { block: number; start: number }[] = [];
  let from = 0;
  blocks.forEach((text, block) => {
    const key = letters(text).slice(0, KEY_LENGTH);
    if (key.length < 2) return;
    for (let i = from; i < sources.length; i++) {
      if (!sources[i].includes(key)) continue;
      matched.push({ block, start: i });
      from = i + 1;
      return;
    }
  });
  // The gaps between matches (and before the first and after the last), filled by position when
  // they hold as many blocks as source blocks.
  const pairs: { block: number; start: number }[] = [];
  let lastBlock = -1;
  let lastStart = -1;
  for (const next of [...matched, { block: blocks.length, start: starts.length }]) {
    const gapBlocks = next.block - lastBlock - 1;
    if (gapBlocks > 0 && gapBlocks === next.start - lastStart - 1) {
      for (let k = 1; k <= gapBlocks; k++) pairs.push({ block: lastBlock + k, start: lastStart + k });
    }
    if (next.block < blocks.length) pairs.push(next);
    lastBlock = next.block;
    lastStart = next.start;
  }
  return pairs.map(({ block, start }) => ({ block, line: starts[start].line }));
}

/**
 * Where the preview scrolls for the editor's top line `line` (fractional): between the two anchors
 * (a source line and the preview's offset of the block it starts) around it, in proportion. The
 * top (line 0, offset 0) and `end` (the line after the last and the preview's full height) close
 * the ends. Anchors that don't move down in both line and offset are skipped.
 */
export function previewScrollTop(anchors: readonly { line: number; top: number }[], line: number, end: { line: number; top: number }): number {
  const points = [{ line: 0, top: 0 }];
  for (const anchor of [...anchors].sort((a, b) => a.line - b.line)) {
    const last = points[points.length - 1];
    if (anchor.line > last.line && anchor.top >= last.top) points.push(anchor);
  }
  const last = points[points.length - 1];
  if (end.line > last.line && end.top >= last.top) points.push(end);
  if (line <= 0) return 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (line <= b.line) return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top);
  }
  return points[points.length - 1].top;
}
