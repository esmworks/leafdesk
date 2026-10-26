import { FOOTNOTE, MATH_BLOCK, MERMAID_BLOCK } from "./content-block-names";
import { findTags } from "./tags";

/**
 * The `#tags` of a page body's blocks (BlockNote's JSON, as the server reads it), for the index
 * (server/page-tags.ts). Only prose counts: code (blocks and inline), equations, diagram sources,
 * links and mentions don't, and each stands between the text around it like a character that
 * neither starts nor continues a tag (the editor's marks, components/page/tags.ts, read the same).
 * A footnote's text is read on its own.
 */

type Inline = { type?: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] | string };
type TableContent = { type: "tableContent"; rows?: { cells?: (Inline[] | { content?: Inline[] })[] }[] };
type Block = { type?: string; content?: Inline[] | TableContent | string; children?: Block[] };

/** Stands for what isn't prose (code, a link, a mention, an equation). */
export const NOT_PROSE = "￼";

/** Blocks whose text is a source, not prose. */
export const SOURCE_BLOCKS = new Set(["codeBlock", MATH_BLOCK, MERMAID_BLOCK]);

/** The texts of inline content where tags are looked for: its own, then its footnotes'. */
function inlineTexts(nodes: Inline[], out: string[]) {
  let text = "";
  const notes: Inline[][] = [];
  for (const node of nodes) {
    if (node.type === "text" && typeof node.text === "string") text += node.styles?.code ? NOT_PROSE : node.text;
    else {
      text += NOT_PROSE;
      if (node.type === FOOTNOTE && Array.isArray(node.content)) notes.push(node.content);
    }
  }
  out.push(text);
  for (const note of notes) inlineTexts(note, out);
}

/** The prose texts of a block tree: a text per block, table cell and footnote. */
export function proseTexts(blocks: unknown[]): string[] {
  const out: string[] = [];
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (!block || typeof block !== "object") continue;
      const { content } = block;
      if (!SOURCE_BLOCKS.has(block.type ?? "") && content && typeof content === "object") {
        if (Array.isArray(content)) inlineTexts(content, out);
        else if (content.type === "tableContent") {
          for (const row of content.rows ?? []) {
            for (const cell of row.cells ?? []) {
              const nodes = Array.isArray(cell) ? cell : cell?.content;
              if (Array.isArray(nodes)) inlineTexts(nodes, out);
            }
          }
        }
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks as Block[]);
  return out;
}

export type PageTagCount = { label: string; count: number };

/** The tags of a body by key: the first spelling met, and how many times each appears. */
export function tagsInBlocks(blocks: unknown[]): Map<string, PageTagCount> {
  const tags = new Map<string, PageTagCount>();
  for (const text of proseTexts(blocks)) {
    if (!text.includes("#")) continue;
    for (const tag of findTags(text)) {
      const seen = tags.get(tag.key);
      if (seen) seen.count++;
      else tags.set(tag.key, { label: tag.label, count: 1 });
    }
  }
  return tags;
}
