/**
 * `[[Title]]` written out in a page's text. The editor's [[ menu links it while it is typed; text
 * pasted into a page, or written through MCP and the API, gets the same: each `[[Title]]` naming a
 * page becomes a mention of that page, and the others stay as text.
 */
import { isPlainText, someInlineContent } from "./link-context";
import { EMPTY_MENTION, MENTION } from "./mentions";
import { searchFold } from "./search-fold";

const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/** Titles are compared as lib/search-fold does, without surrounding space. */
export const titleKey = (title: string) => searchFold(title.normalize("NFC").trim());

/** The titles `[[…]]` names in the plain text of `blocks` (not code or links). */
export function wikilinkTitles(blocks: unknown[]): string[] {
  const titles = new Set<string>();
  someInlineContent(blocks, (nodes) => {
    for (const node of nodes) {
      if (!isPlainText(node)) continue;
      for (const match of node.text.matchAll(WIKILINK)) {
        const title = match[1].trim();
        if (title) titles.add(title);
      }
    }
    return false;
  });
  return [...titles];
}

/**
 * Turns each `[[Title]]` in the plain text of `blocks` whose page `pageOf` knows into a mention of
 * it, keeping the text's styles around it. Changes `blocks` in place; returns how many it linked.
 */
export function linkWikilinks(blocks: unknown[], pageOf: (title: string) => string | undefined): number {
  let linked = 0;
  someInlineContent(blocks, (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isPlainText(node)) continue;
      const pieces: unknown[] = [];
      let at = 0;
      for (const match of node.text.matchAll(WIKILINK)) {
        const pageId = pageOf(match[1]);
        if (!pageId) continue;
        if (match.index > at) pieces.push({ ...node, text: node.text.slice(at, match.index) });
        pieces.push({ type: MENTION, props: { ...EMPTY_MENTION, kind: "page", pageId } });
        at = match.index + match[0].length;
        linked++;
      }
      if (!pieces.length) continue;
      if (at < node.text.length) pieces.push({ ...node, text: node.text.slice(at) });
      nodes.splice(i, 1, ...pieces);
      i += pieces.length - 1;
    }
    return false;
  });
  return linked;
}
