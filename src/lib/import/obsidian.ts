/**
 * Notes written in Obsidian, on top of the layout lib/import/markdown already reads (a vault is a
 * folder of Markdown files, its attachments anywhere in it). Pure: the server import
 * (server/import/markdown.ts) uses these to
 *
 *   - find what a link names the way Obsidian does (VaultIndex): a path from the linking file or
 *     the top of the vault, else a file name anywhere in the vault, else a note's alias;
 *   - write `[[Note]]`, `[[Note#Heading|label]]`, `![[image.png]]` and `![[Note]]` as Markdown
 *     links to the files they name, which the import then points at the imported pages and the
 *     uploads like any other link;
 *   - write callouts of Obsidian's kinds (`> [!info]-`) as the five the editor has, and leave out
 *     comments (`%%…%%`), block ids (`^id`) and highlight marks (`==…==`, the text stays).
 *
 * Front matter gives a note's title (lib/import/markdown) and its aliases; the rest of it is left
 * out, since a page outside a database has no properties to keep it in.
 */

import { ALERT_KINDS, type AlertKind } from "../content-blocks";
import { PAGE_LINK_MARKER } from "../mentions";
import { importFileKind, normalizePath } from "./markdown";

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const withoutExtension = (path: string) => path.replace(/\.(?:md|markdown|csv)$/i, "");
const isNote = (path: string) => importFileKind(path) === "markdown";
const fold = (value: string) => value.normalize("NFC").trim().toLowerCase();
const depth = (path: string) => path.split("/").length;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const isImage = (path: string) => IMAGE_EXTENSIONS.has(/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "");

/** A page a link can name: a Markdown or CSV file of the upload, with its aliases. */
export type VaultPage = { path: string; aliases?: readonly string[] };

/**
 * Looks up what a link in a vault names, the way Obsidian resolves it: a path relative to the
 * linking file or to the top of the upload; else a file of that name anywhere (without case; in
 * the linking file's folder first, then the one with the shortest path, then notes before
 * databases, then by name), where `Folder/Note` only matches a path ending so; else, for pages,
 * an alias. Pages answer to their path with or without `.md` (or `.csv`), other files only with
 * their extension.
 */
export class VaultIndex {
  private readonly pageByPath = new Map<string, string>();
  private readonly pagesByName = new Map<string, string[]>();
  private readonly pageByAlias = new Map<string, string>();
  private readonly fileByPath = new Map<string, string>();
  private readonly filesByName = new Map<string, string[]>();

  constructor(pages: readonly VaultPage[], files: readonly string[]) {
    const add = (map: Map<string, string[]>, key: string, path: string) => map.set(key, [...(map.get(key) ?? []), path]);
    for (const { path, aliases } of pages) {
      const bare = fold(withoutExtension(path));
      this.pageByPath.set(fold(path), path);
      // A note and a database of the same name: the note.
      if (isNote(path) || !this.pageByPath.has(bare)) this.pageByPath.set(bare, path);
      add(this.pagesByName, fold(basename(path)), path);
      add(this.pagesByName, fold(basename(bare)), path);
      for (const alias of aliases ?? []) if (fold(alias) && !this.pageByAlias.has(fold(alias))) this.pageByAlias.set(fold(alias), path);
    }
    for (const path of files) {
      this.fileByPath.set(fold(path), path);
      add(this.filesByName, fold(basename(path)), path);
    }
  }

  /** The page a link target (no `#heading`, no `|label`) in the file at `from` names, as its path. */
  page(target: string, from: string): string | null {
    for (const path of this.candidates(target, from)) {
      const found = this.pageByPath.get(fold(path));
      if (found) return found;
    }
    return this.byName(this.pagesByName, target, from) ?? this.pageByAlias.get(fold(target)) ?? null;
  }

  /** The file (an attachment) a link target in the file at `from` names, as its path. */
  file(target: string, from: string): string | null {
    for (const path of this.candidates(target, from)) {
      const found = this.fileByPath.get(fold(path));
      if (found) return found;
    }
    return this.byName(this.filesByName, target, from);
  }

  /**
   * The page or file a Markdown link's href names when it isn't a path from the linking file: a
   * link Obsidian wrote by name (`[Plan](Plan.md)`) or from the top of the vault.
   */
  href(href: string, from: string): string | null {
    let target = href.trim().replace(/^<|>$/g, "").replace(/[?#].*$/, "");
    try {
      target = decodeURIComponent(target);
    } catch {}
    return this.page(target, from) ?? this.file(target, from);
  }

  /** Paths the target can mean as written: relative to the linking file, or to the top. */
  private candidates(target: string, from: string): string[] {
    const clean = target.trim();
    if (!clean) return [];
    const paths = [normalizePath(`${dirname(from)}/${clean}`)];
    if (!clean.startsWith(".")) paths.push(normalizePath(clean));
    return paths.filter((p): p is string => p !== null);
  }

  private byName(map: Map<string, string[]>, target: string, from: string): string | null {
    const clean = target.trim().replace(/^\/+/, "").replace(/^(?:\.\.?\/)+/, "");
    if (!clean) return null;
    let list = map.get(fold(basename(clean))) ?? [];
    if (clean.includes("/")) {
      const suffix = `/${fold(clean)}`;
      list = list.filter((path) => `/${fold(path)}`.endsWith(suffix) || `/${fold(withoutExtension(path))}`.endsWith(suffix));
    }
    if (list.length > 1) {
      const folder = fold(dirname(from));
      const near = list.filter((path) => fold(dirname(path)) === folder);
      if (near.length) list = near;
    }
    const sorted = [...list].sort((a, b) => depth(a) - depth(b) || Number(isNote(b)) - Number(isNote(a)) || collator.compare(a, b));
    return sorted[0] ?? null;
  }
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/**
 * A note's aliases from its front matter: `aliases: [One, "Two"]`, `aliases: One` or a list of
 * `- One` lines under `aliases:` (`alias:` works too).
 */
export function frontMatterAliases(markdown: string): string[] {
  const front = FRONT_MATTER.exec(markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  if (!front) return [];
  const lines = front[1].split("\n");
  const at = lines.findIndex((line) => /^alias(?:es)?:/i.test(line));
  if (at === -1) return [];
  const value = lines[at].replace(/^alias(?:es)?:/i, "").trim();
  let items: string[];
  if (value.startsWith("[")) items = value.replace(/^\[|\]$/g, "").split(",");
  else if (value) items = [value];
  else {
    items = [];
    for (const line of lines.slice(at + 1)) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (!item) break;
      items.push(item[1]);
    }
  }
  return items.map(unquote).filter(Boolean);
}

/** A link's href from the file at `from` to the upload's file at `path`: relative, encoded, in `<…>`. */
export function hrefTo(from: string, path: string): string {
  const fromDir = dirname(from) ? dirname(from).split("/") : [];
  const parts = path.split("/");
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  const relative = [...fromDir.slice(common).map(() => ".."), ...parts.slice(common).map(encodeURIComponent)];
  return `<${relative.join("/")}>`;
}

const escapeLabel = (label: string) => label.replace(/([\\[\]])/g, "\\$1");

/** `[[…]]` and `![[…]]`; in a table the `|` before a label is written `\|`. */
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/**
 * Whether a note has a wikilink, which (with a `.obsidian` folder) tells an Obsidian vault from
 * other Markdown: only a vault's notes get obsidianMarkdown, and links by path in a vault are
 * looked up by name across it.
 */
export const hasWikilink = (markdown: string) => /\[\[[^[\]\n]+\]\]/.test(markdown);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Each line of `markdown` outside fenced code, through `fn`; lines in code stay as they are. */
function outsideCode(markdown: string, fn: (line: string) => string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return fn(line);
    })
    .join("\n");
}

/** `fn` on the parts of a line outside inline code spans. */
const outsideCodeSpans = (line: string, fn: (text: string) => string) =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");

/**
 * `markdown` (the file at `from`) with its wikilinks written as Markdown links to the files they
 * name (see VaultIndex): `[[Note|label]]` as `[label](<Note.md>)`, `![[image.png]]` as an image,
 * `![[Note]]` on a line of its own as a link-to-page block, other embeds as links. A link to a
 * heading or block of a note (`[[Note#Heading]]`) leads to the note. Ones that name nothing in the
 * upload stay as written, and `unresolved` hears about each; nothing in code is touched.
 */
export function rewriteWikilinks(
  markdown: string,
  from: string,
  vault: VaultIndex,
  unresolved: (target: string) => void = () => {},
): string {
  return outsideCode(markdown, (line) => {
    const alone = /^\s*!\[\[[^[\]\n]+\]\]\s*$/.test(line);
    return outsideCodeSpans(line, (text) =>
      text.replace(WIKILINK, (whole, bang: string, inner: string) => {
        const [link, ...labelParts] = inner.replace(/\\\|/g, "|").split("|");
        const label = labelParts.join("|").trim();
        const hash = link.indexOf("#");
        const target = (hash === -1 ? link : link.slice(0, hash)).trim();
        const anchor = hash === -1 ? "" : link.slice(hash + 1).replace(/^\^/, "").trim();
        // A link to a heading of the same note: its text.
        if (!target) return label || anchor || whole;
        const embed = bang === "!";
        const page = vault.page(target, from);
        if (page) {
          const text = escapeLabel(label || (anchor ? `${target} > ${anchor}` : target));
          return `[${text}](${hrefTo(from, page)})${embed && alone ? ` ${PAGE_LINK_MARKER}` : ""}`;
        }
        const file = vault.file(target, from);
        if (!file) {
          unresolved(link.trim());
          return whole;
        }
        // `![[photo.png|300]]` sets a width, not a caption.
        const caption = /^\d+(?:x\d+)?$/.test(label) ? "" : label;
        if (embed && isImage(file)) return `![${escapeLabel(caption)}](${hrefTo(from, file)})`;
        return `[${escapeLabel(caption || basename(file))}](${hrefTo(from, file)})`;
      }),
    );
  });
}

/** Obsidian's callout kinds (and their aliases) as the editor's five; unknown kinds are notes. */
const CALLOUT_KIND: Record<string, AlertKind> = {
  tip: "TIP",
  hint: "TIP",
  success: "TIP",
  check: "TIP",
  done: "TIP",
  important: "IMPORTANT",
  warning: "WARNING",
  caution: "WARNING",
  attention: "WARNING",
  danger: "CAUTION",
  error: "CAUTION",
  failure: "CAUTION",
  fail: "CAUTION",
  missing: "CAUTION",
  bug: "CAUTION",
};

const CALLOUT = /^( {0,3}> ?)\[!([A-Za-z-]+)\][+-]?/;
const BLOCK_ID = /\s+\^[A-Za-z0-9-]+\s*$/;
const HIGHLIGHT = /==(?=\S)([^\n=]*?\S)==/g;

/**
 * Obsidian's own Markdown in the forms the editor reads (see the top of this file). Code blocks
 * and inline code are left as they are.
 */
export function obsidianMarkdown(markdown: string): string {
  // Comments first: they may span lines, but never start in code.
  let inComment = false;
  const uncommented = outsideCode(markdown, (line) => {
    let out = "";
    let rest = line;
    for (;;) {
      if (inComment) {
        const end = rest.indexOf("%%");
        if (end === -1) return out.trim() ? out : "";
        rest = rest.slice(end + 2);
        inComment = false;
      }
      const parts = rest.split(/(`+[^`]*`+)/);
      let start = -1;
      let offset = 0;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0 && parts[i].includes("%%")) {
          start = offset + parts[i].indexOf("%%");
          break;
        }
        offset += parts[i].length;
      }
      if (start === -1) return out + rest;
      out += rest.slice(0, start);
      rest = rest.slice(start + 2);
      inComment = true;
    }
  });
  return outsideCode(uncommented, (line) => {
    if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) return "";
    let next = line.replace(BLOCK_ID, "");
    next = next.replace(CALLOUT, (whole, quote: string, kind: string) => {
      // Written in capitals it's one of the editor's own (as exported); Obsidian writes lowercase.
      const own = (ALERT_KINDS as readonly string[]).includes(kind.toUpperCase()) ? (kind.toUpperCase() as AlertKind) : null;
      const mapped = (kind === kind.toUpperCase() ? own : null) ?? CALLOUT_KIND[kind.toLowerCase()] ?? own ?? "NOTE";
      return `${quote}[!${mapped}]`;
    });
    return outsideCodeSpans(next, (text) => text.replace(HIGHLIGHT, "$1"));
  });
}
