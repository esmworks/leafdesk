/**
 * Changes to a page body block by block, as the AI chat, agents (edit_page) and AI apps (MCP
 * update_page) make them: a block replaced by new ones, new blocks after a block or at the end, a
 * block removed. Blocks are found by their id at any depth, in columns too; get_page and read_page
 * show the ids as `<!-- block … -->` lines before each block when asked for them.
 */
import { locate, tidyColumns, trimTrailingEmpty, type ReviewBlock } from "./page-review";

export const BLOCK_EDIT_OPS = ["replace", "insert_after", "append", "delete"] as const;
export type BlockEditOp = (typeof BLOCK_EDIT_OPS)[number];

/** An edit as asked for: `markdown` for everything but delete, `blockId` for everything but append. */
export type BlockEdit = { op: BlockEditOp; blockId?: string; markdown?: string };

/** The most edits one call makes. */
export const MAX_BLOCK_EDITS = 30;

/** The line that names the block after it, as a body read with its block ids shows it. */
export const blockMarker = (id: string) => `<!-- block ${id} -->`;
const MARKER_LINE = /^[ \t]*<!-- block [\w-]+ -->[ \t]*(?:\r?\n|$)/gm;

/** Markdown without block markers copied back from a body read with its block ids. */
export function stripBlockMarkers(markdown: string) {
  return markdown.replace(MARKER_LINE, "");
}

/** What is wrong with an edit as asked for, or null. */
export function blockEditProblem(edit: BlockEdit): string | null {
  if (!BLOCK_EDIT_OPS.includes(edit.op)) return `op must be one of ${BLOCK_EDIT_OPS.join(", ")}`;
  if (edit.op !== "append" && !edit.blockId) return `${edit.op} needs block_id`;
  if (edit.op !== "delete" && (edit.markdown === undefined || !stripBlockMarkers(edit.markdown).trim())) return `${edit.op} needs markdown`;
  return null;
}

/**
 * The body with the edits made in order, each with its new blocks (`blocks`, parsed from its
 * Markdown) — or the id of the first block an edit names that the body doesn't have (any more).
 */
export function applyBlockEdits(
  body: readonly ReviewBlock[],
  edits: readonly { op: BlockEditOp; blockId?: string; blocks: ReviewBlock[] }[],
): { blocks: ReviewBlock[] } | { missing: string } {
  let blocks = structuredClone(body) as ReviewBlock[];
  for (const edit of edits) {
    if (edit.op === "append") {
      blocks = [...trimTrailingEmpty(blocks), ...structuredClone(edit.blocks)];
      continue;
    }
    const place = edit.blockId ? locate(blocks, edit.blockId) : null;
    if (!place) return { missing: edit.blockId ?? "" };
    const added = structuredClone(edit.blocks);
    if (edit.op === "replace") place.list.splice(place.index, 1, ...added);
    else if (edit.op === "insert_after") place.list.splice(place.index + 1, 0, ...added);
    else place.list.splice(place.index, 1);
    blocks = tidyColumns(blocks);
  }
  // A body is never empty: the editor holds at least one block.
  return { blocks: blocks.length ? blocks : [{ type: "paragraph", props: {}, content: [], children: [] }] };
}

/** The blocks a body read with its ids lists: the top-level ones, and those in columns. */
export function listedBlocks(blocks: readonly ReviewBlock[]): ReviewBlock[] {
  return blocks.flatMap((b) => (b.type === "columnList" || b.type === "column" ? listedBlocks(b.children ?? []) : [b]));
}
