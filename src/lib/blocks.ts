import { MENTION, mentionPlainText } from "./mentions";

/** Minimal structural view of BlockNote blocks; enough to extract searchable text. */
type InlineNode = { type: string; text?: string; content?: InlineNode[] | string; props?: unknown };
type TableContent = { type: "tableContent"; rows: { cells: (InlineNode[] | { content: InlineNode[] })[] }[] };
export type BlockLike = {
  type?: string;
  props?: Record<string, unknown>;
  content?: InlineNode[] | TableContent | string;
  children?: BlockLike[];
};

/** What a page mention reads as, by the page's id; nothing by default (a title isn't the mention's to show). */
type PageMentionText = (pageId: string) => string;

function inlineText(nodes: InlineNode[] | string | undefined, pageText?: PageMentionText): string {
  if (!nodes) return "";
  if (typeof nodes === "string") return nodes;
  // People and dates read as "@Name" and "@2026-10-01"; a page mention adds no text (see lib/mentions).
  return nodes
    .map((n) => {
      if (typeof n.text === "string") return n.text;
      if (n.type !== MENTION) return inlineText(n.content, pageText);
      const props = n.props as { kind?: unknown; pageId?: unknown } | undefined;
      if (pageText && props?.kind === "page" && typeof props.pageId === "string") return pageText(props.pageId);
      return mentionPlainText(n.props);
    })
    .join("");
}

/** A block's own text (not its nested blocks'), as search sees it; table rows are lines. */
export function blockText(block: BlockLike, pageText?: PageMentionText): string {
  const { content } = block;
  // A bookmark has no text of its own; its page's title and description are what people search for.
  if (block.type === "bookmark") {
    return [block.props?.title, block.props?.description].filter((v) => typeof v === "string" && v).join(" ");
  }
  if (!content) return "";
  if (typeof content === "string" || Array.isArray(content)) return inlineText(content, pageText);
  if (content.type === "tableContent") {
    return content.rows
      .map((row) => row.cells.map((cell) => inlineText(Array.isArray(cell) ? cell : cell.content, pageText)).join(" "))
      .join("\n");
  }
  return "";
}

/** Plain text of a block tree, one line per block, for full-text search. */
export function blocksToPlainText(blocks: BlockLike[]): string {
  const lines: string[] = [];
  const walk = (list: BlockLike[]) => {
    for (const block of list) {
      const text = blockText(block).trim();
      if (text) lines.push(text);
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return lines.join("\n");
}
