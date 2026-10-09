/**
 * Where one page is named in another, for the "Linked from" list (server/mentions.ts): the text
 * around a link to it, kept with the link, and its title written as plain words without a link (an
 * unlinked mention), which the list can turn into a page mention.
 *
 * Contexts come from the same text search reads (lib/blocks), so a context never shows more than
 * the page's searchable text: other pages' mentions stay without their titles, and the link itself
 * is LINK_PLACEHOLDER, shown as the linked page's live title.
 */
import { blockText, type BlockLike } from "./blocks";
import { EMPTY_MENTION, eachMention, MENTION, PAGE_LINK_BLOCK } from "./mentions";
import { searchFold } from "./search-fold";

/** Stands for the link in a stored context. */
export const LINK_PLACEHOLDER = "￼";
/** Characters of text kept on each side of the link (or the title), at most. */
const AROUND = 90;
/** Titles shorter than this name too much to be looked for. */
export const MIN_MENTION_TITLE = 2;

const WORD = /[\p{L}\p{N}_]/u;
/** Marks the link while a context is built; text can't hold it (Postgres text has no NUL). */
const MARK = "\u0000";

export type Excerpt = { before: string; match: string; after: string };

/** A slice end that doesn't split a surrogate pair. */
const safeStart = (text: string, at: number) => (/[\udc00-\udfff]/.test(text.charAt(at)) ? at + 1 : at);
const safeEnd = (text: string, at: number) => (/[\ud800-\udbff]/.test(text.charAt(at - 1)) ? at - 1 : at);

/**
 * The text around `start`..`end` of `text`, within its line and cut at spaces where it is shortened
 * (marked with "…").
 */
export function excerpt(text: string, start: number, end: number): Excerpt {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  let from = Math.max(lineStart, start - AROUND);
  let to = Math.min(lineEnd, end + AROUND);
  if (from > lineStart) {
    const space = text.indexOf(" ", from);
    from = space !== -1 && space < start ? space + 1 : safeStart(text, from);
  }
  if (to < lineEnd) {
    const space = text.lastIndexOf(" ", to);
    to = space >= end ? space : safeEnd(text, to);
  }
  return {
    before: (from > lineStart ? "…" : "") + text.slice(from, start).trimStart(),
    match: text.slice(start, end),
    after: text.slice(end, to).trimEnd() + (to < lineEnd ? "…" : ""),
  };
}

/** A character with the combining marks after it (or marks with nothing before them). */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;

/**
 * Where `title` first appears in `text` as whole words, compared the way pickers compare (case and
 * the Turkish dotted and dotless i aside, lib/search-fold), whether letters are written composed
 * or with combining marks (NFC or NFD). Null when it doesn't, or when the title is too short to
 * look for.
 */
export function findTitle(text: string, title: string): { start: number; end: number } | null {
  const wanted = searchFold(title.normalize("NFC").trim());
  if ([...wanted].length < MIN_MENTION_TITLE) return null;
  // Folded text, and for each of its characters the index in `text` its character (with its marks)
  // starts at.
  let folded = "";
  const from: number[] = [];
  for (const { 0: cluster, index } of text.matchAll(CLUSTER)) {
    const fold = searchFold(cluster.normalize("NFC"));
    for (let k = 0; k < fold.length; k++) from.push(index);
    folded += fold;
  }
  from.push(text.length);
  const edgeIsWord = (char: string | undefined) => char !== undefined && WORD.test(char);
  const needsStart = edgeIsWord(String.fromCodePoint(wanted.codePointAt(0)!));
  const needsEnd = edgeIsWord([...wanted].at(-1));
  for (let at = folded.indexOf(wanted); at !== -1; at = folded.indexOf(wanted, at + 1)) {
    const before = at > 0 ? [...folded.slice(Math.max(0, at - 2), at)].at(-1) : undefined;
    const after = folded.slice(at + wanted.length).codePointAt(0);
    if (needsStart && edgeIsWord(before)) continue;
    if (needsEnd && after !== undefined && edgeIsWord(String.fromCodePoint(after))) continue;
    const start = from[at];
    // The end is where the next folded character came from (a folded character may be shorter).
    const end = from[at + wanted.length] ?? text.length;
    return { start, end };
  }
  return null;
}

/** The pages a block's own content mentions (not its nested blocks'), in order. */
function pagesMentionedIn(block: BlockLike): string[] {
  const ids: string[] = [];
  eachMention([{ ...block, children: [] }] as Parameters<typeof eachMention>[0], (m) => {
    if (m.kind === "page" && m.pageId && !ids.includes(m.pageId)) ids.push(m.pageId);
  });
  return ids;
}

/**
 * For each page a body mentions, the text around its first mention, with the mention (and any later
 * one in the same block) as LINK_PLACEHOLDER. A mention with no text around it, and a "Link to page"
 * block, have no context.
 */
export function linkContexts(blocks: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (list: BlockLike[]) => {
    for (const block of list) {
      if (block.type !== PAGE_LINK_BLOCK) {
        for (const pageId of pagesMentionedIn(block)) {
          if (seen.has(pageId)) continue;
          seen.add(pageId);
          const text = blockText(block, (id) => (id === pageId ? MARK : ""))
            .replaceAll(LINK_PLACEHOLDER, "")
            .trim();
          const at = text.indexOf(MARK);
          if (at === -1 || text.replaceAll(MARK, "").trim() === "") continue;
          const { before, after } = excerpt(text, at, at + 1);
          out.set(pageId, `${before}${LINK_PLACEHOLDER}${after}`.replaceAll(MARK, LINK_PLACEHOLDER));
        }
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks as BlockLike[]);
  return out;
}

type InlineNode = { type?: string; text?: string; styles?: { code?: unknown }; content?: unknown };
type EditableBlock = { type?: string; content?: unknown; children?: EditableBlock[] };

/**
 * Calls `visit` with each list of inline content of `blocks` in document order (paragraphs, table
 * cells, nested blocks; not code blocks), until it returns true. True when one did.
 */
export function someInlineContent(blocks: unknown[], visit: (nodes: unknown[]) => boolean): boolean {
  const inline = (nodes: unknown) => Array.isArray(nodes) && visit(nodes);
  const walk = (list: EditableBlock[]): boolean => {
    for (const block of list) {
      if (block.type !== "codeBlock") {
        const content = block.content as { type?: string; rows?: { cells?: unknown[] }[] } | unknown[] | undefined;
        if (Array.isArray(content)) {
          if (inline(content)) return true;
        } else if (content?.type === "tableContent") {
          for (const row of content.rows ?? []) {
            for (const cell of row.cells ?? []) {
              if (inline(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content)) return true;
            }
          }
        }
      }
      if (block.children?.length && walk(block.children)) return true;
    }
    return false;
  };
  return walk(blocks as EditableBlock[]);
}

/** A plain text node: not a mention or link, and not inline code (code, like a code block). */
export const isPlainText = (node: unknown): node is InlineNode & { text: string } =>
  (node as InlineNode | null)?.type === "text" && typeof (node as InlineNode).text === "string" && !(node as InlineNode).styles?.code;

/**
 * Turns the first place `title` is written in plain text (document order; not in code blocks,
 * inline code, links or across differently styled runs) into a mention of `pageId`. Changes `blocks` in place; false
 * when the title isn't there.
 */
export function linkTitle(blocks: unknown[], title: string, pageId: string): boolean {
  return someInlineContent(blocks, (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isPlainText(node)) continue;
      const found = findTitle(node.text, title);
      if (!found) continue;
      const pieces: unknown[] = [];
      if (found.start > 0) pieces.push({ ...node, text: node.text.slice(0, found.start) });
      pieces.push({ type: MENTION, props: { ...EMPTY_MENTION, kind: "page", pageId } });
      if (found.end < node.text.length) pieces.push({ ...node, text: node.text.slice(found.end) });
      nodes.splice(i, 1, ...pieces);
      return true;
    }
    return false;
  });
}
