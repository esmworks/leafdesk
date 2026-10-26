/**
 * Planning a Markdown import (see server/import/markdown.ts): which files of an upload (loose
 * files, a folder or a ZIP) become which pages, where each goes in the page tree, and how links
 * between the files are rewritten. Pure: no database, no file contents beyond the Markdown text.
 *
 * Layout understood (Notion's export and a plain folder of notes both follow it):
 *
 *   Project.md             a page
 *   Project/               …its subpages, when a folder sits next to a file of the same name
 *     Notes.md
 *     images/diagram.png   a file Notes.md shows: uploaded, and the link pointed at the upload
 *   Tasks.csv              a database (types guessed from the values, see lib/import/csv)
 *   Tasks/                 …its rows' pages, matched to rows by title (others become new rows)
 *     Write docs.md
 *   Archive/               a folder with no file of its name: a page named after the folder,
 *     index.md             whose body is index.md (or README.md, or Archive.md) when there is one
 *     Old.md
 *
 * Notion adds a 32-character id to every name ("Project 1a2b….md"); titles leave it out. What else
 * is particular to Notion's export (callouts, row property lists, relations) is in lib/import/notion.
 *
 * Leafdesk's own export (lib/export-layout) adds `Templates/` folders: in a database's folder its
 * row templates, at the top the workspace's templates.
 */

import { TEMPLATES_FOLDER } from "../export-layout";

const MB = 1024 * 1024;

/** Limits of one import. Uploads over them are refused before anything is created. */
export const IMPORT_LIMITS = {
  /** The upload itself: every file, or the ZIP. */
  uploadBytes: 100 * MB,
  /** A ZIP's files once unpacked, together. */
  unpackedBytes: 300 * MB,
  /** Files in the upload (or in the ZIP). */
  files: 2000,
  /** Pages and databases created (rows of an imported CSV don't count). */
  pages: 500,
  /** One Markdown file. */
  markdownBytes: 5 * MB,
  /** A file's path in the upload, in characters and in folders: deeper ones are left out. */
  pathChars: 2048,
  pathDepth: 100,
};

export type ImportFileKind = "markdown" | "csv" | "zip" | "asset";

const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

export function importFileKind(path: string): ImportFileKind {
  const ext = extension(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "zip") return "zip";
  return "asset";
}

/**
 * A path inside the upload as `a/b/c.md`: forward slashes, no leading `./` or `/`, `.` and `..`
 * worked out. Null for a path that climbs out of the upload, or an empty one.
 */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

/** Files every OS leaves in archives and folders that aren't anyone's content. */
export function isIgnoredPath(path: string): boolean {
  return path.split("/").some((s) => s.startsWith(".") || s === "__MACOSX" || s === "Thumbs.db" || s === "desktop.ini");
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** `name` without the Notion id it ends with (white space and 32 hex digits). */
function withoutNotionId(name: string): string {
  // Checked from the end: `/\s+[0-9a-f]{32}$/` would start over at each space of a long run.
  const id = name.length - 32;
  return id > 0 && /^[0-9a-f]{32}$/i.test(name.slice(id)) && /\s/.test(name[id - 1]) ? name.slice(0, id).trimEnd() : name;
}

/** A file or folder name as a title: no extension, no Notion id, no stray whitespace. */
export function cleanTitle(name: string): string {
  return withoutNotionId(stem(basename(name)).replace(/_all$/i, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** Markdown without its YAML front matter (which would read as a rule and text). */
export function withoutFrontMatter(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.replace(FRONT_MATTER, "").replace(/^\s*\n/, "");
}

/**
 * A Markdown file's title and body: a `title:` in YAML front matter, else a first-line `# Heading`
 * (which the body then leaves out, as Leafdesk's own export writes it), else `fallback`. Front
 * matter is dropped from the body either way.
 */
export function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  let text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let title: string | null = null;
  const front = FRONT_MATTER.exec(text);
  if (front) {
    const value = frontMatterTitle(front[1]);
    if (value !== null) title = value.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
    text = text.slice(front[0].length);
  }
  const heading = leadingHeading(text);
  if (heading && (title === null || heading.text.trim() === title)) {
    title ??= heading.text.trim();
    text = text.slice(heading.end);
  }
  return { title: (title ?? fallback).slice(0, 200), body: text.replace(/^\s*\n/, "") };
}

// The two readers below go through the text once, by hand. The regexes they stand for,
// `/^title:\s*(.+?)\s*$/m` and `/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/`, try every end of the
// value against the white space after it, which takes time growing with the square (or the
// cube) of a long run of spaces.

const LINE_BREAK = /[\n\r\u2028\u2029]/g;
const isBlank = (c: string) => c === " " || c === "\t";

/** The value of front matter's first `title:` line, as `/^title:\s*(.+?)\s*$/m` captures it; null without one. */
function frontMatterTitle(front: string): string | null {
  for (let at = 0; at < front.length; ) {
    if (front.startsWith("title:", at)) {
      // The value starts at the first character that isn't white space (on a later line when the
      // line has none) and ends with the last one of its line.
      let start = at + 6;
      while (start < front.length && /\s/.test(front[start])) start++;
      if (start === front.length) return null;
      LINE_BREAK.lastIndex = start;
      const end = LINE_BREAK.exec(front)?.index ?? front.length;
      return front.slice(start, end).trimEnd();
    }
    LINE_BREAK.lastIndex = at;
    const next = LINE_BREAK.exec(front);
    if (!next) return null;
    at = next.index + 1;
  }
  return null;
}

/**
 * A `# Heading` the text starts with (after blank lines), as the regex above reads it: its text
 * (closing `#`s and the blanks around it left out) and where the text after its line starts. Null
 * without one.
 */
function leadingHeading(text: string): { text: string; end: number } | null {
  const lead = /^\s*#[ \t]/.exec(text);
  if (!lead) return null;
  const from = lead[0].length - 1;
  const newline = text.indexOf("\n", from);
  const line = text.slice(from, newline === -1 ? text.length : newline);
  // The heading's text can't run past another line break.
  if (/[\r\u2028\u2029]/.test(line)) return null;
  let start = 0;
  while (start < line.length && isBlank(line[start])) start++;
  if (start === line.length) {
    // Nothing but blanks: the last of them is the text (at least one goes before it).
    if (line.length < 2) return null;
    start = line.length - 1;
  }
  let end = line.length;
  while (end > start && isBlank(line[end - 1])) end--;
  while (end > start && line[end - 1] === "#") end--;
  while (end > start && isBlank(line[end - 1])) end--;
  return { text: line.slice(start, Math.max(end, start + 1)), end: newline === -1 ? text.length : newline + 1 };
}

/** A cell as the export writes it in a row page's property list: on one line. */
const oneLine = (value: string) =>
  // Each run of white space with a line break in it is a ", " (`/\s*\n\s*/g` would start over at each space of a long run without one).
  value.replace(/\s+/g, (run) => (run.includes("\n") ? ", " : run)).trim();

/**
 * A row page's body without the property list Leafdesk's export puts at its top (`- Status: Done`,
 * one line per filled cell in column order, the title's left out) when the list is what the export
 * writes for `cells`, the row's cells in the CSV: those values are in the row's properties already.
 * Any other body, a list the page itself starts with included, comes back as it is. Files are links
 * in the list and "name (path)" in the CSV, so values that are links aren't compared.
 */
export function stripRowProperties(body: string, headers: string[], cells: string[], titleColumn: number | null): string {
  const expected = headers
    .map((header, i) => ({ header, value: oneLine(cells[i] ?? ""), i }))
    .filter((c) => c.i !== titleColumn && c.value !== "");
  if (!expected.length) return body;
  const lines = body.split("\n");
  if (lines.length > expected.length && lines[expected.length].trim() !== "") return body;
  const matches = expected.every(({ header, value }, k) => {
    const prefix = `- ${header}: `;
    const line = lines[k] ?? "";
    if (!line.startsWith(prefix)) return false;
    const written = line.slice(prefix.length).trim();
    return written === value || written.includes("](");
  });
  return matches ? lines.slice(expected.length).join("\n").replace(/^\s*\n/, "") : body;
}

export type PlanNode = {
  /** The file's path, or a folder's path with a trailing slash. */
  key: string;
  /** Pages and folders become pages, CSV files databases, pages inside a database's folder rows. */
  kind: "page" | "database" | "row";
  /** Where the page's content comes from: its Markdown or CSV file (none for a bare folder). */
  source: string | null;
  /** The title to use when the content doesn't give one. */
  title: string;
  /**
   * A template: from a `Templates/` folder in a database's folder (a row template, kind "row") or,
   * when importing at the workspace's top level, at the top of the upload (a workspace template).
   */
  template?: boolean;
  /** Key of the node it goes under; null for the import's destination. */
  parent: string | null;
};

export type ImportPlan = {
  /** Parents before their children; siblings in name order. */
  nodes: PlanNode[];
  /** Paths that point at a node (its source, and for a folder its path with and without the slash). */
  nodeOf: Map<string, string>;
  /** Files left out, and why. */
  skipped: { path: string; reason: "nestedDatabase" | "nestedZip" | "duplicate" }[];
};

const INDEX_NAMES = ["index", "readme"];
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Which files become which pages; see the layout at the top. `paths` are normalized paths of files. */
export function planImport(paths: string[], { topLevel = false }: { topLevel?: boolean } = {}): ImportPlan {
  const skipped: ImportPlan["skipped"] = [];
  let files = [...new Set(paths)].filter((p) => !isIgnoredPath(p));
  for (const p of files) if (importFileKind(p) === "zip") skipped.push({ path: p, reason: "nestedZip" });

  // Notion exports a database twice, "Tasks.csv" and "Tasks_all.csv" (every row): keep the full one.
  const csvs = new Set(files.filter((p) => importFileKind(p) === "csv"));
  const fullOf = new Map<string, string>();
  files = files.filter((p) => {
    if (importFileKind(p) !== "csv") return true;
    const full = p.replace(/\.csv$/i, "_all.csv");
    if (full !== p && csvs.has(full)) {
      skipped.push({ path: p, reason: "duplicate" });
      fullOf.set(p, full);
      return false;
    }
    return true;
  });
  // A Markdown file with a database's own name and Notion id next to its CSV is the database's page
  // (the database is that page here): left out, and links to it lead to the database.
  const csvByStem = new Map(
    files.filter((p) => importFileKind(p) === "csv").map((p) => [p.replace(/(?:_all)?\.csv$/i, "").toLowerCase(), p]),
  );
  const twins = new Map<string, string>();
  files = files.filter((p) => {
    const stemPath = p.replace(/\.(?:md|markdown)$/i, "");
    const csv = importFileKind(p) === "markdown" && /\s[0-9a-f]{32}$/i.test(stemPath) ? csvByStem.get(stemPath.toLowerCase()) : undefined;
    if (!csv) return true;
    skipped.push({ path: p, reason: "duplicate" });
    twins.set(p, csv);
    return false;
  });
  const content = files.filter((p) => importFileKind(p) === "markdown" || importFileKind(p) === "csv");

  // Folders holding (at any depth) something that becomes a page.
  const folders = new Set<string>();
  for (const p of content) for (let d = dirname(p); d; d = dirname(d)) folders.add(d);

  // A folder's own file: a sibling Markdown or CSV file of the same name (ids and "_all" aside).
  const siblingOf = new Map<string, string>();
  for (const p of content) {
    const folder = `${dirname(p) ? `${dirname(p)}/` : ""}${stem(basename(p)).replace(/_all$/i, "")}`;
    if (folders.has(folder) && (!siblingOf.has(folder) || importFileKind(p) === "csv")) siblingOf.set(folder, p);
  }
  // A folder without one may hold its body instead: index.md, README.md or a file named like it.
  const indexOf = new Map<string, string>();
  const siblings = new Set(siblingOf.values());
  // Each folder's Markdown files, gathered once (not by going through every file for each folder).
  const markdownIn = new Map<string, string[]>();
  for (const p of content) {
    if (importFileKind(p) !== "markdown" || siblings.has(p)) continue;
    const list = markdownIn.get(dirname(p));
    if (list) list.push(p);
    else markdownIn.set(dirname(p), [p]);
  }
  for (const folder of folders) {
    if (siblingOf.has(folder)) continue;
    const own = markdownIn.get(folder) ?? [];
    const pick =
      INDEX_NAMES.map((n) => own.find((p) => stem(basename(p)).toLowerCase() === n)).find(Boolean) ??
      own.find((p) => cleanTitle(p).toLowerCase() === cleanTitle(folder).toLowerCase());
    if (pick) indexOf.set(folder, pick);
  }

  // Templates/ folders as Leafdesk's export writes them (the name is only used by the layout when
  // no page of that name sits beside it): a database's row templates, and at the top the
  // workspace's templates, which only a top-level import makes templates again.
  const templateFolders = new Set<string>();
  for (const folder of folders) {
    if (basename(folder) !== TEMPLATES_FOLDER || siblingOf.has(folder)) continue;
    const outer = dirname(folder);
    if (outer ? importFileKind(siblingOf.get(outer) ?? "") === "csv" : topLevel) templateFolders.add(folder);
  }
  for (const folder of templateFolders) indexOf.delete(folder);
  const indexFiles = new Set(indexOf.values());

  const folderKey = (folder: string): string | null =>
    !folder ? null : templateFolders.has(folder) ? folderKey(dirname(folder)) : (siblingOf.get(folder) ?? `${folder}/`);
  const draft = new Map<string, PlanNode>();
  for (const p of content) {
    if (indexFiles.has(p)) continue;
    draft.set(p, {
      key: p,
      kind: importFileKind(p) === "csv" ? "database" : "page",
      source: p,
      title: cleanTitle(p) || "Untitled",
      parent: folderKey(dirname(p)),
      ...(templateFolders.has(dirname(p)) ? { template: true } : {}),
    });
  }
  for (const folder of folders) {
    if (siblingOf.has(folder) || templateFolders.has(folder)) continue;
    const key = `${folder}/`;
    draft.set(key, {
      key,
      kind: "page",
      source: indexOf.get(folder) ?? null,
      title: cleanTitle(folder) || "Untitled",
      parent: folderKey(dirname(folder)),
      ...(templateFolders.has(dirname(folder)) ? { template: true } : {}),
    });
  }

  // Inside a database: pages are rows (or row templates); a database can't hold another database.
  const depth = new Map<string, number>();
  const depthOf = (node: PlanNode): number => {
    if (depth.has(node.key)) return depth.get(node.key)!;
    const d = node.parent ? depthOf(draft.get(node.parent)!) + 1 : 0;
    depth.set(node.key, d);
    return d;
  };
  const dropped = new Set<string>();
  const ordered = [...draft.values()].sort(
    (a, b) => depthOf(a) - depthOf(b) || collator.compare(a.title, b.title) || collator.compare(a.key, b.key),
  );
  const nodes: PlanNode[] = [];
  for (const node of ordered) {
    const parent = node.parent ? draft.get(node.parent)! : null;
    if (parent && dropped.has(parent.key)) {
      dropped.add(node.key);
      continue;
    }
    if (parent?.kind === "database") {
      if (node.kind === "database") {
        skipped.push({ path: node.source ?? node.key, reason: "nestedDatabase" });
        dropped.add(node.key);
        continue;
      }
      node.kind = "row";
    }
    nodes.push(node);
  }

  const nodeOf = new Map<string, string>();
  for (const node of nodes) {
    if (node.source) nodeOf.set(node.source, node.key);
    nodeOf.set(node.key, node.key);
    if (node.key.endsWith("/")) nodeOf.set(node.key.slice(0, -1), node.key);
  }
  // A link to a folder with its own file means that file's page.
  for (const [folder, file] of siblingOf) if (nodeOf.has(file)) nodeOf.set(folder, file);
  // …and a link to the CSV left out for its full twin means the database.
  for (const [partial, full] of fullOf) if (nodeOf.has(full)) nodeOf.set(partial, nodeOf.get(full)!);
  // …and so does a link to a database's own Markdown file.
  for (const [twin, csv] of twins) if (nodeOf.has(csv)) nodeOf.set(twin, nodeOf.get(csv)!);
  return { nodes, nodeOf, skipped };
}

/**
 * `href` without its query and fragment, as `href.replace(/[?#].*$/, "")` leaves it: from the
 * first `?` or `#` after its last line break on. Found without that regex, which would read to the
 * end from each `?` before a line break.
 */
export function withoutQuery(href: string): string {
  const line = Math.max(href.lastIndexOf("\n"), href.lastIndexOf("\r"), href.lastIndexOf("\u2028"), href.lastIndexOf("\u2029")) + 1;
  const at = href.slice(line).search(/[?#]/);
  return at === -1 ? href : href.slice(0, line + at);
}

/**
 * Where a link in the file at `from` points inside the upload, as a normalized path; null for
 * links elsewhere (a URL, an absolute path, an anchor on the same page) or out of the upload.
 */
export function resolveLink(from: string, href: string): string | null {
  let target = href.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  target = withoutQuery(target);
  try {
    target = decodeURIComponent(target);
  } catch {}
  return normalizePath(`${dirname(from)}/${target}`);
}

/** Markdown links and images, `[text](target "title")` / `![alt](<target with spaces>)`: the text… */
const LINK_TEXT = /\[((?:\\.|[^\]\\\n])*)/y;
/** …then the target, and its title. */
const LINK_TARGET = /\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/y;
/** Reference definitions, `[id]: target`. */
const DEFINITION = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^<>\n]*>|\S+)/;
/** Images written as HTML: where one starts… */
const IMG_START = /<img\b/gi;
/** …and its source. */
const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"'\n]*)\2/iy;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Where a link points (`path`, see resolveLink), whether it's an image, and its href as written. */
export type LinkTarget = { path: string; image: boolean; href: string };

type Found = { start: number; end: number };
type MarkdownLink = Found & { image: boolean; text: string; href: string; title: string | undefined };

/**
 * The links (or only the images) of a line, as a global regex of LINK_TEXT and LINK_TARGET would
 * find them, `!` before an image's `[` included. By hand, in time growing with the line's length:
 * the regex would read the rest of the line again from each `[` of a long run. A text no target
 * follows starts no link, and neither does a `[` inside it (its text ends at the same `]`), so the
 * search goes on after it.
 */
function markdownLinks(line: string, { images = false }: { images?: boolean } = {}): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let from = 0;
  for (let open = line.indexOf("["); open !== -1; open = line.indexOf("[", from)) {
    const image = open > from && line[open - 1] === "!";
    if (images && !image) {
      from = open + 1;
      continue;
    }
    LINK_TEXT.lastIndex = open;
    const text = LINK_TEXT.exec(line)![1];
    LINK_TARGET.lastIndex = LINK_TEXT.lastIndex;
    const target = LINK_TARGET.exec(line);
    if (!target) {
      from = LINK_TEXT.lastIndex;
      continue;
    }
    from = LINK_TARGET.lastIndex;
    links.push({ start: image ? open - 1 : open, end: from, image, text, href: target[1], title: target[2] });
  }
  return links;
}

/**
 * The `<img … src="…">` tags of a line, as a global IMG_SRC would find them. One that has no
 * source before its `>` leaves none to the tags starting before that `>`, so the search goes on
 * from there (the regex would read up to it again from each of them).
 */
function imgTags(line: string): (Found & { head: string; quote: string; src: string })[] {
  const tags: (Found & { head: string; quote: string; src: string })[] = [];
  IMG_START.lastIndex = 0;
  for (let start = IMG_START.exec(line); start; start = IMG_START.exec(line)) {
    IMG_SRC.lastIndex = start.index;
    const tag = IMG_SRC.exec(line);
    if (tag) {
      tags.push({ start: start.index, end: IMG_SRC.lastIndex, head: tag[1], quote: tag[2], src: tag[3] });
      IMG_START.lastIndex = IMG_SRC.lastIndex;
    } else {
      const close = line.indexOf(">", start.index);
      if (close === -1) break;
      IMG_START.lastIndex = close;
    }
  }
  return tags;
}

/** `text` with each of `found` (in order, not overlapping) replaced by what `fn` returns for it. */
function replaceFound<T extends Found>(text: string, found: T[], fn: (item: T) => string): string {
  let out = "";
  let last = 0;
  for (const item of found) {
    out += text.slice(last, item.start) + fn(item);
    last = item.end;
  }
  return out + text.slice(last);
}

/**
 * Images in a line of text moved to lines of their own after it: images are blocks in the editor,
 * and one amid text would otherwise be dropped. Lines in code and table rows stay as they are.
 */
export function liftImages(markdown: string): string {
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
      if (/^\s*\|/.test(line)) return line;
      const found = markdownLinks(line, { images: true });
      if (!found.length) return line;
      const images = found.map((image) => line.slice(image.start, image.end));
      const rest = replaceFound(line, found, () => "").trimEnd();
      // A line of nothing but images (after its list marker or quote, if any) is fine as it is.
      if (!rest.replace(/^\s*(?:[-*+]|\d+[.)]|>)?\s*/, "").trim()) return images.length === 1 ? line : images.join("\n\n");
      return [rest, ...images].join("\n\n");
    })
    .join("\n");
}

/**
 * `markdown` with every link, image and reference definition that points inside the upload
 * (relative to `from`) replaced by what `replace` returns for it; ones it returns null for, and
 * everything in code, stay as they are.
 */
export function rewriteLinks(markdown: string, from: string, replace: (target: LinkTarget) => string | null): string {
  const swap = (href: string, image: boolean): string | null => {
    const path = resolveLink(from, href);
    return path ? replace({ path, image, href }) : null;
  };
  const inline = (text: string) => {
    const linked = replaceFound(text, markdownLinks(text), ({ start, end, image, text: label, href, title }) => {
      const next = swap(href, image);
      return next === null ? text.slice(start, end) : `${image ? "!" : ""}[${label}](${next}${title ?? ""})`;
    });
    return replaceFound(linked, imgTags(linked), ({ start, end, head, quote, src }) => {
      const next = swap(src, true);
      return next === null ? linked.slice(start, end) : `${head}${quote}${next}${quote}`;
    });
  };

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
      const definition = DEFINITION.exec(line);
      if (definition) {
        const next = swap(definition[2], false);
        return next === null ? line : definition[1] + next + line.slice(definition[0].length);
      }
      // Leave inline code spans alone.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : inline(part)))
        .join("");
    })
    .join("\n");
}
