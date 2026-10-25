import { JSDOM, VirtualConsole } from "jsdom";
import { cleanTitle } from "@/lib/import/markdown";
import { findPart, partText, type MhtmlArchive, type MhtmlPart } from "@/lib/import/mhtml";
import { ImportError } from "@/lib/import/result";
import type { PageBlock } from "@/server/blocknote";
import { DOCX_LIMITS, htmlBlocks, imageName } from "./docx-convert";

/**
 * A single-file web page (lib/import/mhtml reads the file) as pages: its HTML cleaned the way a
 * saved web page's is (server/web-clip-extract), then read by the editor's HTML reader and checked
 * as a published page's blocks are (docx-convert htmlBlocks), so only what the page schema knows
 * survives. Pictures point at a token until they are uploaded: the part of the file each one
 * shows, or none for one the file doesn't hold (it is never fetched).
 *
 * OneNote's export (its `Generator` meta says so) is read for its pages: each OneNote page is a
 * block of its own under `<body>`, starting with the page's title and, under it, its date and time
 * (two short paragraphs in a block of their own). The title names the page and leaves the body;
 * the date and time stay as its first line. A section's export holds several such blocks: each
 * becomes a page, under one named after the file (OneNote names it after the section). The
 * export's "Created with OneNote." line, and tag icons drawn as tiny pictures, are left out. Any
 * other file is one page, titled by its `<title>`, else a first-level heading at its very top,
 * else the file's name.
 */

/** How an image block's token starts until its picture is uploaded: a same-origin path, so the media check lets it through. */
export const MHTML_IMAGE_TOKEN = "/leafdesk-mhtml-image/";

/** Pictures this small in a OneNote page are its tag icons (to-do, important…), not content. */
const TAG_ICON_PX = 20;

/** A picture of the file: the part it shows (null when the file hasn't it), its file name and type. */
export type MhtmlImage = { token: string; part: MhtmlPart | null; name: string; type: string };
export type MhtmlPage = { title: string | null; blocks: PageBlock[] };
export type MhtmlDocument = {
  oneNote: boolean;
  /** The section's name when the file holds several OneNote pages; null for one page. */
  section: string | null;
  pages: MhtmlPage[];
  images: MhtmlImage[];
};

const REMOVED = "script, style, noscript, iframe, frame, frameset, object, embed, video, audio, source, track, svg, canvas, form, button, input, select, textarea, link, meta, template, title, base";
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, table";

const text = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
const elements = (node: Element) => [...node.children];

/** A web address or mail link for `href`, made absolute against `base` when that is a web address; null for anything else. */
function linkTarget(href: string, base: string | null): string | null {
  const value = href.trim();
  if (/^mailto:/i.test(value)) return value;
  try {
    const url = new URL(value, base && /^https?:/i.test(base) ? base : undefined);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A picture's file name: the last part of its location, else one by its number and `type`. No slashes. */
function pictureName(part: MhtmlPart | null, ref: string, index: number, type: string): string {
  const from = part?.location ?? ref;
  let name = from.replace(/[?#].*$/, "").split(/[/\\]/).pop() ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {}
  name = name.replace(/[/\\]/g, "_").trim();
  return name && !/^cid:/i.test(from) && name.includes(".") ? name.slice(0, 200) : imageName(index, type);
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Signatures of the picture types pages show, for a part whose type says nothing. */
const MAGIC: [string, number[]][] = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/bmp", [0x42, 0x4d]],
];

/**
 * A picture's type: its part's, else (a part typed `application/octet-stream`, say) by the
 * extension of where it was, else by its first bytes.
 */
function pictureType(part: MhtmlPart | null, ref: string): string {
  if (!part || part.type.startsWith("image/")) return part?.type ?? "";
  const ext = /\.([a-z0-9]+)$/i.exec((part.location ?? ref).replace(/[?#].*$/, ""))?.[1]?.toLowerCase();
  if (ext && IMAGE_TYPES[ext]) return IMAGE_TYPES[ext];
  return MAGIC.find(([, bytes]) => bytes.every((b, i) => part.data[i] === b))?.[0] ?? part.type;
}

/**
 * A OneNote page's head inside `block` (or the block right inside it): its title block (one
 * paragraph) followed by its date and time block (one or two short paragraphs). Null when it
 * hasn't that shape.
 */
function pageHead(block: Element): { title: Element; date: Element } | null {
  for (const frame of [block, block.firstElementChild]) {
    if (frame?.tagName !== "DIV") continue;
    const [title, date] = elements(frame);
    if (title?.tagName !== "DIV" || date?.tagName !== "DIV") continue;
    const titleKids = elements(title);
    const dateKids = elements(date);
    if (titleKids.length !== 1 || titleKids[0].tagName !== "P") continue;
    if (!dateKids.length || dateKids.length > 2 || dateKids.some((p) => p.tagName !== "P" || text(p).length > 80)) continue;
    return { title, date };
  }
  return null;
}

/** OneNote's closing "Created with OneNote." line (in the export's language): a short last block naming OneNote. */
const isCreatedWith = (node: Element) => !pageHead(node) && text(node).length < 80 && /OneNote/.test(text(node));

/** An empty paragraph (a blank line). */
const isBlank = (block: PageBlock) =>
  block.type === "paragraph" && !block.children?.length && !(Array.isArray(block.content) && block.content.some((i) => i.type !== "text" || i.text.trim()));

/** Moves pictures out of paragraphs and headings that have text too (the reader drops a picture amid text). */
function liftImages(root: Element) {
  const last = new Map<Element, Element>();
  for (const img of root.querySelectorAll("img")) {
    const block = img.parentElement?.closest(BLOCKS);
    if (!block || !root.contains(block)) continue;
    if (block.tagName !== "TABLE" && !text(block) && block.querySelectorAll("img").length === 1) continue;
    const anchor = last.get(block) ?? block;
    anchor.after(img);
    last.set(block, img);
  }
}

/**
 * Reads the archive's page into pages (see above). `name` is the file's, for its title and the
 * errors: `docxTooComplex` for HTML past DOCX_LIMITS.htmlBytes or too many blocks, `badMhtml` for
 * HTML the reader can't read.
 */
export async function mhtmlDocument(name: string, archive: MhtmlArchive): Promise<MhtmlDocument> {
  const tooComplex = () => new ImportError(`“${name}” is too large or complex to import`, "docxTooComplex", { name });
  if (archive.root.data.byteLength > DOCX_LIMITS.htmlBytes) throw tooComplex();
  const html = partText(archive.root);
  // jsdom runs no scripts and loads nothing the page points at (neither is switched on).
  const { document } = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window;
  const base = archive.root.location;
  const generator = [...document.querySelectorAll("meta[name]")]
    .filter((m) => /^(generator|progid)$/i.test(m.getAttribute("name") ?? ""))
    .map((m) => m.getAttribute("content") ?? "")
    .join(" ");
  const oneNote = /OneNote/i.test(generator);
  const headTitle = (document.querySelector("head > title")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const body = document.body;

  for (const element of body.querySelectorAll(REMOVED)) element.remove();
  // Pictures to tokens, one per part (or per reference the file has no part for).
  const images: MhtmlImage[] = [];
  const tokens = new Map<MhtmlPart | string, string>();
  for (const img of body.querySelectorAll("img")) {
    const ref = img.getAttribute("src")?.trim() ?? "";
    const tiny = (attr: string) => {
      const size = Number(img.getAttribute(attr));
      return Number.isFinite(size) && size > 0 && size <= TAG_ICON_PX;
    };
    if (!ref || /^data:/i.test(ref) || (oneNote && tiny("width") && tiny("height"))) {
      img.remove();
      continue;
    }
    const part = findPart(archive, ref, base);
    const key = part ?? ref;
    let token = tokens.get(key);
    if (!token) {
      token = `${MHTML_IMAGE_TOKEN}${images.length + 1}`;
      tokens.set(key, token);
      const type = pictureType(part, ref);
      images.push({ token, part, name: pictureName(part, ref, images.length + 1, type), type });
    }
    for (const attr of img.getAttributeNames()) if (attr !== "alt") img.removeAttribute(attr);
    img.setAttribute("src", token);
  }
  for (const link of body.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    const target = href ? linkTarget(href, base) : null;
    for (const attr of link.getAttributeNames()) link.removeAttribute(attr);
    if (target) link.setAttribute("href", target);
  }
  liftImages(body);

  // The page blocks of a OneNote export; what sits between them goes with the page before.
  type Raw = { oneNotePage: boolean; title: string; nodes: Node[] };
  const raw: Raw[] = [];
  const footer = body.lastElementChild;
  if (oneNote && footer && isCreatedWith(footer)) footer.remove();
  let current: Raw | null = null;
  for (const node of [...body.childNodes]) {
    const head = oneNote && node.nodeType === node.ELEMENT_NODE ? pageHead(node as Element) : null;
    if (head) {
      // The date and time stay, as one line under the title.
      const when = document.createElement("p");
      when.textContent = elements(head.date).map(text).filter(Boolean).join(" ");
      head.date.replaceWith(when);
      head.title.remove();
      current = { oneNotePage: true, title: text(head.title).slice(0, 200), nodes: [] };
      raw.push(current);
    } else if (!current) {
      current = { oneNotePage: false, title: "", nodes: [] };
      raw.push(current);
    }
    current.nodes.push(node);
  }

  const pages: MhtmlPage[] = [];
  for (const page of raw) {
    const holder = document.createElement("div");
    holder.append(...page.nodes);
    let read;
    try {
      read = await htmlBlocks(name, holder.innerHTML, { unreadable: "badMhtml", tooComplex: "docxTooComplex" }, { title: !page.oneNotePage });
    } catch (error) {
      if (error instanceof ImportError && error.code === "docxTooComplex") throw tooComplex();
      throw error;
    }
    // Blank lines a page ends with (OneNote's page breaks between pages read as some).
    const blocks = [...read.blocks];
    while (blocks.length && isBlank(blocks.at(-1)!)) blocks.pop();
    if (page.oneNotePage) pages.push({ title: page.title || null, blocks });
    // Something before the first OneNote page that is nothing but blank lines isn't a page.
    else if (blocks.length || raw.length === 1) pages.push({ title: read.title ?? (headTitle || null), blocks });
  }
  const section = pages.length > 1 ? cleanTitle(name) || name.slice(0, 200) : null;
  return { oneNote, section, pages, images };
}
