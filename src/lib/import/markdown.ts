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

/** A file or folder name as a title: no extension, no Notion id, no stray whitespace. */
export function cleanTitle(name: string): string {
  return stem(basename(name))
    .replace(/_all$/i, "")
    .replace(/\s+[0-9a-f]{32}$/i, "")
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
    const line = /^title:\s*(.+?)\s*$/m.exec(front[1]);
    if (line) title = line[1].replace(/^(["'])(.*)\1$/, "$2").trim() || null;
    text = text.slice(front[0].length);
  }
  const heading = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(text);
  if (heading && (title === null || heading[1].trim() === title)) {
    title ??= heading[1].trim();
    text = text.slice(heading[0].length);
  }
  return { title: (title ?? fallback).slice(0, 200), body: text.replace(/^\s*\n/, "") };
}

/** A cell as the export writes it in a row page's property list: on one line. */
const oneLine = (value: string) => value.replace(/\s*\n\s*/g, ", ").trim();

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
  for (const folder of folders) {
    if (siblingOf.has(folder)) continue;
    const own = content.filter((p) => dirname(p) === folder && importFileKind(p) === "markdown" && !siblings.has(p));
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
 * Where a link in the file at `from` points inside the upload, as a normalized path; null for
 * links elsewhere (a URL, an absolute path, an anchor on the same page) or out of the upload.
 */
export function resolveLink(from: string, href: string): string | null {
  let target = href.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  target = target.replace(/[?#].*$/, "");
  try {
    target = decodeURIComponent(target);
  } catch {}
  return normalizePath(`${dirname(from)}/${target}`);
}

/** Markdown links and images, `[text](target "title")` / `![alt](<target with spaces>)`. */
const LINK = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** Reference definitions, `[id]: target`. */
const DEFINITION = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^<>\n]*>|\S+)/;
/** Images written as HTML. */
const IMG_TAG = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"'\n]*)\2/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Where a link points (`path`, see resolveLink), whether it's an image, and its href as written. */
export type LinkTarget = { path: string; image: boolean; href: string };

const IMAGE = /!\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

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
      const images = line.match(IMAGE);
      if (!images) return line;
      const rest = line.replace(IMAGE, "").trimEnd();
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
  const inline = (text: string) =>
    text
      .replace(LINK, (whole, bang: string, label: string, href: string, title: string | undefined) => {
        const next = swap(href, bang === "!");
        return next === null ? whole : `${bang}[${label}](${next}${title ?? ""})`;
      })
      .replace(IMG_TAG, (whole, head: string, quote: string, src: string) => {
        const next = swap(src, true);
        return next === null ? whole : `${head}${quote}${next}${quote}`;
      });

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
