/**
 * Mentions and page links in page bodies: an `@` mention of a person, a page or a date inside a
 * line of text, and a "Link to page" block.
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
 *   [Roadmap](/w/<ws>/p/<page>) <!-- leafdesk:page-link -->
 *                                          a "Link to page" block: that link alone on its line,
 *                                          followed by the marker.
 *   @Ada Lovelace                          a person: "@" and their name as the workspace knows it.
 *   @2026-10-01                            a date (ISO 8601). A reminder set on a date stays with it
 *                                          when the Markdown is written back; it is set in the editor.
 */

import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "./collab-constants";

export const MENTION = "mention";
export const PAGE_LINK_BLOCK = "pageLink";
export const PAGE_LINK_MARKER = "<!-- leafdesk:page-link -->";

export type MentionKind = "user" | "page" | "date";

/**
 * - `id`: this mention, for people and dates. A person hears about a mention once (the server keeps
 *   the ids it has notified about), and a date's reminder is keyed by it.
 * - `userId` / `name`: the person, and their name when mentioned (Markdown; shown if they left).
 * - `pageId`: the page.
 * - `date`: YYYY-MM-DD. `remindAt`: an ISO instant, or "" for no reminder. The reminder goes to
 *   whoever set it (the server records who, see server/mentions.ts).
 */
export const mentionConfig = {
  type: MENTION,
  propSchema: {
    kind: { default: "page", values: ["user", "page", "date"] },
    id: { default: "" },
    userId: { default: "" },
    name: { default: "" },
    pageId: { default: "" },
    date: { default: "" },
    remindAt: { default: "" },
  },
  content: "none",
} as const;

/** A "Link to page" block: the page's live icon and title on a line of their own. */
export const pageLinkBlockConfig = {
  type: PAGE_LINK_BLOCK,
  propSchema: { pageId: { default: "" } },
  content: "none",
} as const;

export type MentionProps = {
  kind: MentionKind;
  id: string;
  userId: string;
  name: string;
  pageId: string;
  date: string;
  remindAt: string;
};

export const EMPTY_MENTION: MentionProps = { kind: "page", id: "", userId: "", name: "", pageId: "", date: "", remindAt: "" };

export const newMentionId = () => crypto.randomUUID();

export const pagePath = (workspaceId: string, pageId: string) => `/w/${workspaceId}/p/${pageId}`;

const ID = "[\\w-]{1,128}";

/**
 * The page a link points at when it is a link to a page of this app: a path like the app's own
 * (`/w/<workspace>/p/<page>`), relative or on the app's origin. Null for anything else.
 */
export function linkedPageId(href: unknown, appUrl?: string): string | null {
  if (typeof href !== "string") return null;
  let value = href.trim();
  if (appUrl) {
    const origin = appUrl.replace(/\/+$/, "");
    if (value.toLowerCase().startsWith(origin.toLowerCase() + "/")) value = value.slice(origin.length);
  }
  const match = new RegExp(`^/w/${ID}/p/(${ID})/?(?:[?#].*)?$`).exec(value);
  return match ? match[1] : null;
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
  const kind = p.kind === "user" || p.kind === "date" ? p.kind : "page";
  return { kind, id: str("id"), userId: str("userId"), name: str("name"), pageId: str("pageId"), date: str("date"), remindAt: str("remindAt") };
}

/** Markdown text of a person or date mention (page mentions are links, written by the caller). */
export function mentionText(props: MentionProps): string {
  if (props.kind === "user") return `@${props.name.trim() || "someone"}`;
  if (props.kind === "date") return `@${props.date}`;
  return "";
}

/** Plain text of a mention, for search: people and dates only (a page's title is not the page's to show). */
export function mentionPlainText(props: unknown): string {
  const p = mentionProps(props);
  return p.kind === "page" ? "" : mentionText(p);
}

/** Markdown link to a page, as mentions and page links are written. Brackets in the text are escaped. */
export function pageLinkMarkdown(text: string, workspaceId: string, pageId: string) {
  return `[${text.replace(/[[\]\\]/g, "\\$&")}](${pagePath(workspaceId, pageId)})`;
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
  /** Pages the body links to: page mentions and "Link to page" blocks. */
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
      if (block.type === PAGE_LINK_BLOCK) {
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
