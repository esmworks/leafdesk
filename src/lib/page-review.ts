/**
 * Reviewing what an AI app, the chat or an agent changed in a page body: the changes between the
 * page before the write and now (lib/page-diff), and undoing one of them in the current body while
 * the others stay. Pure: the server (server/page-review.ts) reads both versions and writes the
 * result through the page's shared document.
 */
import { diffBlocks, flattenBlocks, type BlockChange, type BlockInput } from "./page-diff";

/** A BlockNote block as plain JSON, as the page's document holds it. */
export type ReviewBlock = Omit<BlockInput, "children"> & { id?: string; children?: ReviewBlock[] };

const isColumn = (block: ReviewBlock) => block.type === "columnList" || block.type === "column";

function isEmptyParagraph(block: ReviewBlock) {
  return block.type === "paragraph" && !block.children?.length && flattenBlocks([block])[0]?.text === "";
}

/** Without the empty paragraphs at the end, which the editor adds and keeps there. */
export function trimTrailingEmpty<B extends ReviewBlock>(blocks: readonly B[]): B[] {
  let end = blocks.length;
  while (end > 0 && isEmptyParagraph(blocks[end - 1])) end--;
  return blocks.slice(0, end);
}

/** The changes from the body `before` to the body `after`, block by block. */
export function reviewChanges(before: readonly ReviewBlock[], after: readonly ReviewBlock[]): BlockChange[] {
  return diffBlocks(flattenBlocks(trimTrailingEmpty(before)), flattenBlocks(trimTrailingEmpty(after)));
}

/** A short hash of a string (53 bits, base 36). */
function hash(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * An id for each change (null for unchanged blocks), from what it changes rather than where it is,
 * so a decision names the change it was made on and changes keep their ids while others are undone.
 */
export function changeIds(changes: readonly BlockChange[]): (string | null)[] {
  const seen = new Map<string, number>();
  return changes.map((change) => {
    if (change.op === "same") return null;
    const before = change.op === "changed" ? change.before.key : "";
    const id = hash(`${change.op}\u0000${change.block.depth}\u0000${before}\u0000${change.block.key}`);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return n ? `${id}-${n}` : id;
  });
}

/** The changes with those kept on the page shown as they are now: kept removals drop out. */
export function withoutKept(changes: readonly BlockChange[], ids: readonly (string | null)[], kept: ReadonlySet<string>) {
  const out: { change: BlockChange; id: string | null }[] = [];
  changes.forEach((change, i) => {
    const id = ids[i];
    if (!id || !kept.has(id)) out.push({ change, id });
    else if (change.op !== "removed") out.push({ change: { op: "same", block: change.block }, id: null });
  });
  return out;
}

/** Where a block sits: the list holding it, its place there, and the blocks above it (columns too). */
type Place = { list: ReviewBlock[]; index: number; path: ReviewBlock[] };

function locate(blocks: ReviewBlock[], id: string, path: ReviewBlock[] = []): Place | null {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.id === id) return { list: blocks, index, path };
    if (block.children?.length) {
      const found = locate(block.children, id, [...path, block]);
      if (found) return found;
    }
  }
  return null;
}

function idsOf(blocks: readonly ReviewBlock[], out = new Set<string>()) {
  for (const block of blocks) {
    if (block.id) out.add(block.id);
    if (block.children) idsOf(block.children, out);
  }
  return out;
}

/** Columns left empty go, and a row of columns left with one column becomes its blocks. */
function tidyColumns(blocks: ReviewBlock[]): ReviewBlock[] {
  return blocks.flatMap((block): ReviewBlock[] => {
    if (block.type === "columnList") {
      const columns = (block.children ?? []).map((c) => ({ ...c, children: tidyColumns(c.children ?? []) })).filter((c) => c.children.length);
      if (columns.length < 2) return columns[0]?.children ?? [];
      return [{ ...block, children: columns }];
    }
    return block.children?.length ? [{ ...block, children: tidyColumns(block.children) }] : [block];
  });
}

/** The type, props and content a flattened block was made from (its `key`). */
function partsOf(key: string): Pick<ReviewBlock, "type" | "props" | "content"> {
  const [type, props, content] = JSON.parse(key) as [string, Record<string, unknown>, ReviewBlock["content"] | null];
  return { type, props, ...(content === null ? {} : { content }) };
}

const newId = () => globalThis.crypto.randomUUID();

/**
 * The current body with change `index` of `changes` (reviewChanges of the earlier body and `live`)
 * undone: an added block removed (its children take its place), a changed block given back its
 * type, props and content, a removed block put back after the block before it. Null when the
 * change can't be placed in `live` any more.
 */
export function undoChange(live: readonly ReviewBlock[], changes: readonly BlockChange[], index: number): ReviewBlock[] | null {
  const change = changes[index];
  if (!change || change.op === "same") return null;
  const blocks = structuredClone(live) as ReviewBlock[];

  if (change.op === "added" || change.op === "changed") {
    const place = change.block.id ? locate(blocks, change.block.id) : null;
    if (!place) return null;
    const block = place.list[place.index];
    if (change.op === "added") place.list.splice(place.index, 1, ...(block.children ?? []));
    else if (change.op === "changed") place.list[place.index] = { id: block.id, ...partsOf(change.before.key), children: block.children ?? [] };
    return tidyColumns(blocks);
  }

  // Removed: back after the nearest earlier block that is still there, at its own depth.
  const restored: ReviewBlock = { ...partsOf(change.block.key), children: [] };
  const taken = idsOf(blocks);
  restored.id = change.block.id && !taken.has(change.block.id) ? change.block.id : newId();
  const depth = change.block.depth;
  for (let i = index - 1; i >= 0; i--) {
    const anchor = changes[i];
    if (anchor.op === "removed" || !anchor.block.id) continue;
    const place = locate(blocks, anchor.block.id);
    if (!place) continue;
    const at = place.list[place.index];
    if (depth > anchor.block.depth) {
      at.children = [restored, ...(at.children ?? [])];
      return blocks;
    }
    // The block above the anchor at the removed block's depth (columns don't count as a level).
    const levels = [...place.path.filter((b) => !isColumn(b)), at];
    const holder = levels[depth];
    if (holder === at) {
      place.list.splice(place.index + 1, 0, restored);
      return blocks;
    }
    const outer = holder?.id ? locate(blocks, holder.id) : null;
    if (!outer) return null;
    outer.list.splice(outer.index + 1, 0, restored);
    return blocks;
  }
  blocks.unshift(restored);
  return blocks;
}
