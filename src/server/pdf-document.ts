import { cleanCodeCaption } from "@/lib/code-caption";
import { builtinIconSvg } from "@/lib/builtin-icon-svg";
import type { Alignment, Column, Content, ContentImage, ContentTable, ContentText, TableCell, TableLayout, TDocumentDefinitions } from "pdfmake/interfaces";
import { CALLOUT_BLOCK, MATH_BLOCK, MERMAID_BLOCK, BREADCRUMB_BLOCK, FOOTNOTE, INLINE_MATH, SUBPAGES_BLOCK, TOC_BLOCK } from "@/lib/content-blocks";
import { plainText, type MdBlock } from "@/lib/content-markdown";
import { COLUMN_BLOCK, COLUMN_LIST_BLOCK, columnWidth } from "@/lib/columns";
import { commentText } from "@/lib/comments";
import { isEmbedBlockType } from "@/lib/embed-blocks";
import type { ExportedThread } from "@/lib/export-comments";
import { cropSvg, parseImageCrop } from "@/lib/image-crop";
import { listStyleAt } from "@/lib/list-markers";
import { SUBSCRIPT, SUPERSCRIPT } from "@/lib/text-scripts";
import { BOOKMARK_BLOCK, WEB_EMBED_BLOCK } from "@/lib/web-blocks";
import { tint, type LogoPlace } from "@/lib/letterheads";
import type { PdfTheme, ThemeValues } from "@/lib/pdf-themes";
import { elements, themeColor, themeContent, themePalette, type ThemePalette } from "@/server/pdf-theme-layout";

/**
 * A page as a PDF file's layout (pdfmake's document definition), drawn by server/pdf.ts. Pure: the
 * caller reads the page as the reader may see it (print rules, see server/print.ts) and passes the
 * blocks, the database tables and the images already loaded; nothing here reads a URL or a file.
 *
 * Paper in the light theme's colors (globals.css), in Roboto, which covers Latin, Greek and
 * Cyrillic scripts (not Arabic, Hebrew or CJK text, which prints as blanks). A letterhead
 * (lib/letterheads) puts its logo and lines at the top of every page and its lines and page
 * numbers at the foot; its accent colors the rules and table headers, never text.
 */

/** `align`: per column, values (and the column's name) centered or at the right; at the left when missing. */
export type PdfTable = { header: string[]; rows: string[][]; align?: (Alignment | undefined)[] };
/** `title` null: a linked view shown without the database's name. */
export type PdfEmbed = { title: string | null; table: PdfTable };

export type PdfSection = {
  title: string;
  /** The page's icon: a built-in one is drawn before the title; an emoji isn't (the PDF's fonts have none). */
  icon?: string | null;
  /** The body, after printableBlocks (server/published-body.ts). */
  blocks: MdBlock[];
  /** A row's values, when asked for, as text. */
  properties: { name: string; value: string }[];
  /** A database page's rows, as its default view shows them. */
  database: PdfTable | null;
  /** The databases the body's database blocks show, by block id; missing when the reader can't see one. */
  embeds: Map<string, PdfEmbed>;
  /** Titles from the top of the workspace down to the page (breadcrumb blocks), and of its subpages (subpage blocks). */
  crumbs: string[];
  children: string[];
  /** The comment threads to print after the body (lib/export-comments), when asked for. */
  comments?: { heading: string; resolved: string; threads: ExportedThread[] } | null;
};

/** A theme as the layout draws it (lib/pdf-themes): its logo already read, as a data URL, and what its placeholders stand for. */
export type PdfThemeInput = { theme: PdfTheme; logo: string | null; values: Omit<ThemeValues, "page" | "pages"> };

/** A letterhead as the layout draws it: the logo already read, as a data URL. */
export type PdfLetterhead = { logo: string | null; logoPlace: LogoPlace; header: string; footer: string; accent: string; pageNumbers: boolean; theme?: PdfTheme | null };

export type PdfInput = {
  title: string;
  sections: PdfSection[];
  /** Images the body shows, as data URLs by their url in the block; others print as their name. */
  images: Map<string, string>;
  /** A URL as a link from the file (site paths of uploads made absolute). */
  link: (url: string) => string;
  labels: { untitled: string; unavailable: string };
  /** What every page prints around the body; without one, page numbers when there are several pages. */
  letterhead?: PdfLetterhead | null;
  /** How the paper looks and what prints around the body; takes the letterhead's place. */
  theme?: PdfThemeInput | null;
  /** How big the body's text is, 1 as it is (lib/pdf-text-scale); the letterhead keeps its size. */
  textScale?: number;
  /** The font Chinese, Japanese and Korean text is set in (pdf.ts cjkFont), which Roboto has no letters for; null leaves it in Roboto. */
  cjkFont?: string | null;
};

/** Han, kana, Hangul, CJK punctuation and full-width forms: what Roboto can't draw and the CJK font can. */
const CJK_TEXT = /([\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3134f}]+)/u;

/** `value` cut into runs, the CJK ones in `font`; the string itself when it has none. */
function cjkRuns(value: string, font: string): string | ContentText[] {
  if (!CJK_TEXT.test(value)) return value;
  return value
    .split(CJK_TEXT)
    .filter(Boolean)
    .map((part) => (CJK_TEXT.test(part) ? { text: part, font } : { text: part }));
}

/** `content` with its Chinese, Japanese and Korean text set in `font` (other text, images and data left as they are). */
export function withCjkFont<T>(content: T, font: string | null | undefined): T {
  if (!font) return content;
  const walk = (node: unknown, inArray: boolean): unknown => {
    if (typeof node === "string") {
      if (!inArray) return node;
      const runs = cjkRuns(node, font);
      return typeof runs === "string" ? runs : { text: runs };
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, true));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "text" && typeof v === "string" ? cjkRuns(v, font) : k === "image" || k === "svg" || k === "qr" || k === "link" ? v : walk(v, false);
    }
    return out;
  };
  return walk(content, false) as T;
}

/** `content` with every font size in it times `factor` (images and other data left as they are). */
function scaleFonts<T>(content: T, factor: number): T {
  if (factor === 1) return content;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "fontSize" && typeof v === "number" ? Math.round(v * factor * 10) / 10 : walk(v);
    return out;
  };
  return walk(content) as T;
}

// Light theme (globals.css): text, muted and faint text, borders, subtle fill, links.
const FG = "#1f2023";
const TEXT = "#1f2023";
const MUTED = "#6b6d75";
const FAINT = "#9a9ca3";
const BORDER = "#e4e4e7";
const SUBTLE = "#f7f7f8";
const LINK = "#2f7d4f";

/** The editor's block colors in the light theme (globals.css `--bn-colors-highlights-*`). */
const COLORS: Record<string, { text: string; background: string }> = {
  gray: { text: "#5c6e61", background: "#ebf0ed" },
  brown: { text: "#935839", background: "#faebe4" },
  orange: { text: "#9c5301", background: "#ffeadb" },
  yellow: { text: "#7f6606", background: "#f6eed8" },
  green: { text: "#187d42", background: "#e2f4e6" },
  blue: { text: "#0b6fa7", background: "#e0f1ff" },
  purple: { text: "#7955a0", background: "#f2ebfd" },
  pink: { text: "#9d4673", background: "#fee7f1" },
  red: { text: "#ac3f42", background: "#ffe9e7" },
};

/** A4 less the margins, in points: the widest an image or a column can be. */
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = 595.28 - 2 * PAGE_MARGIN;
const MAX_IMAGE_HEIGHT = 360;
const HEADING_SIZES: Record<number, number> = { 1: 18, 2: 15, 3: 13 };
/** A letterhead's top: where it starts, its logo's box, its lines (the first larger) and the room under its rule. */
const HEAD_TOP = 28;
const LOGO_HEIGHT = 40;
const LOGO_WIDTH = 160;
const HEAD_FIRST_LINE = 13;
const HEAD_LINE = 11.1;
const HEAD_BELOW = 24;
const FOOT_TOP = 16;
const FOOT_LINE = 10.4;
const INDENT = 16;

type Inline = { type?: string; text?: string; content?: unknown; styles?: Record<string, unknown>; href?: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const prop = (block: MdBlock, key: string) => block.props?.[key];
const str = (value: unknown) => (typeof value === "string" ? value : "");

const textColor = (name: unknown) => (typeof name === "string" ? COLORS[name]?.text : undefined);
const backgroundColor = (name: unknown) => (typeof name === "string" ? COLORS[name]?.background : undefined);

function alignment(value: unknown): Alignment | undefined {
  return value === "center" || value === "right" || value === "justify" ? value : undefined;
}

/** What one section's blocks collect on the way: its footnotes, numbered in order. */
type Walk = { input: PdfInput; section: PdfSection; notes: string[] };

/** Inline content as pdfmake text runs: styles, colors, links, footnote numbers. */
function inline(content: unknown, walk: Walk, inherited: Partial<ContentText> = {}): ContentText[] {
  if (typeof content === "string") return content ? [{ ...inherited, text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): ContentText[] => {
    if (Array.isArray(item)) return inline(item, walk, inherited);
    if (!isObject(item)) return [];
    const node = item as Inline;
    if (node.type === "link") {
      const href = str(node.href);
      return inline(node.content, walk, { ...inherited, link: href, color: LINK, decoration: "underline" });
    }
    if (node.type === FOOTNOTE) {
      walk.notes.push(plainText(node.content));
      return [{ ...inherited, text: String(walk.notes.length), sup: true, color: LINK }];
    }
    if (node.type === INLINE_MATH) return [{ ...inherited, text: plainText(node.content), italics: true }];
    if (typeof node.text === "string") {
      if (!node.text) return [];
      const styles = node.styles ?? {};
      const run: ContentText = { ...inherited, text: node.text };
      if (styles.bold) run.bold = true;
      if (styles.italic) run.italics = true;
      if (styles.underline) run.decoration = "underline";
      else if (styles.strike) run.decoration = "lineThrough";
      if (styles[SUPERSCRIPT]) run.sup = true;
      if (styles[SUBSCRIPT]) run.sub = true;
      if (styles.code) run.background = SUBTLE;
      const color = textColor(styles.textColor);
      if (color) run.color = color;
      const background = backgroundColor(styles.backgroundColor);
      if (background) run.background = background;
      return [run];
    }
    // Inline nodes of other kinds read as their text.
    return inline(node.content, walk, inherited);
  });
}

/** A block's own text (not its children's) as a paragraph, in its color and alignment. */
function paragraph(block: MdBlock, walk: Walk, style: Partial<ContentText> = {}): ContentText {
  const runs = inline(block.content, walk);
  const color = textColor(prop(block, "textColor"));
  const background = backgroundColor(prop(block, "backgroundColor"));
  const out: ContentText = { text: runs.length ? runs : " ", ...style };
  if (color) out.color = color;
  if (background) out.background = background;
  const align = alignment(prop(block, "textAlignment"));
  if (align) out.alignment = align;
  return out;
}

/** Nested blocks, indented under their parent. */
function nested(block: MdBlock, walk: Walk, width: number): Content[] {
  if (!block.children?.length) return [];
  return [{ stack: blocksContent(block.children, walk, width - INDENT), margin: [INDENT, 2, 0, 0] }];
}

/** A small box, ticked or not, for checklist items. */
function checkbox(checked: boolean): Column {
  const box = { type: "rect" as const, x: 0, y: 2, w: 8, h: 8, r: 1.5, lineColor: checked ? LINK : FAINT, lineWidth: 0.8 };
  if (!checked) return { canvas: [box], width: 12 };
  return {
    canvas: [
      { ...box, color: LINK },
      { type: "polyline", lineWidth: 1.2, lineColor: "#ffffff", points: [{ x: 2, y: 6 }, { x: 3.6, y: 7.8 }, { x: 6.2, y: 4.2 }] },
    ],
    width: 12,
  };
}

/** One list item: its text and what is nested in it. */
function listItem(block: MdBlock, walk: Walk, width: number, depth: number): Content {
  const children = block.children?.length ? blocksContent(block.children, walk, width - INDENT, block.type === "numberedListItem" ? depth + 1 : depth) : [];
  const text = paragraph(block, walk);
  return children.length ? { stack: [text, ...children] } : text;
}

const LIST_TYPES = new Set(["bulletListItem", "numberedListItem"]);

/**
 * Blocks as content, consecutive list items of a kind as one list. `depth` is how many numbered
 * lists they are nested in, which picks how a numbered list counts (lib/list-markers).
 */
function blocksContent(blocks: MdBlock[], walk: Walk, width = CONTENT_WIDTH, depth = 0): Content[] {
  const out: Content[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (LIST_TYPES.has(block.type)) {
      const items: MdBlock[] = [];
      while (i < blocks.length && blocks[i].type === block.type) items.push(blocks[i++]);
      i--;
      const list = items.map((item) => listItem(item, walk, width, depth));
      if (block.type === "bulletListItem") out.push({ ul: list, margin: [0, 0, 0, 6], markerColor: MUTED });
      else {
        const start = Number(prop(block, "start"));
        const style = listStyleAt(depth);
        out.push({
          ol: list,
          margin: [0, 0, 0, 6],
          ...(style !== "decimal" ? { type: style } : {}),
          ...(Number.isInteger(start) && start > 1 ? { start } : {}),
        });
      }
      continue;
    }
    out.push(...blockContent(block, walk, width));
  }
  return out;
}

function blockContent(block: MdBlock, walk: Walk, width: number): Content[] {
  const { section, input } = walk;
  switch (block.type) {
    case "paragraph":
      return [{ ...paragraph(block, walk), margin: [0, 0, 0, 6] }, ...nested(block, walk, width)];
    case "heading": {
      const level = Number(prop(block, "level")) || 1;
      const headings = input.theme?.theme.headings;
      const size = headings?.sizes?.[level - 1] ?? HEADING_SIZES[level] ?? 11.5;
      const color = headings?.color ? themeColor(headings.color, paletteOf(input), FG) : undefined;
      const heading = paragraph(block, walk, { fontSize: size, bold: true, margin: [0, level === 1 ? 10 : 8, 0, 4], ...(color ? { color } : {}) });
      if (headings?.caps) heading.text = upper(heading.text, input.theme?.values.locale);
      // Headings stay with what follows them.
      return [{ ...heading, headlineLevel: level }, ...nested(block, walk, width)];
    }
    case "checkListItem":
      return [
        { columns: [checkbox(prop(block, "checked") === true), { ...paragraph(block, walk), width: "*" }], columnGap: 4, margin: [0, 0, 0, 3] },
        ...nested(block, walk, width),
      ];
    case "toggleListItem":
      return [{ ...paragraph(block, walk), margin: [0, 0, 0, 4] }, ...nested(block, walk, width)];
    case "quote": {
      // A large quote (lib/quote-block) in bigger text; what is nested in it in the usual size.
      const text = prop(block, "size") === "large" ? { ...paragraph(block, walk), fontSize: 14, lineHeight: 1.25 } : paragraph(block, walk);
      return [boxed([text, ...nested(block, walk, width - 12)], { edge: BORDER })];
    }
    case "codeBlock":
    case MERMAID_BLOCK: {
      const code = boxed([{ text: plainText(block.content) || " ", fontSize: 9, preserveLeadingSpaces: true, lineHeight: 1.2 }], { fill: SUBTLE });
      // A code block's caption (lib/code-block) under it.
      const caption = cleanCodeCaption(str(prop(block, "caption")));
      return caption ? [{ stack: [code, ...captionLine(caption)], margin: [0, 0, 0, 6] }] : [code];
    }
    case MATH_BLOCK:
      return [{ text: plainText(block.content), italics: true, alignment: "center", margin: [0, 4, 0, 8] }];
    case CALLOUT_BLOCK: {
      const title = str(prop(block, "title"));
      const fill = backgroundColor(prop(block, "backgroundColor"));
      // A built-in icon is drawn before the text; an emoji isn't (the PDF's fonts have none).
      const icon = builtinIconSvg(str(prop(block, "icon")), { size: 11, fallbackColor: TEXT });
      const text = paragraph(block, walk);
      const body: Content[] = [
        ...(title ? [{ text: title, bold: true, margin: [0, 0, 0, 2] } as Content] : []),
        icon ? { columns: [{ svg: icon, width: 11, margin: [0, 1, 0, 0] }, { ...text, width: "*" }], columnGap: 6 } : text,
        ...(block.children?.length ? blocksContent(block.children, walk, width - 20) : []),
      ];
      return [boxed(body, fill ? { fill } : { edge: BORDER, frame: true })];
    }
    case "table":
      return [table(block, walk)];
    case "divider":
      return [{ table: { widths: ["*"], body: [[{ text: "", margin: [0, 0, 0, 0] }]] }, layout: lineAbove, margin: [0, 6, 0, 6] }];
    case "image": {
      const url = str(prop(block, "url"));
      const data = input.images.get(url);
      const caption = str(prop(block, "caption"));
      const preview = Number(prop(block, "previewWidth"));
      const fitWidth = Math.min(width, Number.isFinite(preview) && preview > 0 ? preview * 0.75 : width);
      const align = alignment(prop(block, "textAlignment"));
      // A cropped image is drawn as an SVG that shows only its part (lib/image-crop).
      const crop = data ? parseImageCrop(prop(block, "crop")) : null;
      const shown: Content = data
        ? {
            ...(crop ? { svg: cropSvg(crop, data) } : { image: data }),
            fit: [fitWidth, MAX_IMAGE_HEIGHT],
            ...(align ? { alignment: align } : {}),
          }
        : fileLine(block, input);
      return [{ stack: [shown, ...captionLine(caption, align)], margin: [0, 2, 0, 8], unbreakable: true }];
    }
    case "file":
    case "video":
    case "audio": {
      // Aligned as on the page (lib/media-placement): justify is for text.
      const align = alignment(prop(block, "textAlignment"));
      const placed = align === "justify" ? undefined : align;
      return [{ stack: [fileLine(block, input), ...captionLine(str(prop(block, "caption")), placed)], margin: [0, 0, 0, 6], ...(placed ? { alignment: placed } : {}) }];
    }
    case BOOKMARK_BLOCK:
    case WEB_EMBED_BLOCK: {
      const url = str(prop(block, "url"));
      const align = alignment(prop(block, "textAlignment"));
      const placed = align === "justify" ? undefined : align;
      return url ? [{ text: url, link: url, color: LINK, decoration: "underline", margin: [0, 0, 0, 6], ...(placed ? { alignment: placed } : {}) }] : [];
    }
    case COLUMN_LIST_BLOCK: {
      const columns = (block.children ?? []).filter((c) => c.type === COLUMN_BLOCK);
      if (!columns.length) return [];
      const shares = columns.map((c) => columnWidth(prop(c, "width")));
      const total = shares.reduce((a, b) => a + b, 0);
      const gap = 16;
      const usable = width - gap * (columns.length - 1);
      return [
        {
          columns: columns.map((c, i) => {
            const w = (usable * shares[i]) / total;
            return { width: w, stack: blocksContent(c.children ?? [], walk, w) };
          }),
          columnGap: gap,
          margin: [0, 0, 0, 6],
        },
      ];
    }
    case TOC_BLOCK: {
      const headings = collectHeadings(section.blocks);
      if (!headings.length) return [];
      return [{ stack: headings.map((h) => ({ text: h.text, color: MUTED, margin: [(h.level - 1) * INDENT, 0, 0, 2] })), margin: [0, 0, 0, 8] }];
    }
    case BREADCRUMB_BLOCK:
      return section.crumbs.length ? [{ text: section.crumbs.join(" / "), color: MUTED, fontSize: 9, margin: [0, 0, 0, 6] }] : [];
    case SUBPAGES_BLOCK:
      return section.children.length ? [{ ul: section.children.map((title) => title || input.labels.untitled), margin: [0, 0, 0, 6] }] : [];
    default: {
      if (isEmbedBlockType(block.type)) {
        const embed = block.id ? section.embeds.get(block.id) : undefined;
        if (!embed) return [{ text: input.labels.unavailable, italics: true, color: FAINT, margin: [0, 0, 0, 6] }];
        return [
          ...(embed.title === null ? [] : [{ text: embed.title || input.labels.untitled, bold: true, margin: [0, 4, 0, 4] } as Content]),
          { ...dataTable(embed.table, input), margin: [0, 0, 0, 8] },
        ];
      }
      // A block of another kind: its text if it has any (as an agent chat block has none), and what is nested in it.
      const text = Array.isArray(block.content) ? [{ ...paragraph(block, walk), margin: [0, 0, 0, 6] } as Content] : [];
      return [...text, ...nested(block, walk, width)];
    }
  }
}

function collectHeadings(blocks: MdBlock[], out: { level: number; text: string }[] = []) {
  for (const block of blocks) {
    if (block.type === "heading") out.push({ level: Math.min(3, Number(prop(block, "level")) || 1), text: plainText(block.content) });
    if (block.children?.length) collectHeadings(block.children, out);
  }
  return out;
}

/** A file block as its name, linking to the file. */
function fileLine(block: MdBlock, input: PdfInput): Content {
  const url = str(prop(block, "url"));
  const name = str(prop(block, "name")) || url;
  if (!name) return { text: "" };
  return url ? { text: name, link: input.link(url), color: LINK, decoration: "underline" } : { text: name };
}

function captionLine(caption: string, align?: Alignment): Content[] {
  return caption ? [{ text: caption, fontSize: 9, color: MUTED, margin: [0, 3, 0, 0], ...(align ? { alignment: align } : {}) }] : [];
}

const lineAbove = {
  hLineWidth: (i: number) => (i === 0 ? 0.6 : 0),
  vLineWidth: () => 0,
  hLineColor: () => BORDER,
  paddingLeft: () => 0,
  paddingRight: () => 0,
  paddingTop: () => 0,
  paddingBottom: () => 0,
};

/** Content in a box: filled, framed, or with a line at its left edge (quotes). */
function boxed(stack: Content[], { fill, edge, frame }: { fill?: string; edge?: string; frame?: boolean }): Content {
  return {
    table: { widths: ["*"], body: [[{ stack, ...(fill ? { fillColor: fill } : {}) }]] },
    layout: {
      hLineWidth: () => (frame ? 0.6 : 0),
      vLineWidth: (i: number) => (frame ? 0.6 : edge && i === 0 ? 2 : 0),
      hLineColor: () => edge ?? BORDER,
      vLineColor: () => edge ?? BORDER,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => (fill || frame ? 8 : 2),
      paddingBottom: () => (fill || frame ? 8 : 2),
    },
    margin: [0, 2, 0, 8],
  };
}

/** Text that reads as a number or an amount: digits with separators, signs, percent or a currency. */
export const AMOUNT = /^[-+(]?\s*(?:[^\d\s]{1,3}\s?)?\d[\d.,\s\u00a0\u202f']*(?:\s?(?:%|[^\d\s]{1,3}))?\)?$/u;

type Cell = { content: unknown; colspan: number; rowspan: number; props: Record<string, unknown> };

function cellOf(raw: unknown): Cell {
  if (isObject(raw) && raw.type === "tableCell") {
    const props = isObject(raw.props) ? raw.props : {};
    const span = (v: unknown) => Math.max(1, Math.min(50, Number(v) || 1));
    return { content: raw.content, colspan: span(props.colspan), rowspan: span(props.rowspan), props };
  }
  // The older form: a cell is its inline content.
  return { content: raw, colspan: 1, rowspan: 1, props: {} };
}

/** A table block, cells spanning rows and columns as in the editor; its header rows in bold, shaded. */
function table(block: MdBlock, walk: Walk): Content {
  const content = isObject(block.content) ? block.content : {};
  const rows = Array.isArray(content.rows) ? (content.rows as { cells?: unknown[] }[]) : [];
  const headerRows = Math.max(0, Math.min(rows.length, Number(content.headerRows) || 0));
  const headerCols = Math.max(0, Number(content.headerCols) || 0);
  // Lay the cells out on a grid, leaving the places spanned cells cover.
  const grid: (TableCell | undefined)[][] = rows.map(() => []);
  const texts: string[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const raw of row.cells ?? []) {
      while (grid[r][c] !== undefined) c++;
      const cell = cellOf(raw);
      const header = r < headerRows || c < headerCols;
      const runs = inline(cell.content, walk);
      const out: TableCell = { text: runs.length ? runs : " " };
      if (header) {
        out.bold = true;
        out.fillColor = headerFill(walk.input);
        const color = headerColor(walk.input);
        if (color) out.color = color;
      }
      const fill = backgroundColor(cell.props.backgroundColor);
      if (fill) out.fillColor = fill;
      const color = textColor(cell.props.textColor);
      if (color) out.color = color;
      const align = alignment(cell.props.textAlignment);
      if (align) out.alignment = align;
      if (cell.colspan > 1) out.colSpan = cell.colspan;
      if (cell.rowspan > 1) out.rowSpan = Math.min(cell.rowspan, rows.length - r);
      grid[r][c] = out;
      texts[r][c] = plainText(cell.content);
      for (let dr = 0; dr < (out.rowSpan ?? 1); dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) if (dr || dc) grid[r + dr][c + dc] = {};
      }
      c += cell.colspan;
    }
  });
  const columns = Math.max(1, ...grid.map((row) => row.length));
  const body = grid.map((row) => Array.from({ length: columns }, (_, c) => row[c] ?? { text: " " }));
  // Columns of amounts line up on the right (Markdown tables lose their alignment on the way in).
  for (let c = 0; c < columns; c++) {
    const values = texts.slice(headerRows).flatMap((row) => (row[c]?.trim() ? [row[c].trim()] : []));
    if (!values.length || !values.every((v) => AMOUNT.test(v))) continue;
    for (const row of body) if (row[c] && "text" in row[c] && !(row[c] as ContentText).alignment) (row[c] as ContentText).alignment = "right";
  }
  const size = walk.input.theme?.theme.tables?.size;
  return {
    table: { headerRows, widths: widthsOf(content.columnWidths, texts, columns), body, dontBreakRows: true },
    layout: tableLayout(walk.input, headerRows),
    margin: [0, 2, 0, 8],
    ...(size ? { fontSize: size } : {}),
  };
}

/**
 * Column widths: the editor's own when every column has one (shrunk to fit the page), else sized
 * to the content, the column with the longest text taking the room left so the table fits.
 */
function widthsOf(given: unknown, texts: string[][], columns: number): (number | "auto" | "*")[] {
  const set = Array.isArray(given) && given.length === columns && given.every((w) => typeof w === "number" && w > 0) ? (given as number[]) : null;
  if (set) {
    const total = set.reduce((a, b) => a + b, 0);
    const scale = Math.min(1, (CONTENT_WIDTH - columns * 12) / total);
    return set.map((w) => Math.floor(w * scale));
  }
  const longest = Array.from({ length: columns }, (_, c) => Math.max(0, ...texts.map((row) => (row[c] ?? "").length)));
  const widest = longest.indexOf(Math.max(...longest));
  return longest.map((_, c) => (c === widest ? "*" : "auto"));
}

/** The theme's colors, or the light theme's without one. */
function paletteOf(input: PdfInput): ThemePalette {
  return input.theme ? themePalette(input.theme.theme) : { accent: input.letterhead?.accent || BORDER, text: FG, muted: MUTED, border: BORDER, fill: SUBTLE };
}

/** Text runs (or a string) in upper case. */
function upper(text: ContentText["text"], locale?: string): ContentText["text"] {
  if (typeof text === "string") return text.toLocaleUpperCase(locale);
  if (Array.isArray(text)) return text.map((run) => (typeof run === "string" ? run.toLocaleUpperCase(locale) : isObject(run) ? { ...(run as ContentText), text: upper((run as ContentText).text, locale) } : run)) as ContentText["text"];
  return text;
}

/** A table's lines and fills: a grid in the border color, or as the theme draws tables (lines between rows only, stripes). */
function tableLayout(input: PdfInput, headerRows: number): TableLayout {
  const tables = input.theme?.theme.tables;
  const palette = paletteOf(input);
  const lines = tables?.lines ?? "grid";
  const stripes = tables?.stripes ? themeColor(tables.stripes, palette, SUBTLE) : null;
  return {
    hLineWidth: () => (lines === "none" ? 0 : 0.6),
    vLineWidth: () => (lines === "grid" ? 0.6 : 0),
    hLineColor: () => palette.border,
    vLineColor: () => palette.border,
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => (input.theme ? 5 : 4),
    paddingBottom: () => (input.theme ? 5 : 4),
    ...(stripes ? { fillColor: (row: number) => (row >= headerRows && (row - headerRows) % 2 === 1 ? stripes : null) } : {}),
  };
}

/** A table header's fill: the theme's, a light tint of the letterhead's accent, or the usual gray. */
function headerFill(input: PdfInput): string {
  const fill = input.theme?.theme.tables?.header_fill;
  if (fill) return themeColor(fill, paletteOf(input), SUBTLE);
  if (input.theme) return tint(paletteOf(input).accent, 0.86);
  return input.letterhead?.accent ? tint(input.letterhead.accent, 0.86) : SUBTLE;
}

/** A table header's text color: the theme's, else the body's. */
function headerColor(input: PdfInput): string | undefined {
  const color = input.theme?.theme.tables?.header_color;
  return color ? themeColor(color, paletteOf(input), FG) : undefined;
}

/** A database's rows as a table, its header shaded. */
function dataTable(data: PdfTable, input: PdfInput): ContentTable {
  const columns = data.header.length;
  const aligned = (c: number) => (data.align?.[c] ? { alignment: data.align[c] } : {});
  const body: TableCell[][] = [
    data.header.map((name, c) => ({
      text: name,
      bold: true,
      fillColor: headerFill(input),
      ...(headerColor(input) ? { color: headerColor(input) } : {}),
      ...aligned(c),
    })),
    ...data.rows.map((row) => Array.from({ length: columns }, (_, c) => ({ text: row[c] || " ", ...aligned(c) }))),
  ];
  const texts = [data.header, ...data.rows];
  return { table: { headerRows: 1, widths: widthsOf(null, texts, columns), body, dontBreakRows: true }, layout: tableLayout(input, 1), fontSize: input.theme?.theme.tables?.size ?? 9 };
}

function sectionContent(section: PdfSection, index: number, input: PdfInput): Content[] {
  const walk: Walk = { input, section, notes: [] };
  const title = section.title.trim() || input.labels.untitled;
  // A body that starts with the title as a heading doesn't print it twice.
  const first = section.blocks[0];
  const blocks =
    first?.type === "heading" && plainText(first.content).trim().toLowerCase() === title.toLowerCase() ? section.blocks.slice(1) : section.blocks;
  const heading: Content = { text: title, fontSize: 22, bold: true };
  const icon = builtinIconSvg(section.icon, { size: 22, fallbackColor: TEXT });
  const titled = input.theme?.theme.title !== false;
  const out: Content[] = titled
    ? [
        {
          ...(icon ? { columns: [{ svg: icon, width: 22, margin: [0, 3, 0, 0] }, { ...heading, width: "*" }], columnGap: 10 } : heading),
          margin: [0, 0, 0, 12],
          ...(index > 0 ? { pageBreak: "before" as const } : {}),
        } as Content,
      ]
    : index > 0
      ? [{ text: "", pageBreak: "before" }]
      : [];
  if (section.properties.length) {
    out.push({
      table: { widths: ["auto", "*"], body: section.properties.map((p) => [{ text: p.name, color: MUTED }, { text: p.value || " " }]) },
      layout: "noBorders",
      margin: [0, 0, 0, 12],
    });
  }
  out.push(...blocksContent(blocks, walk));
  if (section.database) out.push({ ...dataTable(section.database, input), margin: [0, 4, 0, 8] });
  if (walk.notes.length) {
    out.push({
      stack: walk.notes.map((note, i) => ({ text: [{ text: `${i + 1}. `, color: MUTED }, note], fontSize: 9, margin: [0, 0, 0, 2] })),
      margin: [0, 12, 0, 0],
    });
  }
  if (section.comments?.threads.length) out.push(commentsContent(section.comments));
  return out;
}

/**
 * The comment threads after the body, under a rule and a heading: each thread's subject (with
 * "Resolved" beside it when it is), then its comments, author and date over the text, set in from
 * the left with a thin line, as the comments panel shows them.
 */
function commentsContent({ heading, resolved, threads }: NonNullable<PdfSection["comments"]>): Content {
  const thread = (t: ExportedThread): Content => ({
    stack: [
      {
        text: [{ text: t.about, bold: true }, ...(t.resolved ? [{ text: `  ${resolved}`, color: MUTED, fontSize: 9 }] : [])],
        margin: [0, 0, 0, 4],
      },
      ...t.comments.map(
        (c): Content => ({
          table: {
            widths: ["*"],
            body: [
              [
                {
                  stack: [
                    { text: [{ text: c.author, bold: true }, ...(c.date ? [{ text: `  ${c.date}`, color: FAINT }] : [])], fontSize: 9 },
                    { text: commentText(c.body), margin: [0, 1, 0, 0] },
                  ],
                },
              ],
            ],
          },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 1.2 : 0),
            vLineColor: () => BORDER,
            paddingLeft: () => 8,
            paddingRight: () => 0,
            paddingTop: () => 1,
            paddingBottom: () => 1,
          },
          margin: [0, 0, 0, 6],
        }),
      ),
    ],
    margin: [0, 0, 0, 8],
    unbreakable: t.comments.length <= 3,
  });
  return {
    stack: [
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.6, lineColor: BORDER }], margin: [0, 0, 0, 10] },
      { text: heading, fontSize: HEADING_SIZES[2], bold: true, margin: [0, 0, 0, 8], headlineLevel: 2 },
      ...threads.map(thread),
    ],
    margin: [0, 16, 0, 0],
  };
}

const linesOf = (text: string) => (text ? text.split("\n") : []);

/** How tall a letterhead's top is, logo and lines; 0 when it prints nothing there. */
function headHeight(letterhead: PdfLetterhead): number {
  const lines = linesOf(letterhead.header).length;
  const text = lines ? HEAD_FIRST_LINE + (lines - 1) * HEAD_LINE : 0;
  const logo = letterhead.logo ? LOGO_HEIGHT : 0;
  return letterhead.logoPlace === "center" ? logo + (logo && text ? 6 : 0) + text : Math.max(logo, text);
}

/** A letterhead's top: the logo on its side and the lines on the other (both centered for "center"), a rule under them. */
function letterheadTop(letterhead: PdfLetterhead): Content | null {
  if (!headHeight(letterhead)) return null;
  const { logo, logoPlace } = letterhead;
  const lines = linesOf(letterhead.header).map((line, i): ContentText => (i === 0 ? { text: line, bold: true, fontSize: 10 } : { text: line, fontSize: 8.5, color: MUTED }));
  const image: ContentImage | null = logo ? { image: logo, fit: [LOGO_WIDTH, LOGO_HEIGHT] } : null;
  let top: Content;
  if (logoPlace === "center") top = { stack: [...(image ? [{ ...image, alignment: "center" as const, margin: [0, 0, 0, lines.length ? 6 : 0] as [number, number, number, number] }] : []), { stack: lines, alignment: "center" }] };
  else if (!image) top = { stack: lines };
  else {
    const text: Column = { stack: lines, width: "*", alignment: logoPlace === "left" ? "right" : "left" };
    const picture: Column = { stack: [{ ...image, alignment: logoPlace }], width: "auto" };
    top = { columns: logoPlace === "left" ? [picture, text] : [text, picture], columnGap: 16 };
  }
  const rule: Content = {
    canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: letterhead.accent ? 1.2 : 0.6, lineColor: letterhead.accent || BORDER }],
    margin: [0, 8, 0, 0],
  };
  return { stack: [top, rule], margin: [PAGE_MARGIN, HEAD_TOP, PAGE_MARGIN, 0] };
}

/** A letterhead's foot: its lines over a thin rule, and "n / total" on the right. */
function letterheadFoot(letterhead: PdfLetterhead, current: number, total: number): Content | null {
  const lines = linesOf(letterhead.footer);
  if (!lines.length && !letterhead.pageNumbers) return null;
  const number: Column[] = letterhead.pageNumbers ? [{ text: `${current} / ${total}`, width: "auto", alignment: "right", fontSize: 8, color: FAINT }] : [];
  const columns: Content = { columns: [{ stack: lines.map((line) => ({ text: line })), width: "*", fontSize: 8, color: MUTED }, ...number], columnGap: 12 };
  const rule: Content = { canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.6, lineColor: BORDER }], margin: [0, 0, 0, 6] };
  return { stack: lines.length ? [rule, columns] : [columns], margin: [PAGE_MARGIN, FOOT_TOP, PAGE_MARGIN, 0] };
}

/** The document definition of `input` on A4 in its theme: its margins, colors and text size, its elements around the body, its header and footer on every page. */
function themedDocument(input: PdfInput, { theme, logo, values }: PdfThemeInput): TDocumentDefinitions {
  const palette = themePalette(theme);
  const scale = input.textScale ?? 1;
  const fontSize = Math.round((theme.font_size ?? 10.5) * scale * 10) / 10;
  const m = theme.margins ?? {};
  const [left, top, right, bottom] = [m.left ?? PAGE_MARGIN, m.top ?? PAGE_MARGIN, m.right ?? PAGE_MARGIN, m.bottom ?? PAGE_MARGIN + 8];
  const layoutInput = (current?: number, total?: number, body: Content[] = []) => ({ palette, logo, fontSize, body, values: { ...values, page: current, pages: total } });
  const around = (list: PdfTheme["header"], current: number, total: number, margin: [number, number, number, number]): Content | null => {
    if (!list?.length) return null;
    const content = elements(list, layoutInput(current, total));
    return content.length ? withCjkFont({ stack: content, margin, fontSize: Math.max(6, fontSize - 2), color: palette.muted }, input.cjkFont) : null;
  };
  const body = scaleFonts(
    input.sections.flatMap((section, i) => sectionContent(section, i, input)),
    scale,
  );
  return {
    pageSize: "A4",
    pageMargins: [left, top, right, bottom],
    info: { title: input.title || input.labels.untitled, creator: "Leafdesk", producer: "Leafdesk" },
    defaultStyle: { font: "Roboto", fontSize, lineHeight: 1.3, color: palette.text },
    header: (current: number, total: number) =>
      current === 1 && theme.header_first_page === false ? null : around(theme.header, current, total, [left, Math.min(24, top / 2), right, 0]),
    footer: (current: number, total: number) => around(theme.footer, current, total, [left, Math.max(8, bottom / 2 - 14), right, 0]),
    content: withCjkFont(themeContent(theme, layoutInput(undefined, undefined, body)), input.cjkFont),
    pageBreakBefore: (node, pages) => typeof node.headlineLevel === "number" && pages.getFollowingNodesOnPage().length === 0,
  };
}

/** The document definition of `input` on A4: in its theme, in its letterhead, or with page numbers at the foot of every page when there are several. */
export function pdfDocument(input: PdfInput): TDocumentDefinitions {
  if (input.theme) return themedDocument(input, input.theme);
  const letterhead = input.letterhead ?? null;
  const head = letterhead ? headHeight(letterhead) : 0;
  const footLines = letterhead ? linesOf(letterhead.footer).length : 0;
  const top = head ? HEAD_TOP + head + 8 + HEAD_BELOW : PAGE_MARGIN;
  const bottom = footLines ? Math.max(PAGE_MARGIN + 8, FOOT_TOP + 6 + footLines * FOOT_LINE + 20) : PAGE_MARGIN + 8;
  const headContent = letterhead ? withCjkFont(letterheadTop(letterhead), input.cjkFont) : null;
  const scale = input.textScale ?? 1;
  return {
    pageSize: "A4",
    pageMargins: [PAGE_MARGIN, top, PAGE_MARGIN, bottom],
    info: { title: input.title || input.labels.untitled, creator: "Leafdesk", producer: "Leafdesk" },
    defaultStyle: { font: "Roboto", fontSize: Math.round(10.5 * scale * 10) / 10, lineHeight: 1.3, color: FG },
    ...(headContent ? { header: () => headContent } : {}),
    footer: (current: number, total: number) =>
      letterhead
        ? withCjkFont(letterheadFoot(letterhead, current, total), input.cjkFont)
        : total > 1
          ? { text: `${current} / ${total}`, alignment: "right", fontSize: 8, color: FAINT, margin: [PAGE_MARGIN, 16, PAGE_MARGIN, 0] }
          : null,
    content: withCjkFont(
      scaleFonts(
        input.sections.flatMap((section, i) => sectionContent(section, i, input)),
        scale,
      ),
      input.cjkFont,
    ),
    // A heading at the foot of a page moves to the next one, with what follows it.
    pageBreakBefore: (node, pages) => typeof node.headlineLevel === "number" && pages.getFollowingNodesOnPage().length === 0,
  };
}
