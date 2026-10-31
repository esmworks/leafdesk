import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  type ITableCellBorders,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { cleanCodeCaption } from "@/lib/code-caption";
import { CALLOUT_BLOCK, MATH_BLOCK, MERMAID_BLOCK, BREADCRUMB_BLOCK, FOOTNOTE, INLINE_MATH, SUBPAGES_BLOCK, TOC_BLOCK } from "@/lib/content-blocks";
import { plainText, type MdBlock } from "@/lib/content-markdown";
import { COLUMN_BLOCK, COLUMN_LIST_BLOCK, columnWidth } from "@/lib/columns";
import { commentText } from "@/lib/comments";
import { isEmbedBlockType } from "@/lib/embed-blocks";
import { iconText } from "@/lib/icon-value";
import { tint } from "@/lib/letterheads";
import { listStyleAt } from "@/lib/list-markers";
import { SUBSCRIPT, SUPERSCRIPT } from "@/lib/text-scripts";
import { BOOKMARK_BLOCK, WEB_EMBED_BLOCK } from "@/lib/web-blocks";
import { xmlSafe } from "@/lib/xlsx";
import { AMOUNT, type PdfInput, type PdfLetterhead, type PdfSection, type PdfTable } from "@/server/pdf-document";

/**
 * A page as a Word document (.docx), from what server/pdf.ts reads for its PDF: the same sections,
 * images already loaded and letterhead. Pure, like pdf-document.ts: nothing here reads a URL or a
 * file. The document is for someone to go on editing, so it is built from Word's own parts (heading
 * styles, numbered lists, tables, footnotes, a header and footer) rather than drawn: a letterhead's
 * logo and lines go in the header, its lines and page numbers in the footer; a letterhead's theme,
 * a PDF layout, isn't drawn (its plain logo, lines and accent are).
 *
 * Word's pitfalls, solved here once: every size in twips (1/20 pt) or half-points, page size and
 * margins given outright, list markers from numbering definitions (each numbered list counting from
 * 1 in its own instance), table and cell widths in DXA (percentages break in other editors),
 * shading `CLEAR` (`SOLID` paints black), line breaks as breaks, not "\n", and no control
 * characters (pasted text carries them; Word refuses a file with one).
 */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type DocxInput = Pick<PdfInput, "title" | "sections" | "images" | "link" | "labels" | "letterhead">;

// A4 and 2 cm margins, in twips; images are sized in pixels at 96 dpi (15 twips each).
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const TWIPS_PER_PX = 15;
const MAX_IMAGE_HEIGHT_PX = 480;
const LOGO_HEIGHT_PX = 53;
const LOGO_WIDTH_PX = 213;
const INDENT = 360;
const FONT = "Calibri";
const CODE_FONT = "Consolas";
/** Half-points. */
const BODY_SIZE = 21;
const SMALL_SIZE = 17;
const HEADING_SIZES = [36, 30, 26];

// The light theme's colors (pdf-document.ts), without the "#".
const FG = "1F2023";
const MUTED = "6B6D75";
const FAINT = "9A9CA3";
const BORDER = "E4E4E7";
const SUBTLE = "F7F7F8";
const LINK = "2F7D4F";

/** The editor's block colors in the light theme, as pdf-document.ts prints them. */
const COLORS: Record<string, { text: string; background: string }> = {
  gray: { text: "5C6E61", background: "EBF0ED" },
  brown: { text: "935839", background: "FAEBE4" },
  orange: { text: "9C5301", background: "FFEADB" },
  yellow: { text: "7F6606", background: "F6EED8" },
  green: { text: "187D42", background: "E2F4E6" },
  blue: { text: "0B6FA7", background: "E0F1FF" },
  purple: { text: "7955A0", background: "F2EBFD" },
  pink: { text: "9D4673", background: "FEE7F1" },
  red: { text: "AC3F42", background: "FFE9E7" },
};

type Inline = { type?: string; text?: string; content?: unknown; styles?: Record<string, unknown>; href?: string };
type RunStyle = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; superScript?: boolean; subScript?: boolean; color?: string; fill?: string; code?: boolean; size?: number };
type Block = Paragraph | Table;
type Align = (typeof AlignmentType)[keyof typeof AlignmentType];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const prop = (block: MdBlock, key: string) => block.props?.[key];
const str = (value: unknown) => (typeof value === "string" ? value : "");
const hex = (color: string) => color.replace(/^#/, "").toUpperCase();
const textColor = (name: unknown) => (typeof name === "string" ? COLORS[name]?.text : undefined);
const backgroundColor = (name: unknown) => (typeof name === "string" ? COLORS[name]?.background : undefined);
const shading = (fill: string) => ({ type: ShadingType.CLEAR, color: "auto", fill });
const line = (color: string, size = 4) => ({ style: BorderStyle.SINGLE, size, color, space: 1 });
const NO_LINE = { style: BorderStyle.NONE, size: 0, color: "auto" };
/** Tables that lay things out (a letterhead, columns, a box) keep their widths: Word would fit them to their text. */
const NO_BORDERS = { top: NO_LINE, bottom: NO_LINE, left: NO_LINE, right: NO_LINE, insideHorizontal: NO_LINE, insideVertical: NO_LINE };

function alignment(value: unknown): Align | undefined {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  return undefined;
}

/** What one section collects on the way: its footnotes (numbered across the document) and lists. */
type Walk = { input: DocxInput; section: PdfSection; notes: Map<number, string>; nextNote: { n: number }; lists: { n: number } };

/** Text runs of `text` in `style`, a line break for each "\n". */
function runs(text: string, style: RunStyle): TextRun[] {
  return xmlSafe(text).split("\n").map(
    (part, i) =>
      new TextRun({
        text: part,
        ...(i > 0 ? { break: 1 } : {}),
        ...(style.bold ? { bold: true } : {}),
        ...(style.italics ? { italics: true } : {}),
        ...(style.underline ? { underline: {} } : {}),
        ...(style.strike ? { strike: true } : {}),
        ...(style.superScript ? { superScript: true } : {}),
        ...(style.subScript ? { subScript: true } : {}),
        ...(style.color ? { color: style.color } : {}),
        ...(style.fill ? { shading: shading(style.fill) } : {}),
        ...(style.code ? { font: CODE_FONT } : {}),
        ...(style.size ? { size: style.size } : {}),
      }),
  );
}

/** Inline content as runs: styles, colors, links, footnotes (Word's own). */
function inline(content: unknown, walk: Walk, inherited: RunStyle = {}): ParagraphChild[] {
  if (typeof content === "string") return content ? runs(content, inherited) : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): ParagraphChild[] => {
    if (Array.isArray(item)) return inline(item, walk, inherited);
    if (!isObject(item)) return [];
    const node = item as Inline;
    if (node.type === "link") {
      const href = str(node.href);
      const children = inline(node.content, walk, { ...inherited, color: LINK, underline: true });
      return href ? [new ExternalHyperlink({ link: walk.input.link(xmlSafe(href)), children })] : children;
    }
    if (node.type === FOOTNOTE) {
      const id = walk.nextNote.n++;
      walk.notes.set(id, plainText(node.content));
      return [new FootnoteReferenceRun(id)];
    }
    if (node.type === INLINE_MATH) return runs(plainText(node.content), { ...inherited, italics: true });
    if (typeof node.text === "string") {
      if (!node.text) return [];
      const styles = node.styles ?? {};
      return runs(node.text, {
        ...inherited,
        ...(styles.bold ? { bold: true } : {}),
        ...(styles.italic ? { italics: true } : {}),
        ...(styles.underline ? { underline: true } : {}),
        ...(styles.strike ? { strike: true } : {}),
        ...(styles[SUPERSCRIPT] ? { superScript: true } : {}),
        ...(styles[SUBSCRIPT] ? { subScript: true } : {}),
        ...(styles.code ? { code: true, fill: SUBTLE } : {}),
        ...(textColor(styles.textColor) ? { color: textColor(styles.textColor) } : {}),
        ...(backgroundColor(styles.backgroundColor) ? { fill: backgroundColor(styles.backgroundColor) } : {}),
      });
    }
    // Inline nodes of other kinds read as their text.
    return inline(node.content, walk, inherited);
  });
}

type ParagraphOptions = ConstructorParameters<typeof Paragraph>[0] & object;

/** A block's own text (not its children's) as a paragraph, in its color and alignment. */
function paragraph(block: MdBlock, walk: Walk, options: Partial<Exclude<ParagraphOptions, string>> = {}, style: RunStyle = {}): Paragraph {
  const color = textColor(prop(block, "textColor"));
  const fill = backgroundColor(prop(block, "backgroundColor"));
  const align = alignment(prop(block, "textAlignment"));
  return new Paragraph({
    children: inline(block.content, walk, { ...style, ...(color ? { color } : {}) }),
    ...(fill ? { shading: shading(fill) } : {}),
    ...(align ? { alignment: align } : {}),
    ...options,
  });
}

const LIST_TYPES = new Set(["bulletListItem", "numberedListItem"]);

/**
 * Blocks as Word blocks, consecutive list items of a kind as one list. `level` is how deep in lists
 * they are (Word's numbering level), `indent` how far other blocks are set in.
 */
function blocksContent(blocks: MdBlock[], walk: Walk, width = CONTENT_WIDTH, level = 0, indent = 0): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (LIST_TYPES.has(block.type)) {
      const numbered = block.type === "numberedListItem";
      // Each numbered list counts from 1 in its own instance; bullets need none.
      const instance = numbered ? ++walk.lists.n : 0;
      while (i < blocks.length && blocks[i].type === block.type) {
        const item = blocks[i++];
        out.push(
          paragraph(item, walk, {
            // A numbered list counts 1, a, i by how deep it is, as the editor and the PDF count.
            numbering: { reference: numbered ? `number-${listStyleAt(level)}` : "bullet", level: Math.min(level, 8), instance },
            spacing: { after: 60 },
          }),
        );
        if (item.children?.length) out.push(...blocksContent(item.children, walk, width - INDENT, level + 1, indent + INDENT * 2));
      }
      i--;
      continue;
    }
    out.push(...blockContent(block, walk, width, level, indent));
  }
  return out;
}

/** Nested blocks, set in under their parent. */
function nested(block: MdBlock, walk: Walk, width: number, level: number, indent: number): Block[] {
  return block.children?.length ? blocksContent(block.children, walk, width - INDENT, level, indent + INDENT) : [];
}

function blockContent(block: MdBlock, walk: Walk, width: number, level: number, indent: number): Block[] {
  const { section, input } = walk;
  const set = indent ? { indent: { left: indent } } : {};
  switch (block.type) {
    case "paragraph":
      return [paragraph(block, walk, set), ...nested(block, walk, width, level, indent)];
    case "heading": {
      const n = Math.min(3, Math.max(1, Number(prop(block, "level")) || 1));
      return [paragraph(block, walk, { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][n - 1], ...set }), ...nested(block, walk, width, level, indent)];
    }
    case "checkListItem": {
      const checked = prop(block, "checked") === true;
      const color = textColor(prop(block, "textColor"));
      const box = new TextRun({ text: checked ? "☑ " : "☐ ", color: checked ? LINK : FAINT });
      return [new Paragraph({ children: [box, ...inline(block.content, walk, color ? { color } : {})], ...set, spacing: { after: 60 } }), ...nested(block, walk, width, level, indent)];
    }
    case "toggleListItem":
      return [paragraph(block, walk, set), ...nested(block, walk, width, level, indent)];
    case "quote": {
      const large = prop(block, "size") === "large";
      return [
        paragraph(block, walk, { indent: { left: indent + 240 }, border: { left: line(BORDER, 18) } }, large ? { size: 28 } : {}),
        ...nested(block, walk, width, level, indent + 240),
      ];
    }
    case "codeBlock":
    case MERMAID_BLOCK: {
      const lines = (plainText(block.content) || " ").split("\n");
      const code = lines.map(
        (text, i) =>
          new Paragraph({
            children: [new TextRun({ text: xmlSafe(text) || " ", font: CODE_FONT, size: 18 })],
            shading: shading(SUBTLE),
            spacing: { before: 0, after: i === lines.length - 1 ? 120 : 0, line: 240 },
            ...set,
          }),
      );
      // A code block's caption (lib/code-block) under it.
      const caption = cleanCodeCaption(str(prop(block, "caption")));
      return caption ? [...code, captionLine(caption)] : code;
    }
    case MATH_BLOCK:
      return [new Paragraph({ children: runs(plainText(block.content), { italics: true }), alignment: AlignmentType.CENTER })];
    case CALLOUT_BLOCK: {
      const title = str(prop(block, "title"));
      const fill = backgroundColor(prop(block, "backgroundColor"));
      // An emoji icon goes before the text; a built-in one is a drawing Word has no font for.
      const icon = iconText(str(prop(block, "icon")));
      const text = new Paragraph({ children: [...(icon ? runs(`${icon} `, {}) : []), ...inline(block.content, walk)] });
      // Inside the box's margins (boxed).
      const inner = width - indent - 2 * BOX_MARGIN;
      const body: Block[] = [
        ...(title ? [new Paragraph({ children: runs(title, { bold: true }), spacing: { after: 40 } })] : []),
        text,
        ...(block.children?.length ? blocksContent(block.children, walk, inner) : []),
      ];
      return [boxed(body, width - indent, fill ? { fill } : { frame: true }, indent), spacer()];
    }
    case "table":
      return [table(block, walk, width - indent, indent), spacer()];
    case "divider":
      return [new Paragraph({ border: { bottom: line(BORDER, 6) }, spacing: { after: 120 }, ...set })];
    case "image": {
      const url = str(prop(block, "url"));
      const data = input.images.get(url);
      const caption = str(prop(block, "caption"));
      const align = alignment(prop(block, "textAlignment"));
      const placed = align === AlignmentType.JUSTIFIED ? undefined : align;
      const image = data ? imageRun(data, block, width - indent) : null;
      const shown = image
        ? new Paragraph({ children: [image], ...(placed ? { alignment: placed } : {}), keepNext: !!caption, ...set })
        : fileLine(block, input, set);
      return caption ? [shown, captionLine(caption, placed, set)] : [shown];
    }
    case "file":
    case "video":
    case "audio": {
      const align = alignment(prop(block, "textAlignment"));
      const placed = align === AlignmentType.JUSTIFIED ? undefined : align;
      const caption = str(prop(block, "caption"));
      return [fileLine(block, input, { ...set, ...(placed ? { alignment: placed } : {}) }), ...(caption ? [captionLine(caption, placed, set)] : [])];
    }
    case BOOKMARK_BLOCK:
    case WEB_EMBED_BLOCK: {
      const url = str(prop(block, "url"));
      return url ? [new Paragraph({ children: [new ExternalHyperlink({ link: xmlSafe(url), children: runs(url, { color: LINK, underline: true }) })], ...set })] : [];
    }
    case COLUMN_LIST_BLOCK: {
      // Side by side in a table without lines, each column its share of the width.
      const columns = (block.children ?? []).filter((c) => c.type === COLUMN_BLOCK);
      if (!columns.length) return [];
      const shares = columns.map((c) => columnWidth(prop(c, "width")));
      const total = shares.reduce((a, b) => a + b, 0);
      const widths = fitWidths(shares.map((s) => (s / total) * (width - indent)), width - indent);
      const cells = columns.map((c, i) => {
        const margins = { left: i === 0 ? 0 : 160, right: i === columns.length - 1 ? 0 : 160 };
        return new TableCell({
          width: { size: widths[i], type: WidthType.DXA },
          margins,
          children: cellBlocks(blocksContent(c.children ?? [], walk, widths[i] - margins.left - margins.right)),
        });
      });
      return [
        new Table({
          rows: [new TableRow({ children: cells })],
          width: { size: width - indent, type: WidthType.DXA },
          columnWidths: widths,
          borders: NO_BORDERS,
          layout: TableLayoutType.FIXED,
          ...(indent ? { indent: { size: indent, type: WidthType.DXA } } : {}),
        }),
        spacer(),
      ];
    }
    case TOC_BLOCK: {
      const headings = collectHeadings(section.blocks);
      return headings.map((h) => new Paragraph({ children: runs(h.text, { color: MUTED }), indent: { left: indent + (h.level - 1) * INDENT }, spacing: { after: 40 } }));
    }
    case BREADCRUMB_BLOCK:
      return section.crumbs.length ? [new Paragraph({ children: runs(section.crumbs.join(" / "), { color: MUTED, size: SMALL_SIZE }), ...set })] : [];
    case SUBPAGES_BLOCK:
      return section.children.map((title) => new Paragraph({ children: runs(title || input.labels.untitled, {}), numbering: { reference: "bullet", level: Math.min(level, 8) } }));
    default: {
      if (isEmbedBlockType(block.type)) {
        const embed = block.id ? section.embeds.get(block.id) : undefined;
        if (!embed) return [new Paragraph({ children: runs(input.labels.unavailable, { italics: true, color: FAINT }), ...set })];
        return [
          ...(embed.title === null ? [] : [new Paragraph({ children: runs(embed.title || input.labels.untitled, { bold: true }), keepNext: true, ...set })]),
          dataTable(embed.table, input, width - indent, indent),
          spacer(),
        ];
      }
      // A block of another kind: its text if it has any (as an agent chat block has none), and what is nested in it.
      const text = Array.isArray(block.content) ? [paragraph(block, walk, set)] : [];
      return [...text, ...nested(block, walk, width, level, indent)];
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

/** An empty paragraph after a table: Word joins two tables that touch, and runs text into one. */
const spacer = () => new Paragraph({ spacing: { before: 0, after: 0 }, children: [] });

/** A file block as its name, linking to the file. */
function fileLine(block: MdBlock, input: DocxInput, options: Partial<Exclude<ParagraphOptions, string>> = {}): Paragraph {
  const url = str(prop(block, "url"));
  const name = str(prop(block, "name")) || url;
  const children = url ? [new ExternalHyperlink({ link: input.link(xmlSafe(url)), children: runs(name, { color: LINK, underline: true }) })] : runs(name, {});
  return new Paragraph({ children, ...options });
}

function captionLine(caption: string, align?: Align, options: Partial<Exclude<ParagraphOptions, string>> = {}): Paragraph {
  return new Paragraph({ children: runs(caption, { color: MUTED, size: SMALL_SIZE }), ...(align ? { alignment: align } : {}), ...options });
}

/** An image's bytes, kind and size in pixels from a data URL (PNG or JPEG, as pdf.ts loads them); null for anything else. */
export function imageData(dataUrl: string): { type: "png" | "jpg"; data: Buffer; width: number; height: number } | null {
  const match = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const data = Buffer.from(match[2], "base64");
  const size = imageSize(data);
  return size ? { type: match[1] === "png" ? "png" : "jpg", data, ...size } : null;
}

/** A PNG's or JPEG's size in pixels, read from its header. */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let p = 2;
    while (p + 9 < data.length) {
      if (data[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = data[p + 1];
      // Start-of-frame markers (C0–CF but C4, C8 and CC) hold the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = data.readUInt16BE(p + 5);
        const width = data.readUInt16BE(p + 7);
        return width && height ? { width, height } : null;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      p += 2 + data.readUInt16BE(p + 2);
    }
  }
  return null;
}

/** An image block as an image, as wide as on the page (its preview width) at most, within the page. */
function imageRun(dataUrl: string, block: MdBlock, width: number): ImageRun | null {
  const image = imageData(dataUrl);
  if (!image) return null;
  const preview = Number(prop(block, "previewWidth"));
  const maxWidth = Math.min(width / TWIPS_PER_PX, Number.isFinite(preview) && preview > 0 ? preview : Infinity);
  const scale = Math.min(1, maxWidth / image.width, MAX_IMAGE_HEIGHT_PX / image.height);
  const alt = xmlSafe(str(prop(block, "caption")) || str(prop(block, "name")));
  return new ImageRun({
    type: image.type,
    data: image.data,
    transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
    ...(alt ? { altText: { name: alt, description: alt, title: alt } } : {}),
  });
}

/** Widths in whole twips that add up to `total`. */
function fitWidths(widths: number[], total: number): number[] {
  const out = widths.map((w) => Math.max(1, Math.floor(w)));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** A table cell's blocks: Word wants a paragraph last in every cell. */
function cellBlocks(blocks: Block[]): Block[] {
  return blocks.length && blocks[blocks.length - 1] instanceof Paragraph ? blocks : [...blocks, new Paragraph({ children: [] })];
}

/** The space inside a box's edge, at either side. */
const BOX_MARGIN = 200;

/** Content in a box: filled, or framed in the border color. */
function boxed(blocks: Block[], width: number, { fill, frame }: { fill?: string; frame?: boolean }, indent = 0): Table {
  const edge = frame ? line(BORDER, 4) : NO_LINE;
  const borders: ITableCellBorders = { top: edge, bottom: edge, left: edge, right: edge };
  return new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: [width],
    borders: NO_BORDERS,
    layout: TableLayoutType.FIXED,
    ...(indent ? { indent: { size: indent, type: WidthType.DXA } } : {}),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: width, type: WidthType.DXA },
            margins: { top: 120, bottom: 120, left: BOX_MARGIN, right: BOX_MARGIN },
            borders,
            ...(fill ? { shading: shading(fill) } : {}),
            children: cellBlocks(blocks),
          }),
        ],
      }),
    ],
  });
}

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

/**
 * Column widths in twips adding up to `total`: the editor's own when every column has one (pixels,
 * scaled to fit), else in proportion to the longest text in each, none too narrow to read.
 */
export function tableWidths(given: unknown, texts: string[][], columns: number, total: number): number[] {
  const set = Array.isArray(given) && given.length === columns && given.every((w) => typeof w === "number" && w > 0) ? (given as number[]) : null;
  const weights = set ?? Array.from({ length: columns }, (_, c) => Math.min(40, Math.max(4, ...texts.map((row) => (row[c] ?? "").length))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const width = set ? Math.min(total, sum * TWIPS_PER_PX) : total;
  return fitWidths(
    weights.map((w) => (width * w) / sum),
    width,
  );
}

function borders(color = BORDER) {
  const edge = line(color, 4);
  return { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: edge, insideVertical: edge };
}

/** A table header's fill: a light tint of the letterhead's accent, or the usual gray. */
function headerFill(input: DocxInput): string {
  return input.letterhead?.accent ? hex(tint(input.letterhead.accent, 0.86)) : SUBTLE;
}

/** A table block, cells spanning rows and columns as in the editor; its header rows in bold, shaded and repeated on every page. */
function table(block: MdBlock, walk: Walk, width: number, indent: number): Table {
  const content = isObject(block.content) ? block.content : {};
  const rows = Array.isArray(content.rows) ? (content.rows as { cells?: unknown[] }[]) : [];
  const headerRows = Math.max(0, Math.min(rows.length, Number(content.headerRows) || 0));
  const headerCols = Math.max(0, Number(content.headerCols) || 0);
  // Where each cell sits on the grid (spanned places left out), for widths and amount columns.
  const taken: boolean[][] = rows.map(() => []);
  const placed: { row: number; column: number; cell: Cell }[] = [];
  const texts: string[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const raw of row.cells ?? []) {
      while (taken[r][c]) c++;
      const cell = cellOf(raw);
      const rowspan = Math.min(cell.rowspan, rows.length - r);
      placed.push({ row: r, column: c, cell: { ...cell, rowspan } });
      texts[r][c] = plainText(cell.content);
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < cell.colspan; dc++) taken[r + dr][c + dc] = true;
      c += cell.colspan;
    }
  });
  const columns = Math.max(1, ...taken.map((row) => row.length));
  const widths = tableWidths(content.columnWidths, texts, columns, width);
  // Columns of amounts line up on the right (Markdown tables lose their alignment on the way in).
  const amounts = new Set<number>();
  for (let c = 0; c < columns; c++) {
    const values = texts.slice(headerRows).flatMap((row) => (row[c]?.trim() ? [row[c].trim()] : []));
    if (values.length && values.every((v) => AMOUNT.test(v))) amounts.add(c);
  }
  const body = rows.map(
    (_, r) =>
      new TableRow({
        tableHeader: r < headerRows,
        cantSplit: true,
        children: placed
          .filter((p) => p.row === r)
          .map(({ column, cell }) => {
            const header = r < headerRows || column < headerCols;
            const fill = backgroundColor(cell.props.backgroundColor) ?? (header ? headerFill(walk.input) : undefined);
            const color = textColor(cell.props.textColor);
            const align = alignment(cell.props.textAlignment) ?? (amounts.has(column) ? AlignmentType.RIGHT : undefined);
            const span = widths.slice(column, column + cell.colspan).reduce((a, b) => a + b, 0);
            return new TableCell({
              width: { size: span, type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              ...(cell.colspan > 1 ? { columnSpan: cell.colspan } : {}),
              ...(cell.rowspan > 1 ? { rowSpan: cell.rowspan } : {}),
              ...(fill ? { shading: shading(fill) } : {}),
              children: [
                new Paragraph({
                  children: inline(cell.content, walk, { ...(header ? { bold: true } : {}), ...(color ? { color } : {}) }),
                  spacing: { before: 0, after: 0 },
                  ...(align ? { alignment: align } : {}),
                }),
              ],
            });
          }),
      }),
  );
  return new Table({
    rows: body,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    borders: borders(),
    ...(indent ? { indent: { size: indent, type: WidthType.DXA } } : {}),
  });
}

/** A database's rows as a table, its header shaded and repeated on every page. */
function dataTable(data: PdfTable, input: DocxInput, width = CONTENT_WIDTH, indent = 0): Table {
  const columns = Math.max(1, data.header.length);
  const widths = tableWidths(null, [data.header, ...data.rows], columns, width);
  const align = (c: number) => (data.align?.[c] === "center" ? AlignmentType.CENTER : data.align?.[c] === "right" ? AlignmentType.RIGHT : undefined);
  const row = (cells: string[], header: boolean) =>
    new TableRow({
      tableHeader: header,
      cantSplit: true,
      children: widths.map((w, c) => {
        const a = align(c);
        return new TableCell({
          width: { size: w, type: WidthType.DXA },
          margins: { top: 40, bottom: 40, left: 100, right: 100 },
          ...(header ? { shading: shading(headerFill(input)) } : {}),
          children: [new Paragraph({ children: runs(cells[c] ?? "", { size: 18, ...(header ? { bold: true } : {}) }), spacing: { before: 0, after: 0 }, ...(a ? { alignment: a } : {}) })],
        });
      }),
    });
  return new Table({
    rows: [row(data.header, true), ...data.rows.map((r) => row(r, false))],
    width: { size: width, type: WidthType.DXA },
    columnWidths: widths,
    borders: borders(),
    ...(indent ? { indent: { size: indent, type: WidthType.DXA } } : {}),
  });
}

function sectionContent(section: PdfSection, index: number, walk: Walk): Block[] {
  const { input } = walk;
  const title = section.title.trim() || input.labels.untitled;
  // A body that starts with the title as a heading doesn't print it twice.
  const first = section.blocks[0];
  const blocks = first?.type === "heading" && plainText(first.content).trim().toLowerCase() === title.toLowerCase() ? section.blocks.slice(1) : section.blocks;
  const icon = iconText(section.icon);
  const out: Block[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: runs(icon ? `${icon} ${title}` : title, {}), pageBreakBefore: index > 0 })];
  if (section.properties.length) {
    const widths = tableWidths(null, section.properties.map((p) => [p.name, p.value]), 2, CONTENT_WIDTH);
    out.push(
      new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        columnWidths: widths,
        borders: NO_BORDERS,
        layout: TableLayoutType.FIXED,
        rows: section.properties.map(
          (p) =>
            new TableRow({
              children: [
                new TableCell({ width: { size: widths[0], type: WidthType.DXA }, margins: { right: 200 }, children: [new Paragraph({ children: runs(p.name, { color: MUTED }), spacing: { after: 40 } })] }),
                new TableCell({ width: { size: widths[1], type: WidthType.DXA }, children: [new Paragraph({ children: runs(p.value || " ", {}), spacing: { after: 40 } })] }),
              ],
            }),
        ),
      }),
      spacer(),
    );
  }
  out.push(...blocksContent(blocks, walk));
  if (section.database) out.push(dataTable(section.database, input), spacer());
  if (section.comments?.threads.length) out.push(...commentsContent(section.comments));
  return out;
}

/** The comment threads after the body, under a heading: each thread's subject, then its comments, author and date over the text, set in. */
function commentsContent({ heading, resolved, threads }: NonNullable<PdfSection["comments"]>): Block[] {
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(heading, {}), border: { top: line(BORDER, 4) } }),
    ...threads.flatMap((t) => [
      new Paragraph({ children: [...runs(t.about, { bold: true }), ...(t.resolved ? runs(`  ${resolved}`, { color: MUTED, size: SMALL_SIZE }) : [])], keepNext: true, spacing: { before: 120, after: 60 } }),
      ...t.comments.flatMap((c) => [
        new Paragraph({
          children: [...runs(c.author, { bold: true, size: SMALL_SIZE }), ...(c.date ? runs(`  ${c.date}`, { color: FAINT, size: SMALL_SIZE }) : [])],
          indent: { left: 200 },
          border: { left: line(BORDER, 12) },
          keepNext: true,
          spacing: { after: 0 },
        }),
        new Paragraph({ children: runs(commentText(c.body), {}), indent: { left: 200 }, border: { left: line(BORDER, 12) }, spacing: { after: 120 } }),
      ]),
    ]),
  ];
}

const linesOf = (text: string) => (text ? text.split("\n") : []);

/** A letterhead's logo as an image no bigger than the PDF draws it. */
function logoRun(dataUrl: string): ImageRun | null {
  const image = imageData(dataUrl);
  if (!image) return null;
  const scale = Math.min(1, LOGO_WIDTH_PX / image.width, LOGO_HEIGHT_PX / image.height);
  return new ImageRun({ type: image.type, data: image.data, transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) } });
}

/** A letterhead's top, on every page: the logo on its side and the lines on the other (both centered for "center"), a rule under them in its accent. */
function letterheadTop(letterhead: PdfLetterhead): Header | null {
  const logo = letterhead.logo ? logoRun(letterhead.logo) : null;
  const lines = linesOf(letterhead.header);
  if (!logo && !lines.length) return null;
  const rule = { bottom: line(letterhead.accent ? hex(letterhead.accent) : BORDER, letterhead.accent ? 12 : 6) };
  const text = (align: Align) =>
    lines.map(
      (l, i) =>
        new Paragraph({
          children: runs(l, i === 0 ? { bold: true, size: 20 } : { color: MUTED, size: SMALL_SIZE }),
          alignment: align,
          spacing: { after: 0 },
        }),
    );
  if (letterhead.logoPlace === "center" || !logo) {
    const align = letterhead.logoPlace === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
    const parts = [...(logo ? [new Paragraph({ children: [logo], alignment: align, spacing: { after: lines.length ? 80 : 0 } })] : []), ...text(align)];
    return new Header({ children: [...parts, new Paragraph({ border: rule, spacing: { after: 240 }, children: [] })] });
  }
  const left = letterhead.logoPlace === "left";
  const logoWidth = LOGO_WIDTH_PX * TWIPS_PER_PX;
  const widths = left ? [logoWidth, CONTENT_WIDTH - logoWidth] : [CONTENT_WIDTH - logoWidth, logoWidth];
  const picture = new TableCell({ width: { size: logoWidth, type: WidthType.DXA }, children: [new Paragraph({ children: [logo], alignment: left ? AlignmentType.LEFT : AlignmentType.RIGHT })] });
  const words = new TableCell({ width: { size: CONTENT_WIDTH - logoWidth, type: WidthType.DXA }, children: cellBlocks(text(left ? AlignmentType.RIGHT : AlignmentType.LEFT)) });
  return new Header({
    children: [
      new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        columnWidths: widths,
        borders: NO_BORDERS,
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({ children: left ? [picture, words] : [words, picture] })],
      }),
      new Paragraph({ border: rule, spacing: { after: 240 }, children: [] }),
    ],
  });
}

/** "n / total" in small gray text. */
function pageNumbers(align: Align = AlignmentType.RIGHT): Paragraph {
  const style = { size: 16, color: FAINT };
  return new Paragraph({ alignment: align, spacing: { after: 0 }, children: [new TextRun({ ...style, children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES] })] });
}

/** A letterhead's foot: a thin rule, its lines, and the page numbers on the right when it shows them. */
function letterheadFoot(letterhead: PdfLetterhead): Footer | null {
  const lines = linesOf(letterhead.footer);
  if (!lines.length) return letterhead.pageNumbers ? new Footer({ children: [pageNumbers()] }) : null;
  const words = lines.map((l, i) => new Paragraph({ children: runs(l, { color: MUTED, size: 16 }), spacing: { after: 0 }, ...(i === 0 ? { border: { top: line(BORDER, 4) } } : {}) }));
  if (!letterhead.pageNumbers) return new Footer({ children: words });
  const numberWidth = 1200;
  return new Footer({
    children: [
      new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        columnWidths: [CONTENT_WIDTH - numberWidth, numberWidth],
        borders: NO_BORDERS,
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            children: [
              new TableCell({ width: { size: CONTENT_WIDTH - numberWidth, type: WidthType.DXA }, children: words }),
              new TableCell({ width: { size: numberWidth, type: WidthType.DXA }, children: [pageNumbers()] }),
            ],
          }),
        ],
      }),
    ],
  });
}

const NUMBER_FORMATS = { decimal: LevelFormat.DECIMAL, "lower-alpha": LevelFormat.LOWER_LETTER, "lower-roman": LevelFormat.LOWER_ROMAN } as const;
const BULLETS = ["•", "◦", "▪"];

/** Word's list definitions: bullets by depth, and a numbered list per counting style (1, a, i) at every depth. */
function numbering() {
  const levels = (format: (level: number) => { format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: string }) =>
    Array.from({ length: 9 }, (_, level) => ({
      level,
      ...format(level),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: INDENT * 2 * (level + 1), hanging: INDENT } } },
    }));
  return {
    config: [
      { reference: "bullet", levels: levels((level) => ({ format: LevelFormat.BULLET, text: BULLETS[level % BULLETS.length] })) },
      ...(Object.keys(NUMBER_FORMATS) as (keyof typeof NUMBER_FORMATS)[]).map((style) => ({
        reference: `number-${style}`,
        levels: levels((level) => ({ format: NUMBER_FORMATS[style], text: `%${level + 1}.` })),
      })),
    ],
  };
}

/** The Word document of `input`, on A4: its letterhead at the top and foot of every page, or page numbers at the foot. */
export function docxDocument(input: DocxInput): Document {
  const walk = { notes: new Map<number, string>(), nextNote: { n: 1 }, lists: { n: 0 } };
  const children = input.sections.flatMap((section, i) => sectionContent(section, i, { ...walk, input, section }));
  const letterhead = input.letterhead ?? null;
  const header = letterhead ? letterheadTop(letterhead) : null;
  const footer = letterhead ? letterheadFoot(letterhead) : new Footer({ children: [pageNumbers()] });
  const heading = (size: number, before: number) => ({ run: { font: FONT, size, bold: true, color: FG }, paragraph: { spacing: { before, after: 80 }, keepNext: true, keepLines: true } });
  return new Document({
    creator: "Leafdesk",
    title: xmlSafe(input.title || input.labels.untitled),
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY_SIZE, color: FG }, paragraph: { spacing: { after: 120, line: 276 } } },
        title: { run: { font: FONT, size: 44, bold: true, color: FG }, paragraph: { spacing: { after: 240 } } },
        heading1: heading(HEADING_SIZES[0], 240),
        heading2: heading(HEADING_SIZES[1], 200),
        heading3: heading(HEADING_SIZES[2], 160),
        hyperlink: { run: { color: LINK, underline: {} } },
      },
    },
    numbering: numbering(),
    footnotes: Object.fromEntries([...walk.notes].map(([id, text]) => [id, { children: [new Paragraph({ children: runs(text, { size: SMALL_SIZE }) })] }])),
    sections: [
      {
        properties: { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 567, footer: 567 } } },
        ...(header ? { headers: { default: header } } : {}),
        ...(footer ? { footers: { default: footer } } : {}),
        children: children.length ? children : [new Paragraph({ children: [] })],
      },
    ],
  });
}

/** The Word document of `input` as the bytes of a .docx file. */
export async function renderDocx(input: DocxInput): Promise<Buffer> {
  return Packer.toBuffer(docxDocument(input));
}
