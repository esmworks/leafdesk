/**
 * Links shown as mentions (lib/mentions, kind "link"): where they go, what they read as, their
 * Markdown, and turning them back into mentions when Markdown is written back into a page. Apart
 * from lib/mentions, which every workspace route loads, so only what draws or writes them loads
 * this.
 */

import { eachMention, MENTION, type AnyBlock, type MentionProps } from "./mentions";
import { displayHost, markdownLinkDestination, markdownLinkText, parseWebUrl } from "./web-url";

/** The address a link mention opens: its URL when that is a web address (http or https), else null. */
export const linkMentionHref = (props: Pick<MentionProps, "url">): string | null => parseWebUrl(props.url)?.href ?? null;

/** What a link mention reads as: the page's title, or the site's address until it has one. */
export const linkMentionTitle = (props: Pick<MentionProps, "url" | "title">): string =>
  props.title.replace(/\s+/g, " ").trim() || displayHost(props.url) || props.url.trim();

/** A link mention's Markdown: a link with its title as the text; one without a web address writes nothing. */
export function linkMentionMarkdown(props: Pick<MentionProps, "url" | "title">): string {
  const href = linkMentionHref(props);
  return href ? `[${markdownLinkText(linkMentionTitle(props))}](${markdownLinkDestination(href)})` : "";
}

type LinkInline = { type?: string; href?: unknown; content?: unknown; text?: unknown };

const linkText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as LinkInline[]).map((n) => (typeof n?.text === "string" ? n.text : linkText(n?.content))).join("")
      : "";

/**
 * Markdown written back into a page turns its link mentions into links, `[Title](url)`. This turns
 * each link with the URL and text of one of the page's link mentions back into that mention, with
 * the details it had, in order and each mention once. Other links stay links. Changes `blocks` in
 * place.
 */
export function restoreLinkMentions(blocks: AnyBlock[], existing: AnyBlock[]) {
  const available: { key: string; props: MentionProps }[] = [];
  eachMention(existing, (m) => {
    const href = m.kind === "link" ? linkMentionHref(m) : null;
    if (href) available.push({ key: `${href}\n${linkMentionTitle(m)}`, props: m });
  });
  if (!available.length) return;
  const swap = (content: unknown) => {
    if (!Array.isArray(content)) return;
    content.forEach((node: LinkInline, i) => {
      if (node?.type !== "link") return;
      const href = parseWebUrl(node.href)?.href;
      const key = href ? `${href}\n${linkText(node.content).replace(/\s+/g, " ").trim()}` : null;
      const at = key ? available.findIndex((a) => a.key === key) : -1;
      if (at < 0) return;
      const [match] = available.splice(at, 1);
      content[i] = { type: MENTION, props: { ...match.props } };
    });
  };
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      const table = block.content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
      if (table && typeof table === "object" && !Array.isArray(table) && table.type === "tableContent") {
        for (const row of table.rows ?? []) for (const cell of row.cells ?? []) swap(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content);
      } else swap(block.content);
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
}
