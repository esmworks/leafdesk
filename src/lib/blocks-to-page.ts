import { blockText, type BlockLike } from "./blocks";

/** Blocks whose text can be a page's title. */
const TITLE_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote"]);

/** Longest title a page made from blocks takes. */
const MAX_TITLE = 500;

/**
 * A page made of blocks ("Turn into page in…" in a block's menu): the first block's text as its
 * title when it is a text block with some, its nested blocks and the others as the body; otherwise
 * no title and every block as the body.
 */
export function pageFromBlocks<B extends BlockLike>(blocks: B[]): { title: string; body: B[] } {
  const [first, ...rest] = blocks;
  if (first && TITLE_TYPES.has(first.type ?? "")) {
    const title = blockText(first).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (title) return { title, body: [...((first.children ?? []) as B[]), ...rest] };
  }
  return { title: "", body: blocks };
}
