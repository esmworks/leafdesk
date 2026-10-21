import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { highlightCode } from "@/lib/code-highlighter";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { COLUMN_BLOCK, COLUMN_LIST_BLOCK, columnWidth } from "@/lib/columns";
import { applyCalloutStyles, findCalloutStyle, type CalloutStyle } from "@/lib/callout-styles";
import { BREADCRUMB_BLOCK, CALLOUT_BLOCK, MERMAID_BLOCK, SUBPAGES_BLOCK, TOC_BLOCK } from "@/lib/content-blocks";
import { plainText } from "@/lib/content-markdown";
import { AGENT_CHAT_BLOCK } from "@/lib/agent-chat";
import { DASHBOARD_BLOCK, parseDashboard, type DashboardWidget } from "@/lib/dashboard";
import { isEmbedBlockType, parseLinkedView, type EmbedBlockType, type LinkedView } from "@/lib/embed-blocks";
import { pdfFileId, spreadsheetFileId } from "@/lib/files";
import { BOOKMARK_BLOCK, embedFor, isWebBlockType, parseWebUrl, type EmbedTarget } from "@/lib/web-blocks";
import { bodyReferences, isBlockId, isPageBlockType, MENTION, mentionPlainText, mentionProps, PAGE_LINK_BLOCK } from "@/lib/mentions";
import { withoutSyncedBlocks } from "@/lib/synced-blocks";
import { serverEditor as editor, type PageBlock } from "@/server/blocknote";

/**
 * Turns a stored page body (Yjs state) into HTML for the public, read-only view of a published page.
 *
 * The HTML comes from BlockNote's own serializer (ProseMirror → DOM → string), so text and
 * attribute values are escaped by the DOM serializer; nothing from the document is passed through
 * as raw HTML. Links and media URLs are still whatever an editor typed, so `sanitizeBlocks` keeps
 * only http(s)/mailto links and http(s) or same-origin media before serializing.
 *
 * Database blocks are not serialized: the body comes back as HTML parts with the database blocks
 * between them, and the publication decides for each whether its database may be shown. Tables of
 * contents, breadcrumbs and Mermaid diagrams come back between the parts too, for the page to
 * draw, and so do bookmarks and embeds (an iframe only for an allowlisted provider, see
 * lib/web-blocks), and uploaded PDFs, which the page shows in place. Equations are serialized: KaTeX builds them on the server (see server/blocknote.ts).
 * Code blocks are colored here too, the way the editor colors them (see lib/code-highlighter).
 * Columns come back as a segment holding each column's own segments, so everything above works
 * inside them too. Footnotes are numbered in the order the page has them, columns included, and
 * their notes come back as a last segment (see withFootnotes). Blocks with text carry an anchor, so a link to one block (`#block-<id>`) opens
 * the page there (see withBlockAnchors).
 */

type Json = unknown;

const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_MEDIA = /^https?:/i;

export function isSafeLink(href: unknown): href is string {
  return typeof href === "string" && SAFE_LINK.test(href.trim());
}

export function isSafeMediaUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const value = url.trim();
  // Same-origin absolute paths are fine; "//host" is protocol-relative, i.e. another origin, and
  // browsers read "/\host" the same way.
  return SAFE_MEDIA.test(value) || /^\/(?![/\\])/.test(value);
}

/** Inline content: unsafe links become their plain text; everything else is walked. */
function sanitizeInline(items: Json[]): Json[] {
  const out: Json[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const node = item as Record<string, Json>;
      if (node.type === "link") {
        const content = Array.isArray(node.content) ? sanitizeInline(node.content) : [];
        if (isSafeLink(node.href)) out.push({ ...node, href: String(node.href).trim(), content });
        else out.push(...content);
        continue;
      }
      out.push(sanitizeValue(node));
      continue;
    }
    // A table cell of the older form is a list of inline content of its own.
    out.push(Array.isArray(item) ? sanitizeInline(item) : item);
  }
  return out;
}

function sanitizeValue(value: Json): Json {
  if (Array.isArray(value)) return sanitizeInline(value);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, Json>;
  const next: Record<string, Json> = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "props" && child && typeof child === "object" && !Array.isArray(child)) {
      const props = { ...(child as Record<string, Json>) };
      if ("url" in props && !isSafeMediaUrl(props.url)) props.url = "";
      next[key] = props;
    } else {
      next[key] = sanitizeValue(child);
    }
  }
  return next;
}

/** A copy of the block tree with unsafe links unwrapped and unsafe media URLs cleared. */
export function sanitizeBlocks<T>(blocks: T[]): T[] {
  return blocks.map((block) => sanitizeValue(block) as T);
}

/**
 * How a published page shows a page it mentions or links to: `text` (its title, or a note that
 * names nothing) and, when that page is published too, where it is. The publication decides (see
 * server/publication.ts); without a decision a page is left out.
 */
export type PublishedPageRef = { text: string; href: string | null };

const textNode = (text: string) => ({ type: "text", text, styles: {} });

/** The page as a link where it is published (at `blockId` when set, see withBlockAnchors), else its text. */
function pageRefInline(ref: PublishedPageRef | undefined, blockId = ""): Json[] {
  if (!ref) return [];
  if (!ref.href) return [textNode(ref.text)];
  const href = blockId && isBlockId(blockId) ? `${ref.href}#block-${blockId}` : ref.href;
  return [{ type: "link", href, content: [textNode(ref.text)] }];
}

function resolveInline(content: Json, refs: Map<string, PublishedPageRef>): Json {
  if (Array.isArray(content)) {
    return content.flatMap((item): Json[] => {
      const node = item as Record<string, Json> | null;
      if (node?.type !== MENTION) return [item];
      const props = mentionProps(node.props);
      if (props.kind === "page") return pageRefInline(refs.get(props.pageId), props.blockId);
      return [textNode(mentionPlainText(props))];
    });
  }
  const table = content as { type?: string; rows?: { cells?: Json[] }[] } | null;
  if (table?.type === "tableContent" && Array.isArray(table.rows)) {
    return {
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        cells: (row.cells ?? []).map((cell) =>
          Array.isArray(cell) ? resolveInline(cell, refs) : cell && typeof cell === "object" ? { ...cell, content: resolveInline((cell as { content?: Json }).content, refs) } : cell,
        ),
      })),
    };
  }
  return content;
}

/**
 * Mentions as plain text or links, and "Link to page" blocks as a line holding one, as `refs`
 * allows (runs after sanitizeBlocks: these links are the publication's own). Synced pages read the
 * same as "Link to page" blocks: the other page's body is that page's to publish, not this one's.
 */
function resolveMentions(blocks: PageBlock[], refs: Map<string, PublishedPageRef>): PageBlock[] {
  return blocks.map((block) => {
    const children = block.children?.length ? resolveMentions(block.children, refs) : block.children;
    if (isPageBlockType(block.type)) {
      const { pageId, blockId } = block.props as { pageId?: unknown; blockId?: unknown };
      // A "Link to page" block may point at a block of the page; a synced page is the whole page.
      const at = block.type === PAGE_LINK_BLOCK && typeof blockId === "string" ? blockId : "";
      const content = pageRefInline(refs.get(String(pageId ?? "")), at);
      return { id: block.id, type: "paragraph", props: {}, content, children } as unknown as PageBlock;
    }
    return { ...block, content: resolveInline(block.content as Json, refs), children } as PageBlock;
  });
}

/**
 * BlockNote's HTML export fills a block without text (an empty line, an empty heading) with an
 * object replacement character, which browsers draw as a box. A line break keeps the empty line.
 */
function emptyLinesAsBreaks(html: string): string {
  return html.replaceAll("\uFFFC", "<br>");
}

/** A heading of the page, for a table of contents: `anchor` is the id its HTML heading carries. */
export type BodyHeading = { anchor: string; level: number; text: string };

/**
 * A run of ordinary blocks as HTML, or a block the page draws itself at that point: a database, a
 * table of contents (with every heading of the page), a breadcrumb, the page's subpages or a
 * Mermaid diagram (drawn in the visitor's browser, see components/published).
 */
export type BodySegment =
  | { kind: "html"; html: string }
  | { kind: "embed"; type: EmbedBlockType; databaseId: string; view: LinkedView | null }
  /** A dashboard's widgets, each a database seen through its own view. */
  | { kind: "dashboard"; widgets: DashboardWidget[] }
  | { kind: "toc"; headings: BodyHeading[] }
  | { kind: "breadcrumb" }
  | { kind: "subpages" }
  | { kind: "mermaid"; source: string }
  /** An agent chat block: chats happen in the app only, so it says just that (naming no agent). */
  | { kind: "agentChat" }
  | { kind: "bookmark"; bookmark: PublishedBookmark }
  /** An embed of an allowlisted provider; any other URL comes back as a bookmark. */
  | { kind: "webEmbed"; url: string; embed: EmbedTarget }
  /** A file block holding an uploaded PDF, shown in place (see components/page/pdf-viewer.tsx). */
  | { kind: "pdf"; fileId: string; name: string; caption: string }
  /** A file block holding an uploaded Excel workbook, its cells shown in place (see components/page/spreadsheet-viewer.tsx). */
  | { kind: "spreadsheet"; fileId: string; name: string; caption: string }
  /** Columns side by side (stacked on narrow screens), each with its own segments. */
  | { kind: "columns"; columns: PublishedColumn<BodySegment>[] }
  /** The notes of the body's footnotes, in order: always the last segment, and only when there are some. */
  | { kind: "footnotes"; notes: BodyFootnote[] };

/**
 * A footnote of the body: its note, the id of its number in the text (`refAnchor`) and the id of
 * the note in the list (`anchor`), which link to each other.
 */
export type BodyFootnote = { anchor: string; refAnchor: string; text: string };

/** A column of a published page: its share of the row (see lib/columns) and what it shows. */
export type PublishedColumn<S> = { width: number; segments: S[] };

/** A bookmark card's details, every URL checked to be http(s). */
export type PublishedBookmark = { url: string; title: string; description: string; image: string; favicon: string; siteName: string };

/**
 * The uploaded file a file block shows in place, if it holds one: a PDF or an Excel workbook (see
 * lib/files pdfFileId and spreadsheetFileId).
 */
function inPlaceFileOf(block: PageBlock): { kind: "pdf" | "spreadsheet"; fileId: string } | null {
  if (block.type !== "file") return null;
  const props = block.props as { url?: unknown; name?: unknown };
  const pdf = pdfFileId(props.url, props.name);
  if (pdf) return { kind: "pdf", fileId: pdf };
  const spreadsheet = spreadsheetFileId(props.url, props.name);
  return spreadsheet ? { kind: "spreadsheet", fileId: spreadsheet } : null;
}

const isStandalone = (block: PageBlock) =>
  block.type === COLUMN_LIST_BLOCK ||
  isEmbedBlockType(block.type) ||
  block.type === DASHBOARD_BLOCK ||
  isWebBlockType(block.type) ||
  block.type === TOC_BLOCK ||
  block.type === BREADCRUMB_BLOCK ||
  block.type === SUBPAGES_BLOCK ||
  block.type === MERMAID_BLOCK ||
  block.type === AGENT_CHAT_BLOCK ||
  inPlaceFileOf(block) !== null;

/** A bookmark or embed block as the published page draws it, or null when it has no valid URL. */
function webSegment(block: PageBlock): BodySegment | null {
  const props = block.props as Record<string, unknown>;
  const url = parseWebUrl(props.url)?.href;
  if (!url) return null;
  if (block.type !== BOOKMARK_BLOCK) {
    const embed = embedFor(url);
    if (embed) return { kind: "webEmbed", url, embed };
  }
  const text = (name: string) => (typeof props[name] === "string" ? (props[name] as string) : "");
  return {
    kind: "bookmark",
    bookmark: {
      url,
      title: text("title"),
      description: text("description"),
      image: parseWebUrl(props.image)?.href ?? "",
      favicon: parseWebUrl(props.favicon)?.href ?? "",
      siteName: text("siteName"),
    },
  };
}

/** A block drawn on its own nested in another block (e.g. under a list item) is shown after that block. */
function withoutNestedStandalone(block: PageBlock, found: PageBlock[]): PageBlock {
  if (!block.children?.length) return block;
  const children: PageBlock[] = [];
  for (const child of block.children) {
    if (isStandalone(child)) found.push(child);
    else children.push(withoutNestedStandalone(child, found));
  }
  return { ...block, children } as PageBlock;
}

/** Headings of a run of blocks in the order its HTML has them (each block, then its children). */
function runHeadings(blocks: PageBlock[], out: PageBlock[] = []): PageBlock[] {
  for (const block of blocks) {
    if (block.type === "heading") out.push(block);
    if (block.children?.length) runHeadings(block.children, out);
  }
  return out;
}

/**
 * Gives a run's heading elements their anchors (ours, "heading-3", nothing from the document). The
 * serialized run is parsed back into elements, the way a browser will read it, and each heading
 * element gets the next anchor: the n-th one is the run's n-th heading block (a toggle heading is
 * one element too, its nested headings after it). Attribute values keep whatever an editor typed,
 * "<h2" included, so the anchors are set on elements, never by searching the HTML text.
 */
async function withHeadingAnchors(html: string, anchors: string[]): Promise<string> {
  if (!anchors.length) return html;
  return editor._withJSDOM(async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((element, i) => {
      if (i >= anchors.length) return;
      // The id goes first, as in the HTML the page has always had.
      const attributes = [...element.attributes].filter((attribute) => attribute.name !== "id");
      for (const attribute of attributes) element.removeAttributeNode(attribute);
      element.setAttribute("id", anchors[i]);
      for (const attribute of attributes) element.setAttributeNode(attribute);
    });
    return container.innerHTML;
  });
}

/**
 * Blocks whose HTML holds their text as text: the ones a link can open the page at. Others (images,
 * files, equations) have no text to mark, or turn it into something else.
 */
const ANCHORED = new Set(["paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "codeBlock", "table", CALLOUT_BLOCK]);

const hasText = (content: Json): boolean =>
  typeof content === "string" ? content.length > 0 : Array.isArray(content) ? content.length > 0 : false;

/** `content` with `marker` as text before the rest, or null when it holds no text to put it with. */
function withMarker(content: Json, marker: string): Json | null {
  const text = { type: "text", text: marker, styles: {} };
  if (typeof content === "string") return content ? [text, { type: "text", text: content, styles: {} }] : null;
  if (Array.isArray(content)) return content.length ? [text, ...content] : null;
  const table = content as { type?: string; rows?: { cells?: Json[] }[] } | null;
  const first = table?.type === "tableContent" ? table.rows?.[0]?.cells?.[0] : undefined;
  if (!table || first === undefined) return null;
  const cell = Array.isArray(first) ? first : (first as { content?: Json } | null)?.content;
  if (!hasText(cell ?? null)) return null;
  const marked = withMarker(cell as Json, marker);
  const cells = [Array.isArray(first) ? marked : { ...(first as object), content: marked }, ...(table.rows![0].cells ?? []).slice(1)];
  return { ...table, rows: [{ ...table.rows![0], cells }, ...table.rows!.slice(1)] };
}

/**
 * Puts a marker before the text of each block in ANCHORED (nested ones too): `nonce`, the block's
 * place in `ids` and characters nobody types, for withBlockAnchors to find in the HTML. Blocks
 * without text get none: an empty line needs no anchor.
 */
function markBlocks(blocks: PageBlock[], nonce: string, ids: string[]): PageBlock[] {
  return blocks.map((block) => {
    const children = block.children?.length ? markBlocks(block.children, nonce, ids) : block.children;
    if (!ANCHORED.has(block.type) || !isBlockId(block.id)) return { ...block, children } as PageBlock;
    const content = withMarker(block.content as Json, `\uE000${nonce}:${ids.length}\uE001`);
    if (content === null) return { ...block, children } as PageBlock;
    ids.push(block.id);
    return { ...block, content, children } as PageBlock;
  });
}

/**
 * Turns markBlocks' markers into anchors: an empty `<span id="block-<id>">` where the block's text
 * starts (before the code in a code block, which withHighlightedCode rewrites), so the browser
 * scrolls to it and the stylesheet highlights the block. Like the heading anchors, set on parsed
 * elements: the ids are BlockNote's (checked by isBlockId), the markers ours.
 */
async function withBlockAnchors(html: string, nonce: string, ids: string[]): Promise<string> {
  if (!ids.length) return html;
  const marker = new RegExp(`\uE000${nonce}:(\\d+)\uE001`, "g");
  return editor._withJSDOM(async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const texts: Text[] = [];
    const collect = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) texts.push(child as Text);
        else collect(child);
      }
    };
    collect(container);
    for (const text of texts) {
      const value = text.data;
      if (!value.includes("\uE000")) continue;
      const parent = text.parentNode;
      if (!parent) continue;
      let last = 0;
      for (const match of value.matchAll(marker)) {
        if (match.index > last) parent.insertBefore(document.createTextNode(value.slice(last, match.index)), text);
        last = match.index + match[0].length;
        const id = ids[Number(match[1])];
        if (!id) continue;
        const anchor = document.createElement("span");
        anchor.setAttribute("id", `block-${id}`);
        anchor.setAttribute("class", "block-anchor");
        const code = text.parentElement?.closest("pre > code");
        if (code?.parentElement) code.parentElement.insertBefore(anchor, code);
        else parent.insertBefore(anchor, text);
      }
      if (last < value.length) parent.insertBefore(document.createTextNode(value.slice(last)), text);
      parent.removeChild(text);
    }
    return container.innerHTML;
  });
}

const SHIKI_COLOR = /^#[0-9a-f]{3,8}$/i;

/**
 * Colors the run's code blocks (`<pre><code data-language>`) in their language: the code's text is
 * replaced by spans of the same text, each with its light and dark color as CSS variables (the
 * stylesheet picks one, see globals.css). The text is set as text, never parsed,
 * and a color is only written when it is a hex color. Code in plain text or a language we don't
 * color stays as it is.
 */
/**
 * Numbers the footnotes of a run's HTML (the server writes each as an element holding its note, see
 * server/blocknote.ts), carrying on from `notes`: each becomes its number, linking to its note,
 * and the note goes into `notes`. A footnote without a note is left out, as the editor leaves it
 * unnumbered.
 */
async function withFootnotes(html: string, notes: BodyFootnote[], anchorPrefix: string): Promise<string> {
  if (!html.includes("data-leafdesk-footnote")) return html;
  return editor._withJSDOM(async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.querySelectorAll("[data-leafdesk-footnote]").forEach((element) => {
      const text = (element.textContent ?? "").trim();
      if (!text) {
        element.remove();
        return;
      }
      const n = notes.length + 1;
      const note = { anchor: `${anchorPrefix}footnote-${n}`, refAnchor: `${anchorPrefix}footnote-ref-${n}`, text };
      notes.push(note);
      const sup = document.createElement("sup");
      sup.setAttribute("id", note.refAnchor);
      sup.setAttribute("data-footnote-ref", "");
      const link = document.createElement("a");
      link.setAttribute("href", `#${note.anchor}`);
      link.setAttribute("title", text);
      link.textContent = String(n);
      sup.append(link);
      element.replaceWith(sup);
    });
    return container.innerHTML;
  });
}

/**
 * Gives the run's styled callouts their style's border (`data-callout-border`, which the
 * stylesheet draws): unlike their icon, color and title, a border isn't one of their props.
 */
async function withCalloutBorders(html: string, styles: readonly CalloutStyle[]): Promise<string> {
  if (!html.includes("data-style-key")) return html;
  return editor._withJSDOM(async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.querySelectorAll("[data-leafdesk-callout][data-style-key]").forEach((element) => {
      const border = findCalloutStyle(element.getAttribute("data-style-key"), styles)?.border;
      if (border && border !== "none") element.setAttribute("data-callout-border", border);
    });
    return container.innerHTML;
  });
}

async function withHighlightedCode(html: string): Promise<string> {
  if (!html.includes("<pre")) return html;
  const container = await editor._withJSDOM(async () => {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element;
  });
  const blocks = [...container.querySelectorAll("pre > code")];
  const colored = await Promise.all(blocks.map((code) => highlightCode(code.textContent ?? "", code.getAttribute("data-language"))));
  if (!colored.some(Boolean)) return html;
  // The elements belong to the editor's own DOM document; nothing below needs the global one.
  blocks.forEach((code, i) => {
    const lines = colored[i];
    if (!lines) return;
    code.replaceChildren();
    lines.forEach((tokens, n) => {
      if (n > 0) code.append("\n");
      for (const token of tokens) {
        const span = code.ownerDocument.createElement("span");
        span.textContent = token.text;
        const colors = [
          token.light && SHIKI_COLOR.test(token.light) ? `--shiki-light:${token.light}` : "",
          token.dark && SHIKI_COLOR.test(token.dark) ? `--shiki-dark:${token.dark}` : "",
        ].filter(Boolean);
        if (colors.length) span.setAttribute("style", colors.join(";"));
        code.append(span);
      }
    });
    code.classList.add("code-colors");
  });
  return container.innerHTML;
}

export type BodyOptions = {
  /** How to show the pages the body mentions or links to; without it they are left out. */
  resolvePages?: (pageIds: string[]) => Promise<Map<string, PublishedPageRef>>;
  /**
   * Put before every heading anchor (`heading-3` → `p2-heading-3`), so several bodies can share one
   * document (the print view with subpages) without their tables of contents mixing up. Callers
   * pass a fixed ASCII prefix of their own.
   */
  anchorPrefix?: string;
  /** Replaces synced blocks with what the reader may see of them (server/synced-blocks); without it they show nothing. */
  expandSynced?: (blocks: PageBlock[]) => Promise<PageBlock[]>;
  /** For the print view: callouts hidden in print are left out (with the blocks nested in them). */
  print?: boolean;
  /**
   * The page's workspace's callout styles (lib/callout-styles): styled callouts are drawn with
   * their style's look. Without them only the built-in styles are known, and other styled
   * callouts are drawn with their own props.
   */
  calloutStyles?: readonly CalloutStyle[];
};

/** The blocks without the callouts hidden in print, in columns and nested blocks too. */
function withoutHiddenInPrint(blocks: PageBlock[]): PageBlock[] {
  return blocks.flatMap((block): PageBlock[] => {
    if (block.type === CALLOUT_BLOCK && (block.props as { hideInPrint?: unknown }).hideInPrint === true) return [];
    return [block.children?.length ? ({ ...block, children: withoutHiddenInPrint(block.children) } as PageBlock) : block];
  });
}

export async function bodySegmentsFromYdoc(state: Uint8Array | null, options: BodyOptions = {}): Promise<BodySegment[]> {
  if (!state || state.byteLength === 0) return [];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return await bodySegmentsFromBlocks(editor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)), options);
  } finally {
    doc.destroy();
  }
}

/** The same for a body already read as blocks (from the live document, see collab `readBlocks`). */
export async function bodySegmentsFromBlocks(
  body: PageBlock[],
  { resolvePages, anchorPrefix = "", expandSynced, print = false, calloutStyles = [] }: BodyOptions = {},
): Promise<BodySegment[]> {
  const expanded = applyCalloutStyles(expandSynced ? await expandSynced(body) : withoutSyncedBlocks(body), calloutStyles);
  const blocks = print ? withoutHiddenInPrint(expanded) : expanded;
  const { pageIds } = bodyReferences(blocks);
  const refs = pageIds.length && resolvePages ? await resolvePages(pageIds) : new Map<string, PublishedPageRef>();
  // Every heading of the page, filled in as the runs are written; tables of contents share it.
  const headings: BodyHeading[] = [];
  // Every footnote of the page, numbered as the runs are written, columns included.
  const notes: BodyFootnote[] = [];
  /** The segments of a list of blocks: the body, or a column's blocks. */
  const segmentsOf = async (blocks: PageBlock[]): Promise<BodySegment[]> => {
    const segments: BodySegment[] = [];
    let run: PageBlock[] = [];
    const flush = async () => {
      if (!run.length) return;
      const inRun = runHeadings(run).map((block) => {
        const heading = {
          anchor: `${anchorPrefix}heading-${headings.length + 1}`,
          level: Number((block.props as { level?: unknown }).level) || 1,
          text: blocksToPlainText([{ ...block, children: [] }]),
        };
        headings.push(heading);
        return heading;
      });
      const nonce = crypto.randomUUID().slice(0, 8);
      const anchored: string[] = [];
      const marked = markBlocks(resolveMentions(sanitizeBlocks(run), refs), nonce, anchored);
      const serialized = emptyLinesAsBreaks(await editor.blocksToHTMLLossy(marked));
      run = [];
      const headed = await withHeadingAnchors(serialized, inRun.map((heading) => heading.anchor));
      const html = await withCalloutBorders(
        await withHighlightedCode(await withFootnotes(await withBlockAnchors(headed, nonce, anchored), notes, anchorPrefix)),
        calloutStyles,
      );
      if (html) segments.push({ kind: "html", html });
    };
    const standalone = async (block: PageBlock) => {
      if (block.type === COLUMN_LIST_BLOCK) {
        await flush();
        const columns: PublishedColumn<BodySegment>[] = [];
        for (const column of block.children ?? []) {
          if (column.type !== COLUMN_BLOCK) continue;
          columns.push({ width: columnWidth((column.props as { width?: unknown }).width), segments: await segmentsOf(column.children ?? []) });
        }
        if (columns.length) segments.push({ kind: "columns", columns });
        return;
      }
      if (block.type === TOC_BLOCK || block.type === BREADCRUMB_BLOCK || block.type === SUBPAGES_BLOCK) {
        await flush();
        segments.push(block.type === TOC_BLOCK ? { kind: "toc", headings } : { kind: block.type === BREADCRUMB_BLOCK ? "breadcrumb" : "subpages" });
        return;
      }
      if (isWebBlockType(block.type)) {
        const segment = webSegment(block);
        if (!segment) return;
        await flush();
        segments.push(segment);
        return;
      }
      const inPlace = inPlaceFileOf(block);
      if (inPlace) {
        const props = block.props as { name?: unknown; caption?: unknown };
        await flush();
        segments.push({
          ...inPlace,
          name: typeof props.name === "string" ? props.name : "",
          caption: typeof props.caption === "string" ? props.caption : "",
        });
        return;
      }
      if (block.type === DASHBOARD_BLOCK) {
        const widgets = parseDashboard((block.props as { widgets?: unknown }).widgets);
        if (!widgets.length) return;
        await flush();
        segments.push({ kind: "dashboard", widgets });
        return;
      }
      if (block.type === AGENT_CHAT_BLOCK) {
        await flush();
        segments.push({ kind: "agentChat" });
        return;
      }
      if (block.type === MERMAID_BLOCK) {
        const source = plainText(block.content);
        if (!source.trim()) return;
        await flush();
        segments.push({ kind: "mermaid", source });
        return;
      }
      const props = block.props as { databaseId?: unknown; view?: unknown };
      if (typeof props.databaseId !== "string" || !props.databaseId || !isEmbedBlockType(block.type)) return;
      await flush();
      segments.push({
        kind: "embed",
        type: block.type,
        databaseId: props.databaseId,
        view: block.type === "linkedView" ? parseLinkedView(props.view) : null,
      });
    };
    for (const block of blocks) {
      if (isStandalone(block)) {
        await standalone(block);
        continue;
      }
      const nested: PageBlock[] = [];
      run.push(withoutNestedStandalone(block, nested));
      for (const inner of nested) await standalone(inner);
    }
    await flush();
    return segments;
  };
  const segments = await segmentsOf(blocks);
  if (notes.length) segments.push({ kind: "footnotes", notes });
  return segments;
}

/**
 * The databases a body shows, each once, in order: those of its database blocks and dashboard
 * widgets, wherever they sit (in columns, nested under other blocks). The same blocks
 * `bodySegmentsFromBlocks` turns into embed and dashboard segments, without writing any HTML.
 */
export function bodyDatabaseIds(blocks: PageBlock[]): string[] {
  const ids = new Set<string>();
  const walk = (list: PageBlock[]) => {
    for (const block of list) {
      const props = block.props as { databaseId?: unknown; widgets?: unknown };
      if (block.type === DASHBOARD_BLOCK) {
        for (const widget of parseDashboard(props.widgets)) ids.add(widget.databaseId);
      } else if (isEmbedBlockType(block.type) && typeof props.databaseId === "string" && props.databaseId) {
        ids.add(props.databaseId);
      }
      if (block.children?.length) walk(block.children as PageBlock[]);
    }
  };
  walk(blocks);
  return [...ids];
}

/** The body as one HTML string, leaving database blocks out (columns' HTML one after another). */
export async function bodyHtmlFromYdoc(state: Uint8Array | null): Promise<string> {
  const html = (segments: BodySegment[]): string =>
    segments
      .map((s) => (s.kind === "html" ? s.html : s.kind === "columns" ? s.columns.map((c) => html(c.segments)).join("") : ""))
      .join("");
  return html(await bodySegmentsFromYdoc(state));
}
