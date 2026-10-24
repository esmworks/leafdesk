/**
 * Reading a PDF's text layer as a page (the PDF import, server/import/pdf): the pieces of text a
 * PDF reader gives, with their place and font size, become HTML the editor's own reader turns
 * into blocks. A PDF has no structure of its own to read, so it is guessed from the layout:
 *
 * - Pieces on the same baseline make a line, in the order they stand on it (a PDF may draw them in
 *   any order, and split a word at a ligature); a gap wider than a space's separates words.
 * - The size most of the text has is the body's; short lines in a larger size are headings, the
 *   largest size a first-level one, the next a second-level one and any smaller a third.
 * - Lines close under each other in the same size make one paragraph (a word hyphenated at the
 *   end of a line is joined again); a gap, another size, or a short line ending a sentence ends it.
 * - Lines starting with a bullet (•, –, * …) or a number ("1." or "1)") are list items; lines under
 *   an item, as far in as its text, continue it, and an item further in nests under the one above.
 *   Lists drawn without a bullet character (a bullet painted as a shape) stay paragraphs.
 * - Across a page break, a paragraph that didn't end a sentence goes on with the next page's first
 *   line. What recurs at the top or bottom of most pages (running headers and footers) and page
 *   numbers there are left out.
 *
 * One column of text is assumed: columns side by side are read line by line across them.
 */

/** A piece of text on a page: where its baseline starts (PDF points, y up), its font size and width. */
export type PdfTextItem = { str: string; x: number; y: number; size: number; width: number; rtl?: boolean };
export type PdfPageText = { width: number; height: number; items: PdfTextItem[] };

type Line = { page: number; text: string; x: number; right: number; y: number; size: number };

/** Share of the page height at its top and bottom where running headers, footers and page numbers stand. */
const MARGIN = 0.1;
/** How much larger than the body a line's text must be to be a heading. */
const HEADING_RATIO = 1.08;
/** The longest text a heading may have; longer text in a large size is a paragraph. */
const HEADING_CHARS = 200;

const BULLET = /^([•●○◦▪▫■□‣⁃∙·–—*\-])\s+(\S.*)$/u;
const NUMBERED = /^(\d{1,3}[.)]|[a-z]\))\s+(\S.*)$/u;
const PAGE_NUMBER = /^(?:[-–—]\s*)?(?:(?:page|p\.|sayfa|seite|página|pagina|страница|стр\.)\s*)?\d{1,4}(?:\s*(?:\/|of|von|de|di|из|\/)\s*\d{1,4})?(?:\s*[-–—])?$/iu;
/** A line ending a sentence (closing quotes and brackets may follow). */
const SENTENCE_END = /[.!?:;。！？…]["”’»)\]]*$/u;
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;

const round = (size: number) => Math.round(size * 2) / 2;

/** Joins a line's text to the text before it: a word hyphenated at a line's end is joined again. */
export function joinLines(before: string, after: string) {
  if (!before) return after;
  if (/\p{L}-$/u.test(before) && /^\p{Ll}/u.test(after)) return before.slice(0, -1) + after;
  if (CJK.test(before.at(-1) ?? "") && CJK.test(after[0] ?? "")) return before + after;
  return `${before} ${after}`;
}

/** The lines of a page, top to bottom: its pieces grouped by baseline, each line's in reading order. */
export function pageLines(page: PdfPageText, index: number): Line[] {
  const items = page.items
    .filter((item) => item.str.trim() && item.size > 0 && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: { y: number; size: number; items: PdfTextItem[] }[] = [];
  for (const item of items) {
    // Same line when the baselines are closer than half the larger size (a superscript stays on its line).
    const last = groups.at(-1);
    const target = last && Math.abs(last.y - item.y) < 0.5 * Math.max(last.size, item.size) ? last : undefined;
    if (target) {
      target.items.push(item);
      if (item.size > target.size) {
        target.size = item.size;
        target.y = item.y;
      }
    } else groups.push({ y: item.y, size: item.size, items: [item] });
  }
  return groups.map((group) => {
    const rtl = group.items.filter((i) => i.rtl).length > group.items.length / 2;
    const ordered = [...group.items].sort((a, b) => (rtl ? b.x + b.width - (a.x + a.width) : a.x - b.x));
    let text = "";
    let edge = 0;
    for (const item of ordered) {
      const str = item.str.replace(/\s+/g, " ");
      const gap = rtl ? edge - (item.x + item.width) : item.x - edge;
      if (text && gap > 0.2 * item.size && !text.endsWith(" ") && !str.startsWith(" ")) text += " ";
      text += str;
      edge = rtl ? item.x : item.x + item.width;
    }
    // The size most of the line's text has (a superscript or a drop cap doesn't make it a heading).
    const bySize = new Map<number, number>();
    for (const item of group.items) bySize.set(round(item.size), (bySize.get(round(item.size)) ?? 0) + item.str.trim().length);
    const size = [...bySize].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return {
      page: index,
      text: text.trim(),
      x: Math.min(...group.items.map((i) => i.x)),
      right: Math.max(...group.items.map((i) => i.x + i.width)),
      y: group.y,
      size,
    };
  });
}

/** The size most of the text has. */
function bodySize(lines: Line[]) {
  const bySize = new Map<number, number>();
  for (const line of lines) bySize.set(line.size, (bySize.get(line.size) ?? 0) + line.text.length);
  return [...bySize].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

/**
 * Leaves out running headers and footers and page numbers: of the two lines at the top and the two
 * at the bottom of each page, those in its margin that are a page number, or that recur at the
 * same height on most pages (numbers in them may change).
 */
export function withoutPageFurniture(pages: PdfPageText[], lines: Line[][]): Line[][] {
  const edge = (page: Line[], line: Line) => {
    const height = pages[line.page].height;
    const at = page.indexOf(line);
    const outer = at < 2 || at >= page.length - 2;
    return outer && height > 0 && (line.y > height * (1 - MARGIN) || line.y < height * MARGIN);
  };
  const key = (line: Line) => `${Math.round(line.y / 3)}\u0000${line.text.replace(/\d+/g, "#").toLowerCase()}`;
  const seen = new Map<string, number>();
  for (const page of lines) for (const k of new Set(page.filter((line) => edge(page, line)).map(key))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const recurs = (line: Line) => lines.length >= 2 && (seen.get(key(line)) ?? 0) >= Math.max(2, Math.ceil(lines.length / 2));
  return lines.map((page) => page.filter((line) => !(edge(page, line) && (PAGE_NUMBER.test(line.text) || recurs(line)))));
}

type Item = { ordered: boolean; markerX: number; textX: number; text: string; children: Item[] };
type Block =
  | { kind: "heading"; level: number; size: number; text: string; lines: number }
  | { kind: "paragraph"; size: number; text: string; x: number; right: number }
  | { kind: "list"; size: number; items: Item[] };

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The usual distance between two lines of a paragraph in each size, for telling paragraphs apart:
 * the lower quartile of the distances between lines close under each other (gaps between
 * paragraphs are among those, but lines within paragraphs are most of them).
 */
function leadings(lines: Line[][]) {
  const gaps = new Map<number, number[]>();
  for (const page of lines) {
    for (let i = 1; i < page.length; i++) {
      const [a, b] = [page[i - 1], page[i]];
      const gap = a.y - b.y;
      if (a.size === b.size && gap > 0 && gap < 2 * a.size) gaps.set(a.size, [...(gaps.get(a.size) ?? []), gap]);
    }
  }
  const out = new Map<number, number>();
  for (const [size, list] of gaps) out.set(size, list.sort((a, b) => a - b)[Math.floor(list.length / 4)]);
  return (size: number) => Math.max(out.get(size) ?? size * 1.2, size);
}

/**
 * The page's HTML from the text of a PDF's pages, and how many characters of text it has (none:
 * a scan without a text layer).
 */
export function pdfHtml(pages: PdfPageText[]): { html: string; chars: number } {
  const lines = withoutPageFurniture(
    pages,
    pages.map((page, i) => pageLines(page, i)),
  );
  const all = lines.flat();
  const chars = all.reduce((n, line) => n + line.text.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  if (!chars) return { html: "", chars: 0 };
  const body = bodySize(all);
  const leading = leadings(lines);
  const headingSizes = [...new Set(all.filter((l) => l.size >= body * HEADING_RATIO && l.size - body >= 0.5).map((l) => l.size))].sort((a, b) => b - a);
  const levelOf = (size: number) => Math.min(3, headingSizes.indexOf(size) + 1);

  const blocks: Block[] = [];
  let prev: Line | null = null;
  // The last line ends a page: what follows on the next page may still go on with it.
  for (const line of all) {
    const block = blocks.at(-1);
    const samePage = prev?.page === line.page;
    const close = prev !== null && samePage && prev.y - line.y > 0 && prev.y - line.y <= leading(line.size) * 1.35 + 0.5;
    const sameSize = block !== undefined && Math.abs(block.size - line.size) < 0.5;
    // Across a page break: the last block didn't end its sentence, and the next page starts in its size.
    const carriesOn = prev !== null && !samePage && sameSize && block?.kind !== "heading" && !SENTENCE_END.test(lastText(block!));
    const continues = (close || carriesOn) && sameSize;
    const heading = headingSizes.includes(line.size);

    if (heading) {
      if (continues && block?.kind === "heading" && block.lines < 3) {
        block.text = joinLines(block.text, line.text);
        block.lines++;
      } else blocks.push({ kind: "heading", level: levelOf(line.size), size: line.size, text: line.text, lines: 1 });
      prev = line;
      continue;
    }
    const marker = BULLET.exec(line.text) ?? NUMBERED.exec(line.text);
    if (marker) {
      const ordered = !BULLET.test(line.text);
      const textX = line.x + (line.right - line.x) * (marker[1].length / Math.max(1, line.text.length)) + line.size * 0.3;
      const item: Item = { ordered, markerX: line.x, textX, text: marker[2], children: [] };
      if (block?.kind === "list" && (close || carriesOn) && sameSize) placeItem(block.items, item, line.size);
      else blocks.push({ kind: "list", size: line.size, items: [item] });
      prev = line;
      continue;
    }
    if (continues && block?.kind === "list") {
      const item = lastItem(block.items);
      // As far in as the item's text: the item goes on; back at the margin: a paragraph after the list.
      if (line.x >= item.textX - line.size * 0.6 || carriesOn) {
        item.text = joinLines(item.text, line.text);
        prev = line;
        continue;
      }
    }
    if (continues && block?.kind === "paragraph") {
      // A short line that ended a sentence ends its paragraph, as does a sentence's end followed by an indented line.
      const ended = prev !== null && SENTENCE_END.test(prev.text);
      const short = prev !== null && samePage && prev.right - prev.x < (block.right - block.x) * 0.75;
      const indented = line.x - block.x > line.size;
      if (!(ended && (short || indented))) {
        block.text = joinLines(block.text, line.text);
        block.right = Math.max(block.right, line.right);
        block.x = Math.min(block.x, line.x);
        prev = line;
        continue;
      }
    }
    blocks.push({ kind: "paragraph", size: line.size, text: line.text, x: line.x, right: line.right });
    prev = line;
  }
  return { html: blocks.map(blockHtml).join(""), chars };
}

function lastText(block: Block): string {
  if (block.kind !== "list") return block.text;
  return lastItem(block.items).text;
}

function lastItem(items: Item[]): Item {
  const last = items.at(-1)!;
  return last.children.length ? lastItem(last.children) : last;
}

/** Puts an item into a list: under the item above when it stands further in, else beside the items as far in. */
function placeItem(items: Item[], item: Item, size: number) {
  let level = items;
  for (;;) {
    const last = level.at(-1);
    if (!last || item.markerX <= last.markerX + size * 0.8) break;
    if (!last.children.length) {
      last.children.push(item);
      return;
    }
    level = last.children;
  }
  level.push(item);
}

function itemsHtml(items: Item[]): string {
  let html = "";
  let open: boolean | null = null;
  for (const item of items) {
    if (open !== item.ordered) {
      if (open !== null) html += open ? "</ol>" : "</ul>";
      html += item.ordered ? "<ol>" : "<ul>";
      open = item.ordered;
    }
    html += `<li><p>${escape(item.text)}</p>${item.children.length ? itemsHtml(item.children) : ""}</li>`;
  }
  if (open !== null) html += open ? "</ol>" : "</ul>";
  return html;
}

function blockHtml(block: Block): string {
  if (block.kind === "list") return itemsHtml(block.items);
  if (block.kind === "heading") {
    // Too long for a heading after all (a large lead paragraph): a paragraph.
    if (block.text.length > HEADING_CHARS) return `<p>${escape(block.text)}</p>`;
    return `<h${block.level}>${escape(block.text)}</h${block.level}>`;
  }
  return `<p>${escape(block.text)}</p>`;
}
