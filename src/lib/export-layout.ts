/**
 * Where each page of a ZIP export goes, and how links inside its Markdown are rewritten to point
 * into the archive. Pure helpers: the server (server/export.ts) loads the pages and files and
 * streams the archive; tests run these on their own.
 *
 * Layout, like the sidebar:
 *
 *   Project.md                   a page …
 *   Project/                     … and, when it has subpages, a folder of the same name
 *     Tasks.csv                  a database: its rows as CSV …
 *     Tasks/                     … and its row pages (with their own subpages)
 *       Write docs.md
 *       Templates/               the database's row templates, apart from the rows
 *   Templates/                   workspace templates (whole-workspace exports only)
 *   files/                       uploaded files the exported pages and rows show
 *     photo.png
 *
 * Names come from titles, made safe for every common file system and unique within their folder
 * (case-insensitively: "Notes", "notes (2)").
 */

export type ExportNode = {
  id: string;
  /** Null, or a page that isn't part of the export: the node goes to the top of the archive. */
  parentId: string | null;
  kind: "page" | "database";
  title: string;
  /** A template: a workspace template (top level) or a row template (parent is a database). */
  isTemplate: boolean;
};

export type ExportFile = { id: string; name: string };

export type ExportLayout = {
  /** Archive path of each node's own file: `A/B.md`, `A/Tasks.csv`. */
  paths: Map<string, string>;
  /** Archive path of each exported file. */
  files: Map<string, string>;
};

/** Folder names the layout itself uses. */
export const FILES_FOLDER = "files";
export const TEMPLATES_FOLDER = "Templates";

/** Longest name (in characters) taken from a title; longer titles are cut. */
export const MAX_NAME = 80;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A title as a file or folder name: no path separators or characters Windows refuses, no control
 * characters, no leading dots (hidden files) or trailing dots and spaces, not a reserved device
 * name, at most MAX_NAME characters; `fallback` when nothing is left.
 */
export function safeName(title: string, fallback = "Untitled", max = MAX_NAME): string {
  let name = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const chars = Array.from(name);
  if (chars.length > max) name = chars.slice(0, max).join("");
  name = name.replace(/[. ]+$/, "");
  if (!name) return fallback;
  return WINDOWS_RESERVED.test(name) ? `${name}_` : name;
}

/** A file's name made safe like `safeName`, keeping its extension when the name is cut. */
export function safeFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? safeName(name.slice(dot + 1), "", 15) : "";
  const base = safeName(ext ? name.slice(0, dot) : name, "file");
  return ext ? `${base}.${ext}` : base;
}

/** Hands out names unique within one folder, ignoring case: "Notes", "Notes (2)", … */
class Folder {
  private taken = new Set<string>();

  reserve(name: string) {
    this.taken.add(name.toLowerCase());
  }

  /** A free name for `base` (+ `ext`, which is left out of the comparison of names). */
  claim(base: string, ext = ""): string {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} (${n})`;
      if (!this.taken.has(name.toLowerCase())) {
        this.taken.add(name.toLowerCase());
        return name + ext;
      }
    }
  }
}

/**
 * Places `nodes` (in the order siblings should be named, usually their sidebar order) and
 * `files` in the archive. A node whose parent is not among `nodes` goes to the top level, as a
 * page shared on its own does in the sidebar.
 */
export function layoutExport(nodes: ExportNode[], files: ExportFile[] = [], untitled = "Untitled"): ExportLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, ExportNode[]>();
  const templatesOf = new Map<string | null, ExportNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    const parentIsDatabase = parent !== null && byId.get(parent)!.kind === "database";
    // Workspace templates (top level) and row templates (under their database) are kept apart.
    const apart = node.isTemplate && (parent === null || parentIsDatabase);
    const list = apart ? templatesOf : children;
    list.set(parent, [...(list.get(parent) ?? []), node]);
  }

  const paths = new Map<string, string>();
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  // Every node gets its name in its folder before any of its children are placed.
  const place = (dir: string, list: ExportNode[], folder: Folder) => {
    for (const node of list) {
      const base = folder.claim(safeName(node.title, untitled));
      paths.set(node.id, join(dir, base + (node.kind === "database" ? ".csv" : ".md")));
    }
    for (const node of list) {
      const own = children.get(node.id) ?? [];
      const templates = templatesOf.get(node.id) ?? [];
      if (!own.length && !templates.length) continue;
      const path = paths.get(node.id)!;
      const inner = path.slice(0, path.lastIndexOf("."));
      const sub = new Folder();
      if (templates.length) sub.reserve(TEMPLATES_FOLDER);
      place(inner, own, sub);
      if (templates.length) place(join(inner, TEMPLATES_FOLDER), templates, new Folder());
    }
  };

  const top = new Folder();
  if (files.length) top.reserve(FILES_FOLDER);
  const topTemplates = templatesOf.get(null) ?? [];
  if (topTemplates.length) top.reserve(TEMPLATES_FOLDER);
  place("", children.get(null) ?? [], top);
  if (topTemplates.length) place(TEMPLATES_FOLDER, topTemplates, new Folder());

  const filePaths = new Map<string, string>();
  const filesFolder = new Folder();
  for (const f of files) {
    const name = safeFileName(f.name);
    const dot = name.lastIndexOf(".");
    const claimed = dot > 0 ? filesFolder.claim(name.slice(0, dot), name.slice(dot)) : filesFolder.claim(name);
    filePaths.set(f.id, `${FILES_FOLDER}/${claimed}`);
  }
  return { paths, files: filePaths };
}

/** Characters that would end or break a Markdown link destination, percent-encoded. */
function encodeSegment(segment: string) {
  return segment.replace(/[\s()<>%#?[\]\\^`{}|"']/g, (c) =>
    Array.from(new TextEncoder().encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

/** The link from the file at archive path `from` to the one at `to`, relative and URL-safe. */
export function relativeLink(from: string, to: string): string {
  const fromDir = from.split("/").slice(0, -1);
  const target = to.split("/");
  let common = 0;
  while (common < fromDir.length && common < target.length - 1 && fromDir[common] === target[common]) common++;
  const up = fromDir.slice(common).map(() => "..");
  return [...up, ...target.slice(common)].map((s) => (s === ".." ? s : encodeSegment(s))).join("/");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether each line is inside fenced code (the fence lines included). */
function codeLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[0].trim().length)) fence = null;
      return true;
    }
    if (open) fence = open[1];
    return Boolean(open);
  });
}

const PAGE_LINK = /\]\(\s*<?((?:https?:\/\/[^\s()<>]+?)?(\/w\/[\w-]{1,128}\/p\/([\w-]{1,128}))\/?(#block-[\w-]{1,100})?)>?\s*\)/g;
const FILE_URL = /(?:https?:\/\/[^\s()<>[\]"']+?)?\/api\/files\/([A-Za-z0-9_-]{24})(?:\?view=pdf)?(?![A-Za-z0-9_-])/g;

export type LinkTargets = {
  /** Archive path of an exported page or database, by id. */
  page: (id: string) => string | undefined;
  /** Archive path of an exported file, by id. */
  file: (id: string) => string | undefined;
  /** The app's address, for links to what isn't in the archive. */
  appUrl: string;
};

/**
 * Markdown of the page at archive path `from` with its links pointing into the archive: links to
 * exported pages and databases become relative `.md`/`.csv` links, uploaded files relative links
 * into `files/`. Links to pages and files left out of the export point at the app instead of
 * staying root-relative (which means nothing outside the app). Fenced code is left alone.
 */
export function rewriteLinks(markdown: string, from: string, targets: LinkTargets): string {
  if (!markdown.includes("/p/") && !markdown.includes("/api/files/")) return markdown;
  const app = targets.appUrl.replace(/\/+$/, "");
  const lines = markdown.split("\n");
  const code = codeLines(lines);
  return lines
    .map((line, i) => {
      if (code[i]) return line;
      return line
        .replace(PAGE_LINK, (whole, _href: string, path: string, id: string, block: string | undefined) => {
          // A link to one block points at the page's file (block ids mean nothing in the archive),
          // or at that block in the app.
          const to = targets.page(id);
          if (to) return `](${relativeLink(from, to)})`;
          return whole.includes("://") ? whole : `](${app}${path}${block ?? ""})`;
        })
        .replace(FILE_URL, (whole, id: string) => {
          const to = targets.file(id);
          if (to) return relativeLink(from, to);
          return whole.startsWith("/") ? `${app}${whole}` : whole;
        });
    })
    .join("\n");
}
