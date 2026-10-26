import { ImportError } from "./result";
import { scanXml, XmlError } from "./xlsx";

/**
 * Reading an Evernote export (.enex): an XML file of notes, each with its title, dates, tags, a few
 * attributes (author, source URL), its content in ENML (Evernote's XHTML: `<en-note>` with
 * `<en-todo>`, `<en-media>` and `<en-crypt>` among ordinary tags) and its attachments ("resources",
 * base64 data that the content points at by the MD5 hash of the bytes).
 *
 * Both the export and each note's content are read with the strict XML reader of the workbook
 * import (lib/import/xlsx): elements, attributes, text and CDATA, and only XML's own five entities.
 * Exports start with a DOCTYPE that names Evernote's DTD; that one is passed over (nothing is
 * fetched), and a DOCTYPE with declarations of its own (where entities that expand without end
 * live) is refused. ENML may use HTML's named entities (`&nbsp;`): they are carried through to the
 * HTML this module writes, for the editor's HTML reader to resolve (see enmlToHtml).
 *
 * The server part (server/import/enex) turns the HTML into blocks, uploads the attachments and
 * creates a database per export.
 */

export type EnexResource = {
  /** The attachment's bytes as base64, as the export holds them (decoded by the server). */
  data: string;
  mime: string;
  fileName: string | null;
};

export type EnexNote = {
  title: string;
  /** The note's ENML document, as written. */
  content: string;
  /** When it was created and last changed, as ISO times in UTC; null when the export doesn't say. */
  created: string | null;
  updated: string | null;
  tags: string[];
  author: string | null;
  sourceUrl: string | null;
  resources: EnexResource[];
};

/** Limits of one export (the upload's size is checked before it is read, see IMPORT_LIMITS). */
export const ENEX_LIMITS = {
  /** Notes of one export: they become rows of one database (as a CSV's lines do, see CSV_MAX_ROWS). */
  notes: 5000,
  /** One note's content: a larger one is left out. */
  contentChars: 5 * 1024 * 1024,
  /** Tags of one note. */
  tags: 100,
};

/**
 * A DOCTYPE at the start of a document (after the XML declaration and comments): passed over when
 * it only names an external DTD, which is never fetched; one with an internal subset (`[…]`, where
 * entities are declared) is refused.
 */
export function withoutDoctype(xml: string): string {
  const head = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/.exec(xml)![0];
  if (!/^<!DOCTYPE\s/i.test(xml.slice(head.length, head.length + 10))) return xml;
  // The DOCTYPE's end: the first ">" outside a quoted identifier.
  let quote = 0;
  for (let i = head.length + 9; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 91 || c === 60) throw new XmlError("A DOCTYPE with declarations isn't allowed");
    else if (c === 62) return head + xml.slice(i + 1);
  }
  throw new XmlError("Unclosed DOCTYPE");
}

/** `20231107T101530Z` (how exports write times, in UTC) as `2023-11-07T10:15:30Z`; null for anything else. */
export function enexDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const date = new Date(iso);
  // A day or time that doesn't exist (month 13) doesn't come back as written.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19) ? null : iso;
}

const clean = (text: string, max = 200) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The notes of an export. Throws an ImportError: `badEnex` (with the file's `name`) when the file
 * isn't well-formed XML or isn't an Evernote export, `tooManyRows` past ENEX_LIMITS.notes.
 */
export function readEnex(name: string, xml: string): EnexNote[] {
  const unreadable = () => new ImportError(`“${name}” can't be read as an Evernote export`, "badEnex", { name });
  const notes: EnexNote[] = [];
  // The names of the open elements.
  const path: string[] = [];
  let note: EnexNote | null = null;
  let resource: EnexResource | null = null;
  let text = "";
  let root: string | null = null;
  try {
    scanXml(withoutDoctype(xml), {
      open(tag) {
        root ??= tag;
        path.push(tag);
        text = "";
        if (tag === "note" && path.length === 2) {
          if (notes.length >= ENEX_LIMITS.notes) {
            throw new ImportError(`An export can have at most ${ENEX_LIMITS.notes} notes`, "tooManyRows", { limit: ENEX_LIMITS.notes });
          }
          note = { title: "", content: "", created: null, updated: null, tags: [], author: null, sourceUrl: null, resources: [] };
        } else if (tag === "resource" && note && path.length === 3) {
          resource = { data: "", mime: "", fileName: null };
        }
      },
      text(chunk) {
        // A note's content and an attachment's data only where they belong; other text for its element.
        const tag = path.at(-1);
        if (tag === "content" && path.length === 3 && note) {
          if (note.content.length <= ENEX_LIMITS.contentChars) note.content += chunk;
        } else if (tag === "data" && path.length === 4 && resource) resource.data += chunk;
        else text += chunk;
      },
      close(tag) {
        const depth = path.length;
        path.pop();
        if (note && depth === 2 && tag === "note") {
          notes.push(note);
          note = null;
        } else if (note && depth === 3) {
          if (tag === "title") note.title = clean(text);
          else if (tag === "created") note.created = enexDate(text);
          else if (tag === "updated") note.updated = enexDate(text);
          else if (tag === "tag") {
            const tagName = clean(text);
            const known = note.tags.some((t) => t.toLowerCase() === tagName.toLowerCase());
            if (tagName && !known && note.tags.length < ENEX_LIMITS.tags) note.tags.push(tagName);
          } else if (tag === "resource" && resource) {
            note.resources.push(resource);
            resource = null;
          }
        } else if (note && depth === 4 && path[2] === "note-attributes") {
          if (tag === "author") note.author = clean(text, 500) || null;
          else if (tag === "source-url") note.sourceUrl = clean(text, 2000) || null;
        } else if (resource && depth === 4 && tag === "mime") {
          resource.mime = clean(text).toLowerCase();
        } else if (resource && depth === 5 && path[3] === "resource-attributes" && tag === "file-name") {
          resource.fileName = clean(text) || null;
        }
        text = "";
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw unreadable();
  }
  if (root !== "en-export") throw unreadable();
  return notes;
}

// ---------------------------------------------------------------------------------------------
// ENML as HTML

/**
 * How an attachment's place in the HTML starts: an image whose source is this followed by the
 * attachment's hash. A same-origin path, so the media check of the blocks lets it through; the
 * server swaps it for the upload (an image block, or a file block for other attachments).
 */
export const MEDIA_TOKEN = "/leafdesk-enex-media/";

type Node = { tag: string; attrs: Record<string, string>; children: (Node | string)[] };

/**
 * HTML's named entities (`&nbsp;`) are written as a private-use character and the name, which the
 * XML reader keeps as text; escape() writes them back as entities, for the HTML reader to resolve.
 */
const ENTITY_MARK = "";
const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

function parseEnml(enml: string): Node {
  const marked = enml.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (match, name: string) =>
    XML_ENTITIES.has(name) ? match : `&#xE000;${name};`,
  );
  const root: Node = { tag: "#root", attrs: {}, children: [] };
  const stack: Node[] = [root];
  scanXml(withoutDoctype(marked.trim()), {
    open(tag, attrs) {
      const node: Node = { tag: tag.toLowerCase(), attrs, children: [] };
      stack.at(-1)!.children.push(node);
      stack.push(node);
    },
    close() {
      stack.pop();
    },
    text(text) {
      stack.at(-1)!.children.push(text);
    },
  });
  return root;
}

function escape(text: string, attribute = false): string {
  let out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attribute) out = out.replace(/"/g, "&quot;");
  return out.includes(ENTITY_MARK) ? out.replace(/([A-Za-z][A-Za-z0-9]{1,31});/g, "&$1;").replace(//g, "") : out;
}

/** Elements that are blocks of their own. */
const BLOCK_TAGS = new Set([
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "pre",
  "blockquote",
  "hr",
  "center",
  "section",
  "article",
  "header",
  "footer",
  "aside",
  "nav",
  "figure",
  "address",
  "dl",
  "dt",
  "dd",
  "en-crypt",
  "en-media",
]);

type Child = Node | string;

const isElement = (node: Child | undefined): node is Node => typeof node === "object";
const isBlock = (node: Child) => isElement(node) && BLOCK_TAGS.has(node.tag);
const isTodo = (node: Child | undefined): node is Node => isElement(node) && node.tag === "en-todo";
const checked = (node: Node) => (node.attrs.checked ?? "").toLowerCase() === "true";
const style = (node: Node) => (node.attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
const NBSP = new RegExp(`${ENTITY_MARK}nbsp;`, "g");
const isBlankText = (text: string) => !text.replace(NBSP, "").trim();
const isBlank = (nodes: Child[]) => nodes.every((n) => (isElement(n) ? n.tag === "br" : isBlankText(n)));
/** The first child that isn't only white space. */
const firstShown = (nodes: Child[]) => nodes.findIndex((n) => isElement(n) || !isBlankText(n));
/**
 * `html` without the `unit`s it ends with, counted off from its end: `/(unit)+$/` would start over
 * at each one of a long run that ends in something else.
 */
function withoutTrailing(html: string, unit: string): string {
  let end = html.length;
  while (end >= unit.length && html.startsWith(unit, end - unit.length)) end -= unit.length;
  return html.slice(0, end);
}
const trimBreaks = (html: string) => withoutTrailing(html.replace(/^(\s|<br>)+/, ""), "<br>");

/** A code block's text: a line per block inside it. */
function textContent(node: Child): string {
  if (!isElement(node)) return node;
  if (node.tag === "br") return "\n";
  const inner = node.children.map(textContent).join("");
  return BLOCK_TAGS.has(node.tag) && inner && !inner.endsWith("\n") ? `${inner}\n` : inner;
}

/** What a note's content held that its HTML leaves out or changes, for the import's warnings. */
export type EnmlReport = {
  /** Encrypted passages: each is a line saying it was left out. */
  encrypted: number;
  /** Pictures linked from outside the note (`<img src>`): Leafdesk doesn't load them. */
  external: string[];
};

type Context = { encrypted: string; report: EnmlReport };

/**
 * Whether a declaration of the style (between semicolons) has `text-decoration` and `line` after
 * it, as `/text-decoration[^;]*line/` would find, without reading on from every `text-decoration`.
 */
const decorated = (style: string, line: string) =>
  style.split(";").some((part) => {
    const at = part.indexOf("text-decoration");
    return at !== -1 && part.includes(line, at + "text-decoration".length);
  });

/** A span's or font's styles as the tags the editor reads. */
function styleTags(node: Node): [string, string] {
  const s = style(node);
  let open = "";
  let close = "";
  const wrap = (tag: string, attrs = "") => {
    open += `<${tag}${attrs}>`;
    close = `</${tag}>${close}`;
  };
  if (/font-weight:(bold|[6-9]00)/.test(s)) wrap("strong");
  if (s.includes("font-style:italic")) wrap("em");
  if (decorated(s, "underline")) wrap("u");
  if (decorated(s, "line-through")) wrap("s");
  if (s.includes("--en-highlight:") || s.includes("-evernote-highlight:true")) wrap("span", ' data-style-type="backgroundColor" data-value="yellow"');
  return [open, close];
}

const media = (node: Node) => {
  const hash = (node.attrs.hash ?? "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hash) ? `<img src="${MEDIA_TOKEN}${hash}">` : "";
};

const encryptedLine = (ctx: Context) => {
  ctx.report.encrypted++;
  return `<em>${escape(ctx.encrypted)}</em>`;
};

/** A run of inline content; a block met inside it (a div in a table cell) ends its line. */
function inline(nodes: Child[], ctx: Context): string {
  let out = "";
  for (const node of nodes) {
    if (!isElement(node)) {
      out += escape(node);
      continue;
    }
    const inner = () => inline(node.children, ctx);
    switch (node.tag) {
      case "br":
      case "hr":
        out += "<br>";
        break;
      case "b":
      case "strong":
        out += `<strong>${inner()}</strong>`;
        break;
      case "i":
      case "em":
      case "cite":
      case "dfn":
        out += `<em>${inner()}</em>`;
        break;
      case "u":
      case "ins":
        out += `<u>${inner()}</u>`;
        break;
      case "s":
      case "strike":
      case "del":
        out += `<s>${inner()}</s>`;
        break;
      case "code":
      case "tt":
      case "kbd":
      case "samp":
        out += `<code>${inner()}</code>`;
        break;
      case "sub":
      case "sup":
        out += `<${node.tag}>${inner()}</${node.tag}>`;
        break;
      case "a": {
        // Web and mail links only: a link to another note (evernote:///view/…) can't be followed here.
        const href = (node.attrs.href ?? "").trim();
        out += /^(https?:|mailto:)/i.test(href) ? `<a href="${escape(href, true)}">${inner()}</a>` : inner();
        break;
      }
      case "en-todo":
        out += checked(node) ? "☑ " : "☐ ";
        break;
      case "en-media":
        out += media(node);
        break;
      case "en-crypt":
        out += encryptedLine(ctx);
        break;
      case "img":
        if (node.attrs.src) ctx.report.external.push(node.attrs.src.slice(0, 200));
        break;
      case "span":
      case "font": {
        const [open, close] = styleTags(node);
        out += open + inner() + close;
        break;
      }
      default: {
        const text = inner();
        out += BLOCK_TAGS.has(node.tag) && text && !text.endsWith("<br>") ? `${text}<br>` : text;
      }
    }
  }
  return out;
}

const paragraph = (html: string) => `<p>${withoutTrailing(html, "<br>")}</p>`;
const checkbox = (isChecked: boolean) => `<input type="checkbox"${isChecked ? " checked" : ""}>`;

/**
 * Inline content holding to-dos: split at its line breaks, each line that starts with a to-do an
 * item of a checklist, the others paragraphs.
 */
function todoLines(nodes: Child[], ctx: Context): string {
  const lines: Child[][] = [[]];
  for (const node of nodes) {
    if (isElement(node) && node.tag === "br") lines.push([]);
    else lines.at(-1)!.push(node);
  }
  return lines
    .map((line) => {
      const start = firstShown(line);
      if (start === -1) return "";
      const first = line[start];
      if (isTodo(first)) return `<ul><li>${checkbox(checked(first))}${trimBreaks(inline(line.slice(start + 1), ctx))}</li></ul>`;
      return paragraph(inline(line, ctx));
    })
    .join("");
}

/** A list item: its to-do box, its text, and the lists nested in it. */
function listItem(node: Node, ctx: Context, todoList: boolean): string {
  const nested = node.children.filter((n): n is Node => isElement(n) && (n.tag === "ul" || n.tag === "ol"));
  let content = node.children.filter((n) => !nested.includes(n as Node));
  const start = firstShown(content);
  let box = "";
  const first = content[start];
  if (isTodo(first)) {
    box = checkbox(checked(first));
    content = content.slice(start + 1);
  } else if (todoList) box = checkbox(style(node).includes("--en-checked:true"));
  return `<li>${box}${trimBreaks(inline(content, ctx))}${nested.map((list) => block(list, ctx)).join("")}</li>`;
}

function table(node: Node, ctx: Context): string {
  const rows: Node[] = [];
  const collect = (n: Node) => {
    for (const child of n.children) {
      if (!isElement(child)) continue;
      if (child.tag === "tr") rows.push(child);
      else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") collect(child);
    }
  };
  collect(node);
  const span = (name: string, value: string | undefined) => (value && /^[1-9]\d?$/.test(value) ? ` ${name}="${value}"` : "");
  const html = rows.map((row) => {
    const cells = row.children
      .filter((c): c is Node => isElement(c) && (c.tag === "td" || c.tag === "th"))
      .map((cell) => {
        const attrs = span("colspan", cell.attrs.colspan) + span("rowspan", cell.attrs.rowspan);
        return `<${cell.tag}${attrs}>${trimBreaks(inline(cell.children, ctx))}</${cell.tag}>`;
      });
    return cells.length ? `<tr>${cells.join("")}</tr>` : "";
  });
  return html.some(Boolean) ? `<table>${html.join("")}</table>` : "";
}

/** A sequence of nodes as blocks: runs of inline content become paragraphs (or checklist items). */
function blocks(nodes: Child[], ctx: Context): string {
  let out = "";
  let run: Child[] = [];
  const flush = () => {
    if (run.length && !isBlank(run)) out += run.some(isTodo) ? todoLines(run, ctx) : paragraph(inline(run, ctx));
    run = [];
  };
  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      out += block(node as Node, ctx);
    } else if (isElement(node) && (node.tag === "en-note" || node.children.some(isBlock))) {
      // An inline element around blocks (a span, en-note itself): read as what it holds.
      flush();
      out += blocks(node.children, ctx);
    } else run.push(node);
  }
  flush();
  return out;
}

function block(node: Node, ctx: Context): string {
  const s = style(node);
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Math.min(Number(node.tag[1]), 3);
      const text = trimBreaks(inline(node.children, ctx));
      return text ? `<h${level}>${text}</h${level}>` : "";
    }
    case "ul":
    case "ol": {
      const todoList = s.includes("--en-todo:true");
      const items = node.children.filter((c): c is Node => isElement(c) && (c.tag === "li" || c.tag === "ul" || c.tag === "ol"));
      const html = items.map((item) => (item.tag === "li" ? listItem(item, ctx, todoList) : `<li>${block(item, ctx)}</li>`));
      if (!html.length) return "";
      // A to-do item is read as a checklist item when it's in a bulleted list.
      const tag = todoList ? "ul" : node.tag;
      return `<${tag}>${html.join("")}</${tag}>`;
    }
    case "li":
      return `<ul>${listItem(node, ctx, false)}</ul>`;
    case "table":
      return table(node, ctx);
    case "pre":
      return `<pre><code>${escape(textContent(node).replace(/\n$/, ""))}</code></pre>`;
    case "blockquote": {
      const text = trimBreaks(inline(node.children, ctx));
      return text ? `<blockquote>${text}</blockquote>` : "";
    }
    case "hr":
      return "<hr>";
    case "en-media":
      return `<p>${media(node)}</p>`;
    case "en-crypt":
      return `<p>${encryptedLine(ctx)}</p>`;
    default: {
      // Evernote's code blocks: a div styled as one, a line per child.
      if (s.includes("-en-codeblock:true")) return `<pre><code>${escape(textContent(node).replace(/\n$/, ""))}</code></pre>`;
      if (node.children.some(isBlock)) return blocks(node.children, ctx);
      // An empty line (Evernote writes `<div><br/></div>` between paragraphs).
      if (isBlank(node.children)) return "<p></p>";
      if (node.children.some(isTodo)) return todoLines(node.children, ctx);
      const [open, close] = styleTags(node);
      return paragraph(open + inline(node.children, ctx) + close);
    }
  }
}

/**
 * A note's ENML as HTML for the editor's HTML reader: headings, paragraphs, text styles, links (web
 * and mail only), lists, to-dos as checklist items, tables, code blocks, quotes and dividers;
 * attachments as images whose source is MEDIA_TOKEN and their hash, and encrypted passages as a
 * line of `encrypted`. Pictures linked from outside the note are left out. Throws an XmlError when
 * the content isn't well-formed.
 */
export function enmlToHtml(enml: string, { encrypted }: { encrypted: string }): { html: string; report: EnmlReport } {
  const report: EnmlReport = { encrypted: 0, external: [] };
  if (!enml.trim()) return { html: "", report };
  const root = parseEnml(enml);
  // Empty lines at the start and end of a note are only spacing.
  const html = withoutTrailing(blocks(root.children, { encrypted, report }).replace(/^(<p><\/p>)+/, ""), "<p></p>");
  return { html, report };
}
