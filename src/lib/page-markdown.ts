/**
 * Markdown written into a page as blocks, given the page's current blocks: the same steps on the
 * server (server/blocknote markdownToBlocks: MCP, the REST API, Markdown source saves) and in the
 * browser (the Markdown source view's preview), so the preview shows what a save writes. Only the
 * parsing of a stretch of Markdown differs, and both sides parse with the same BlockNote schema.
 */
import { groupColumns } from "./columns";
import { footnoteMarkdown, type MdBlock } from "./content-markdown";
import { restoreDashboards } from "./dashboard";
import { restoreMeetings } from "./meetings";
import { restoreButtons } from "./buttons";
import { mergeReferencedBlocks, splitMarkdownReferences } from "./embed-blocks";
import { carryOverMentions } from "./mentions";
import { collapseSyncedRegions, SYNCED_BLOCK, syncedBlocksIn } from "./synced-blocks";
import { restoreBookmarks } from "./web-blocks";

export type PageMarkdownOptions = {
  /**
   * A rewrite of the whole body (true) rather than an addition to it: inline databases, synced
   * blocks (sources), bookmarks and dashboards the Markdown leaves out stay.
   */
  keepMissingInline: boolean;
  /** False when the Markdown is added to the page (not a rewrite of it): its mentions are all new. */
  carryOver: boolean;
  /** The page written to: its synced blocks (sources) the Markdown leaves out stay at the end of a rewrite. */
  pageId?: string;
  /** A one-off token part (letters and digits only). */
  nonce: () => string;
};

/**
 * Reference lines become database blocks (see mergeReferencedBlocks for what carries over), column
 * markers become column lists (lib/columns groupColumns), and footnotes come back with their notes
 * (lib/content-markdown footnoteMarkdown). People and dates mentioned before keep their mention's
 * identity (see carryOverMentions). `parse` reads Markdown without reference lines or footnote
 * definitions in it.
 */
export async function markdownToPageBlocks<B extends MdBlock>(
  markdown: string,
  parse: (markdown: string) => Promise<B[]>,
  existing: B[],
  { keepMissingInline, carryOver, pageId, nonce }: PageMarkdownOptions,
): Promise<B[]> {
  // Footnotes first: their notes sit at the end, apart from the blocks that refer to them.
  const notes = footnoteMarkdown(markdown, nonce());
  // A synced block's blocks are never written from Markdown: only its begin line counts.
  const parts = await Promise.all(
    splitMarkdownReferences(collapseSyncedRegions(notes.markdown)).map(async (part) =>
      "markdown" in part ? { blocks: await parse(part.markdown) } : part,
    ),
  );
  const blocks = groupColumns(notes.restore(mergeReferencedBlocks(parts, existing, { keepMissingInline })));
  if (keepMissingInline && pageId) blocks.push(...missingSources(blocks, existing, pageId));
  carryOverMentions(blocks, carryOver ? existing : []);
  // A rewrite of the whole body (not an append) gets the page's bookmarks back from their link lines
  // and its dashboards from theirs; an append makes no dashboard (restoreDashboards drops the lines).
  // Meetings likewise: a rewrite keeps the page's meeting blocks its regions name, an addition gets
  // their text as plain blocks (a meeting lives in one place). Buttons as dashboards: Markdown
  // names the page's own, it can't make one.
  if (!keepMissingInline) return restoreButtons(restoreMeetings(restoreDashboards(blocks, []), []), []);
  const rewritten = restoreButtons(restoreMeetings(restoreDashboards(restoreBookmarks(blocks, existing), existing), existing), existing);
  carryOverBlockIds(rewritten, existing);
  return rewritten;
}

/**
 * The text of a block's content, enough to tell blocks apart: text as it reads, other inline nodes
 * by their type and text, a table cell by cell. Formatting and props don't count.
 */
function contentKey(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((node: { type?: unknown; text?: unknown; content?: unknown; cells?: unknown }) => {
        if (typeof node === "string") return node;
        if (node?.type === "text" || node?.type === "link") return typeof node.text === "string" ? node.text : contentKey(node.content);
        if (node && "cells" in node) return `\u0002${contentKey(node.cells)}`;
        return `\u0001${String(node?.type)}:${contentKey(node?.content)}`;
      })
      .join("");
  }
  const table = content as { rows?: unknown } | null;
  if (table && typeof table === "object" && Array.isArray(table.rows)) return contentKey(table.rows);
  return "";
}

/** What a block refers to, for blocks that have no text: a database, a synced block, a page, a file. */
const REFERENCE_PROPS = ["databaseId", "pageId", "syncId", "url"];

function blockKey(block: MdBlock): string {
  const refs = REFERENCE_PROPS.map((key) => String(block.props?.[key] ?? "")).join("\u0003");
  return `${block.type}\u0004${refs}\u0004${contentKey(block.content)}`;
}

/** Above this many block pairs on one level, blocks match in order only (no longest common subsequence). */
const MAX_ALIGNED_PAIRS = 4_000_000;

/**
 * Gives the blocks of a rewrite that are the same as blocks the body had (same type, text and
 * references, in the same order) those blocks' ids, level by level, so links to them (`#block-…`)
 * and comments' places stay put and open editors keep their place in them. Markdown has no ids:
 * without this every block of a rewrite would be new.
 */
export function carryOverBlockIds(blocks: MdBlock[], existing: readonly MdBlock[]) {
  const ids = new Set<string>();
  const collect = (list: readonly MdBlock[], into: Set<string>, only?: Set<string>) => {
    for (const block of list) {
      if (block.id && (!only || only.has(block.id))) into.add(block.id);
      collect(block.children ?? [], into, only);
    }
  };
  collect(existing, ids);
  // Blocks that came back as they were (inline databases, bookmarks, dashboards) keep theirs.
  const used = new Set<string>();
  collect(blocks, used, ids);
  alignIds(blocks, existing, ids, used);
}

function alignIds(blocks: MdBlock[], existing: readonly MdBlock[], ids: Set<string>, used: Set<string>) {
  const a = blocks.map(blockKey);
  const b = existing.map(blockKey);
  const pairs: [number, number][] = [];
  if (a.length * b.length <= MAX_ALIGNED_PAIRS) {
    // Longest common subsequence of the two key lists.
    const width = b.length + 1;
    const table = new Int32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i] === b[j]) pairs.push([i++, j++]);
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  } else {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      const at = b.indexOf(a[i], j);
      if (at < 0) continue;
      pairs.push([i, at]);
      j = at + 1;
    }
  }
  for (const [i, j] of pairs) {
    const id = existing[j].id;
    const own = blocks[i].id;
    if (id && !used.has(id) && !(own && ids.has(own))) {
      used.add(id);
      blocks[i].id = id;
    }
    if (blocks[i].children?.length && existing[j].children?.length) alignIds(blocks[i].children!, existing[j].children!, ids, used);
  }
}

/** The page's synced blocks (sources) that `blocks` leave out, as blocks to add back. */
function missingSources<B extends MdBlock>(blocks: B[], existing: B[], pageId: string): B[] {
  const kept = new Set(syncedBlocksIn(blocks as never).map((ref) => `${ref.pageId}:${ref.syncId}`));
  const out: B[] = [];
  for (const ref of syncedBlocksIn(existing as never)) {
    const key = `${ref.pageId}:${ref.syncId}`;
    if (ref.pageId !== pageId || kept.has(key)) continue;
    kept.add(key);
    out.push({ type: SYNCED_BLOCK, props: { pageId: ref.pageId, syncId: ref.syncId }, children: [] } as unknown as B);
  }
  return out;
}
