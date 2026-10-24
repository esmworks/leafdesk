/**
 * Mentions and page links in page bodies: an `@` mention of a person, a page or a date inside a
 * line of text, a link shown as a mention (the site's icon, the page's title and the site's name), a "Link to page" block, and a synced page block (another page's body shown live).
 *
 * Like the other custom content (lib/content-blocks, lib/embed-blocks), the configs here are shared
 * by the editor (React specs, components/page/mentions.tsx) and the server (server/blocknote.ts):
 * both schemas must know them, or the side that doesn't drops them for everyone.
 *
 * What is stored is only ids (and, for people, the name they had when mentioned). A page mention
 * never stores the page's title: readers see its live title when they may view the page, "No
 * access" when they may not, so a title never leaks through a mention.
 *
 * Markdown (derived for search and history, read and written by MCP, exported):
 *
 *   [Roadmap](/w/<workspace>/p/<page>)     a page mention: a link to the page. Any link to a page of
 *                                          this app becomes a mention; its text is ignored on the
 *                                          way in (the stored Markdown writes "page", readers get the
 *                                          live title, see labelPageLinks in server/mentions.ts).
 *   [Roadmap](/w/<ws>/p/<page>#block-<id>) a mention of one block of the page: it opens the page at
 *                                          that block (still a link to the page, for backlinks).
 *   [Roadmap](/w/<ws>/p/<page>) <!-- leafdesk:page-link -->
 *                                          a "Link to page" block: that link alone on its line,
 *                                          followed by the marker.
 *   [Roadmap](/w/<ws>/p/<page>) <!-- leafdesk:synced-page -->
 *                                          a synced page block: likewise, with its own marker. The
 *                                          page's body is never written into the Markdown of the
 *                                          page showing it (it is that page's own to index).
 *   @Ada Lovelace                          a person: "@" and their name as the workspace knows it.
 *   @2026-10-01                            a date (ISO 8601). A reminder set on a date stays with it
 *                                          when the Markdown is written back; it is set in the editor.
 *   [Title](https://example.com/a)         a link mention: an ordinary link with the title as its
 *                                          text. Written back into the page, a link with the URL and
 *                                          text of one of its link mentions becomes that mention
 *                                          again (restoreLinkMentions); any other link stays a link.
 */

import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "./collab-constants";
import { displayHost, markdownLinkDestination, markdownLinkText, parseWebUrl } from "./web-blocks";

export const MENTION = "mention";
export const PAGE_LINK_BLOCK = "pageLink";
export const PAGE_LINK_MARKER = "<!-- leafdesk:page-link -->";
export const SYNCED_PAGE_BLOCK = "syncedPage";
export const SYNCED_PAGE_MARKER = "<!-- leafdesk:synced-page -->";

export type MentionKind = "user" | "page" | "date" | "link";

/**
 * - `id`: this mention, for people and dates. A person hears about a mention once (the server keeps
 *   the ids it has notified about), and a date's reminder is keyed by it.
 * - `userId` / `name`: the person, and their name when mentioned (Markdown; shown if they left).
 * - `pageId`: the page. `blockId`: a block of it the mention opens the page at, or "".
 * - `date`: YYYY-MM-DD. `remindAt`: an ISO instant, or "" for no reminder. The reminder goes to
 *   whoever set it (the server records who, see server/mentions.ts).
 * - `url`: a link mention's address (http or https). `title`, `favicon` and `siteName`: the
 *   linked page's details, fetched once like a bookmark's (server/link-preview.ts) and stored, so
 *   showing the mention fetches nothing but the icon. `fetchedAt`: when, or "" until then.
 */
export const mentionConfig = {
  type: MENTION,
  propSchema: {
    kind: { default: "page", values: ["user", "page", "date", "link"] },
    id: { default: "" },
    userId: { default: "" },
    name: { default: "" },
    pageId: { default: "" },
    blockId: { default: "" },
    date: { default: "" },
    remindAt: { default: "" },
    url: { default: "" },
    title: { default: "" },
    favicon: { default: "" },
    siteName: { default: "" },
    fetchedAt: { default: "" },
  },
  content: "none",
} as const;

/** A "Link to page" block: the page's live icon and title on a line of their own (`blockId` as for mentions). */
export const pageLinkBlockConfig = {
  type: PAGE_LINK_BLOCK,
  propSchema: { pageId: { default: "" }, blockId: { default: "" } },
  content: "none",
} as const;

/**
 * A synced page: another page's body, shown and edited in place (components/page/synced-page.tsx).
 * Only the page's id is stored; what a reader sees follows their own access to that page.
 */
export const syncedPageBlockConfig = {
  type: SYNCED_PAGE_BLOCK,
  propSchema: { pageId: { default: "" } },
  content: "none",
} as const;

/** Blocks that stand for a whole page: "Link to page" blocks and synced pages. */
export const isPageBlockType = (type: unknown) => type === PAGE_LINK_BLOCK || type === SYNCED_PAGE_BLOCK;

export type MentionProps = {
  kind: MentionKind;
  id: string;
  userId: string;
  name: string;
  pageId: string;
  blockId: string;
  date: string;
  remindAt: string;
  url: string;
  title: string;
  favicon: string;
  siteName: string;
  fetchedAt: string;
};

export const EMPTY_MENTION: MentionProps = {
  kind: "page",
  id: "",
  userId: "",
  name: "",
  pageId: "",
  blockId: "",
  date: "",
  remindAt: "",
  url: "",
  title: "",
  favicon: "",
  siteName: "",
  fetchedAt: "",
};

export const newMentionId = () => crypto.randomUUID();

export const pagePath = (workspaceId: string, pageId: string) => `/w/${workspaceId}/p/${pageId}`;

/** A block of a page: the page's editor scrolls to it and highlights it (components/page/block-focus). */
export const blockPath = (workspaceId: string, pageId: string, blockId: string) => `${pagePath(workspaceId, pageId)}#block-${blockId}`;

/** A block id as links carry it: what BlockNote makes (a UUID), and nothing that needs escaping. */
const BLOCK_ID = /^[\w-]{1,100}$/;

export const isBlockId = (value: unknown): value is string => typeof value === "string" && BLOCK_ID.test(value);

/** The block an address's fragment (`#block-<id>`) points at, or null. */
export function blockIdOfHash(hash: string): string | null {
  const match = /^#block-(.+)$/.exec(hash);
  return match && isBlockId(match[1]) ? match[1] : null;
}

/** A page's address, at one of its blocks when `blockId` is set. */
export const pageOrBlockPath = (workspaceId: string, pageId: string, blockId?: string | null) =>
  blockId && isBlockId(blockId) ? blockPath(workspaceId, pageId, blockId) : pagePath(workspaceId, pageId);

const ID = "[\\w-]{1,128}";

/**
 * The page a link points at when it is a link to a page of this app (a path like the app's own,
 * `/w/<workspace>/p/<page>`, relative or on the app's origin), and the block its `#block-<id>`
 * points at ("" without one). Null for anything else.
 */
export function linkedPageRef(href: unknown, appUrl?: string): { pageId: string; blockId: string } | null {
  if (typeof href !== "string") return null;
  let value = href.trim();
  if (appUrl) {
    const origin = appUrl.replace(/\/+$/, "");
    if (value.toLowerCase().startsWith(origin.toLowerCase() + "/")) value = value.slice(origin.length);
  }
  const match = new RegExp(`^/w/${ID}/p/(${ID})/?(?:\\?[^#]*)?(#.*)?$`).exec(value);
  if (!match) return null;
  return { pageId: match[1], blockId: (match[2] && blockIdOfHash(match[2])) || "" };
}

/** The page of a link to a page of this app (see linkedPageRef), or null. */
export function linkedPageId(href: unknown, appUrl?: string): string | null {
  return linkedPageRef(href, appUrl)?.pageId ?? null;
}

/** Whether `value` is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A mention's props with every field present (BlockNote leaves out none, but stored data may). */
export function mentionProps(props: unknown): MentionProps {
  const p = (props && typeof props === "object" ? props : {}) as Record<string, unknown>;
  const str = (key: keyof MentionProps) => (typeof p[key] === "string" ? (p[key] as string) : "");
  const kind = p.kind === "user" || p.kind === "date" || p.kind === "link" ? p.kind : "page";
  const blockId = isBlockId(p.blockId) ? p.blockId : "";
  return {
    kind,
    id: str("id"),
    userId: str("userId"),
    name: str("name"),
    pageId: str("pageId"),
    blockId,
    date: str("date"),
    remindAt: str("remindAt"),
    url: str("url"),
    title: str("title"),
    favicon: str("favicon"),
    siteName: str("siteName"),
    fetchedAt: str("fetchedAt"),
  };
}

/** The address a link mention opens: its URL when that is a web address (http or https), else null. */
export const linkMentionHref = (props: Pick<MentionProps, "url">): string | null => parseWebUrl(props.url)?.href ?? null;

/** What a link mention reads as: the page's title, or the site's address until it has one. */
export const linkMentionTitle = (props: Pick<MentionProps, "url" | "title">): string =>
  props.title.replace(/\s+/g, " ").trim() || displayHost(props.url) || props.url.trim();

/**
 * Markdown text of a person, date or link mention (page mentions are links, written by the caller).
 * A link mention is a link with its title as the text; one without a web address writes nothing.
 */
export function mentionText(props: MentionProps): string {
  if (props.kind === "user") return `@${props.name.trim() || "someone"}`;
  if (props.kind === "date") return `@${props.date}`;
  if (props.kind === "link") {
    const href = linkMentionHref(props);
    return href ? `[${markdownLinkText(linkMentionTitle(props))}](${markdownLinkDestination(href)})` : "";
  }
  return "";
}

/**
 * Plain text of a mention, for search: people, dates and the titles of links (a page's title is not
 * the page's to show).
 */
export function mentionPlainText(props: unknown): string {
  const p = mentionProps(props);
  if (p.kind === "link") return linkMentionHref(p) ? linkMentionTitle(p) : "";
  return p.kind === "page" ? "" : mentionText(p);
}

/**
 * Markdown link to a page (at one of its blocks when `blockId` is set), as mentions and page links
 * are written. Brackets in the text are escaped.
 */
export function pageLinkMarkdown(text: string, workspaceId: string, pageId: string, blockId?: string | null) {
  return `[${text.replace(/[[\]\\]/g, "\\$&")}](${pageOrBlockPath(workspaceId, pageId, blockId)})`;
}

// ---------------------------------------------------------------------------------------------
// Reading "@…" in text

export type MentionPerson = { id: string; name: string };

type Piece = { text: string } | { mention: MentionProps };

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Splits text at the `@` mentions it holds: `@YYYY-MM-DD` dates and `@Name` for the given people
 * (the longest name that matches, ignoring case). An "@" inside a word (an email address) or
 * followed by anything else stays text.
 */
export function splitMentionText(text: string, people: MentionPerson[]): Piece[] {
  if (!text.includes("@")) return [{ text }];
  const named = people
    .filter((p) => p.name.trim())
    .map((p) => ({ ...p, key: p.name.trim().toLocaleLowerCase() }))
    .sort((a, b) => b.key.length - a.key.length);
  const out: Piece[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char !== "@" || (i > 0 && (WORD.test(text[i - 1]) || text[i - 1] === "@" || text[i - 1] === "."))) {
      plain += char;
      i++;
      continue;
    }
    const rest = text.slice(i + 1);
    const date = /^(\d{4}-\d{2}-\d{2})(?![\p{L}\p{N}_-])/u.exec(rest);
    let found: { mention: MentionProps; length: number } | null = null;
    if (date && isIsoDate(date[1])) {
      found = { mention: { ...EMPTY_MENTION, kind: "date", date: date[1] }, length: 1 + date[1].length };
    } else {
      const lower = rest.toLocaleLowerCase();
      for (const person of named) {
        if (!lower.startsWith(person.key)) continue;
        const after = rest[person.name.trim().length];
        if (after !== undefined && WORD.test(after)) continue;
        found = {
          mention: { ...EMPTY_MENTION, kind: "user", userId: person.id, name: person.name.trim() },
          length: 1 + person.name.trim().length,
        };
        break;
      }
    }
    if (!found) {
      plain += char;
      i++;
      continue;
    }
    if (plain) out.push({ text: plain });
    plain = "";
    out.push({ mention: found.mention });
    i += found.length;
  }
  if (plain) out.push({ text: plain });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Walking block trees

type AnyInline = { type?: string; props?: unknown; content?: unknown };
type AnyBlock = { type?: string; props?: unknown; content?: unknown; children?: AnyBlock[] };

function eachInline(content: unknown, fn: (node: AnyInline) => void) {
  if (Array.isArray(content)) {
    for (const node of content as AnyInline[]) {
      if (!node || typeof node !== "object") continue;
      fn(node);
      if (node.type === "link") eachInline(node.content, fn);
    }
    return;
  }
  const table = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
  if (table && typeof table === "object" && table.type === "tableContent" && Array.isArray(table.rows)) {
    for (const row of table.rows) {
      for (const cell of row.cells ?? []) {
        eachInline(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content, fn);
      }
    }
  }
}

/** Calls `fn` with every mention's props in a block tree, in document order. */
export function eachMention(blocks: AnyBlock[], fn: (props: MentionProps, node: AnyInline) => void) {
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      eachInline(block.content, (node) => {
        if (node.type === MENTION) fn(mentionProps(node.props), node);
      });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
}

export type BodyReferences = {
  /** Pages the body links to: page mentions, "Link to page" blocks and synced pages. */
  pageIds: string[];
  /** Person mentions: `key` is the mention's id (or, for one without, the person). */
  people: { key: string; userId: string }[];
  /** Dates with a reminder. */
  reminders: { key: string; date: string; remindAt: string }[];
};

/** What a page body points at, for backlinks, mention notifications and reminders. */
export function bodyReferences(blocks: AnyBlock[]): BodyReferences {
  const pageIds = new Set<string>();
  const people = new Map<string, string>();
  const reminders = new Map<string, { date: string; remindAt: string }>();
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      if (isPageBlockType(block.type)) {
        const pageId = (block.props as { pageId?: unknown } | undefined)?.pageId;
        if (typeof pageId === "string" && pageId) pageIds.add(pageId);
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  eachMention(blocks, (m) => {
    if (m.kind === "page" && m.pageId) pageIds.add(m.pageId);
    if (m.kind === "user" && m.userId) {
      const key = m.id || `user:${m.userId}`;
      if (!people.has(key)) people.set(key, m.userId);
    }
    if (m.kind === "date" && m.id && isIsoDate(m.date) && m.remindAt && !Number.isNaN(Date.parse(m.remindAt))) {
      if (!reminders.has(m.id)) reminders.set(m.id, { date: m.date, remindAt: new Date(m.remindAt).toISOString() });
    }
  });
  return {
    pageIds: [...pageIds],
    people: [...people].map(([key, userId]) => ({ key, userId })),
    reminders: [...reminders].map(([key, r]) => ({ key, ...r })),
  };
}

/**
 * Gives person and date mentions written from Markdown the identity of the ones the page already
 * had: the n-th mention of a person (or date) takes the id (and reminder) of the n-th one before.
 * So writing a page's Markdown back doesn't notify people again or drop reminders. Mentions without
 * a counterpart get a fresh id. Changes `blocks` in place.
 */
export function carryOverMentions(blocks: AnyBlock[], existing: AnyBlock[]) {
  const queues = new Map<string, MentionProps[]>();
  const keyOf = (m: MentionProps) => (m.kind === "user" ? `user:${m.userId}` : m.kind === "date" ? `date:${m.date}` : null);
  eachMention(existing, (m) => {
    const key = keyOf(m);
    if (!key || !m.id) return;
    queues.set(key, [...(queues.get(key) ?? []), m]);
  });
  eachMention(blocks, (m, node) => {
    const key = keyOf(m);
    if (!key) return;
    const before = queues.get(key)?.shift();
    const props = node.props as Record<string, unknown>;
    props.id = m.id || before?.id || newMentionId();
    if (m.kind === "date" && !m.remindAt && before?.remindAt) props.remindAt = before.remindAt;
  });
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

// ---------------------------------------------------------------------------------------------
// Copies

/**
 * Drops the reminders of a page document's date mentions: a copy of a page (or a page made from a
 * template) starts without them, since a reminder belongs to the person who set it on that page.
 * Returns whether anything changed.
 */
export function stripReminders(doc: Y.Doc): boolean {
  let changed = false;
  doc.transact(() => {
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === MENTION && child.getAttribute("remindAt")) {
          child.setAttribute("remindAt", "");
          changed = true;
        }
        walk(child);
      }
    };
    walk(doc.getXmlFragment(COLLAB_FRAGMENT));
  });
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Showing dates

/**
 * A YYYY-MM-DD date as `locale` writes it ("Oct 1, 2026"): the date itself, whatever the time zone.
 * A time (an ISO timestamp, as a timed date property's reminder holds) is written with its time,
 * in `timeZone` and naming it when given, else in the runtime's (the viewer's in the browser).
 */
export function formatIsoDate(date: string, locale: string, style: "medium" | "long" = "medium", timeZone?: string) {
  if (!isIsoDate(date)) {
    const at = /^\d{4}-\d{2}-\d{2}T/.test(date) ? Date.parse(date) : NaN;
    if (Number.isNaN(at)) return date;
    const zone: Intl.DateTimeFormatOptions = timeZone ? { timeZone, timeZoneName: "short" } : {};
    const month = style === "long" ? "long" : "short";
    return new Intl.DateTimeFormat(locale, { year: "numeric", month, day: "numeric", hour: "numeric", minute: "2-digit", ...zone }).format(
      new Date(at),
    );
  }
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Today (or `days` from today) in the local time zone, as YYYY-MM-DD. */
export function localIsoDate(days = 0, now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The instant `daysBefore` days before `date` at `hour`:00 in the local time zone, as ISO. */
export function localReminderAt(date: string, daysBefore: number, hour = 9) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d - daysBefore, hour, 0, 0, 0).toISOString();
}

const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A link to a page of this app in Markdown, `[text](/w/<workspace>/p/<page>)` or one of its blocks,
 * `[text](/w/<workspace>/p/<page>#block-<id>)`: text, path, page id and the fragment (`#block-…`,
 * or undefined).
 */
export const MARKDOWN_PAGE_LINK = /\[((?:[^\]\\\n]|\\.)*)\]\(\s*<?(\/w\/[\w-]{1,128}\/p\/([\w-]{1,128}))(#block-[\w-]{1,100})?>?\s*\)/g;

/** For each of the Markdown's lines, whether it is fenced code (the fences themselves included). */
export function fencedLines(lines: string[]): boolean[] {
  const code: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = MARKDOWN_FENCE.exec(line);
    if (fence) {
      code.push(true);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[0].trim().length)) fence = null;
      continue;
    }
    if (open) fence = open[1];
    code.push(Boolean(open));
  }
  return code;
}

/** The pages Markdown mentions or links to outside fenced code, each once, in the order they come. */
export function markdownPageIds(markdown: string): string[] {
  if (!markdown.includes("/p/")) return [];
  const lines = markdown.split("\n");
  const code = fencedLines(lines);
  const ids = new Set<string>();
  lines.forEach((line, i) => {
    if (!code[i]) for (const match of line.matchAll(MARKDOWN_PAGE_LINK)) ids.add(match[3]);
  });
  return [...ids];
}
