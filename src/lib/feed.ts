/**
 * Feed views: a database's rows as posts in one column, newest first unless the view sorts
 * otherwise (lib/views withViewSorts). Each post shows its title, who wrote it and when, the
 * properties the view shows, the first part of its body, reactions to the row (server/reactions.ts)
 * and its comments. Posts load a page at a time (server/feed.ts), so a database of thousands of rows
 * reads only the bodies, reactions and comments of the posts on screen.
 *
 * Pure and client-safe: what a post shows of its body.
 */

/** Posts read at a time: the first ones when the view opens, then more as the reader asks. */
export const FEED_PAGE_SIZE = 20;
/** About how much of a body a post shows before "Show more". */
export const FEED_EXCERPT_CHARS = 600;
/** At most this many blocks (paragraphs, lists, images…) before "Show more". */
export const FEED_EXCERPT_BLOCKS = 6;
/** The most of a body "Show more" brings: past it, the post links to the row. */
export const FEED_BODY_CHARS = 50_000;

/** The emoji a post's reaction button offers first; any other single emoji is taken too. */
export const REACTION_EMOJIS = ["👍", "❤️", "🎉", "😄", "🙏", "👀", "🚀", "✅"] as const;
/** Different emoji one person may leave on one page. */
export const MAX_REACTIONS_PER_PERSON = 20;

/** A reaction to a post as its reader sees it: how many left it, and whether they did. */
export type PostReaction = { emoji: string; count: number; mine: boolean; userIds: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * Lines that are a block of their own in the app (a database, dashboard, table of contents, an
 * agent's chat…): HTML comments a post has nothing to draw for.
 */
const MARKER_LINE = /^ {0,3}<!--\s*leafdesk:.*?-->\s*$/;

/** The body's blocks: runs of lines between blank lines, a fenced code block whole. Marker lines are left out. */
function markdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.some((line) => line.trim())) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      current.push(line);
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !line.trim().slice(close[1].length).trim()) {
        fence = null;
        flush();
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      flush();
      fence = open[1];
      current.push(line);
      continue;
    }
    if (MARKER_LINE.test(line)) {
      flush();
      continue;
    }
    if (!line.trim()) flush();
    else current.push(line);
  }
  // A fence left open runs to the end, as Markdown reads it.
  flush();
  return blocks;
}

/**
 * The first part of a body for its post: whole blocks while they fit in `chars` (and `blocks` of
 * them), at least the first one, cut at a word (and its code fence closed again) when even that is
 * too long. `more` says whether anything was left out.
 */
export function feedExcerpt(
  markdown: string,
  { chars = FEED_EXCERPT_CHARS, blocks: maxBlocks = FEED_EXCERPT_BLOCKS }: { chars?: number; blocks?: number } = {},
): { markdown: string; more: boolean } {
  const blocks = markdownBlocks(markdown);
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (kept.length >= maxBlocks || (kept.length && used + block.length > chars)) break;
    kept.push(block);
    used += block.length;
  }
  if (!kept.length) return { markdown: "", more: false };
  let more = kept.length < blocks.length;
  if (kept.length === 1 && kept[0].length > chars) {
    kept[0] = cutBlock(kept[0], chars);
    more = true;
  }
  return { markdown: kept.join("\n\n"), more };
}

/** A block cut to about `chars`: at a line in fenced code (closing the fence), else at a word with "…". */
function cutBlock(block: string, chars: number): string {
  const fence = FENCE.exec(block);
  if (fence) {
    const lines = block.split("\n");
    const out = [lines[0]];
    let used = lines[0].length;
    for (const line of lines.slice(1, -1)) {
      if (used + line.length > chars) break;
      out.push(line);
      used += line.length + 1;
    }
    return [...out, fence[1]].join("\n");
  }
  const head = block.slice(0, chars);
  const space = head.search(/\s\S*$/);
  return `${(space > chars / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}
