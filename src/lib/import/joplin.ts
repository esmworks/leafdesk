/**
 * Joplin's JEX export in a Markdown import (see server/import/markdown.ts). A JEX file is a tar
 * archive (server/import/archive unpacks it into a folder of its own name, `Notes.jex/`) of one
 * file per item, `<id>.md`, and the resources' bytes as `resources/<id>.<ext>`. An item file is its
 * title, a blank line, its body (for notes) and, after another blank line, `key: value` lines; the
 * `type_` says what it is: 1 a note, 2 a notebook, 4 a resource, 5 a tag, 6 a note's tag.
 *
 * Each export becomes Markdown files beside where the JEX was: notebooks as folders (so pages with
 * their notes under them), notes as `Title.md`, resources as `_resources/<id>/<name>`. Links to
 * notes and resources (`:/<id>`, in Markdown and HTML alike) point at those files, so the Markdown
 * import links the pages and uploads the files the notes show. A to-do note starts with its
 * checkbox (and its due day, in the importing person's time zone, as a date mention), and a note's tags end it as `#tags`. Notes and
 * notebooks in Joplin's trash are left out, and so are encrypted items, which are counted.
 *
 * Pure: only file names and text.
 */

import { decodeText } from "./csv-parse";

const JEX_FOLDER = /\.jex$/i;
const ID = /^[0-9a-f]{32}$/;
const HEX = /[0-9a-f]/;

const TYPE = { note: 1, folder: 2, resource: 4, tag: 5, noteTag: 6 } as const;

/** A JEX export's folder in the upload (the archive unpacked under its own name), or null. */
export function jexFolder(path: string): string | null {
  const segments = path.split("/");
  const at = segments.findIndex((segment, i) => i < segments.length - 1 && JEX_FOLDER.test(segment));
  return at === -1 ? null : segments.slice(0, at + 1).join("/");
}

export const isJex = (path: string) => JEX_FOLDER.test(path);

type Item = { title: string; body: string; props: Map<string, string> };

/**
 * One item file as Joplin reads it back: `key: value` lines from the end up to the first blank
 * line, then the title (the first line) and the body (after the line below it).
 */
export function readItem(text: string): Item | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const props = new Map<string, string>();
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  for (; end > 0; end--) {
    const line = lines[end - 1].trim();
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon < 1) return null;
    props.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (!props.has("type_") || !props.has("id")) return null;
  const rest = lines.slice(0, Math.max(0, end - 1));
  return { title: rest[0] ?? "", body: rest.slice(2).join("\n"), props };
}

/** A name for a file or folder: no slashes, no leading dot (hidden files are left out), not too long. */
function safeName(name: string): string {
  let out = name.replace(/[/\\]/g, "-").replace(/[\u0000-\u001f]/g, " ").trim();
  while (out.startsWith(".")) out = out.slice(1);
  return out.slice(0, 150).trim();
}

/** The first line of text a body has, for a note without a title. */
function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^[#>*\-+\s]+/, "").trim();
    if (text) return text.slice(0, 80);
  }
  return "";
}

/** `name` made unique among `taken` (without case): `Name (2)`, `Name (3)` … */
function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** `path` as a link from the file at `from`: relative, each part URL-encoded. */
function hrefFrom(from: string, path: string): string {
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  const parts = path.split("/");
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  return [...fromDir.slice(common).map(() => ".."), ...parts.slice(common).map(encodeURIComponent)].join("/");
}

/**
 * The body with each `:/<id>` naming an item of the export replaced by `href(id)`; others stay.
 * Read by hand: a run of colons and slashes is passed over once.
 */
export function rewriteItemLinks(body: string, href: (id: string) => string | null): string {
  let out = "";
  let at = 0;
  for (let i = body.indexOf(":/"); i !== -1; i = body.indexOf(":/", i + 2)) {
    const id = body.slice(i + 2, i + 34);
    if (id.length !== 32 || !ID.test(id) || HEX.test(body[i + 34] ?? "")) continue;
    const target = href(id);
    if (target === null) continue;
    out += body.slice(at, i) + target;
    at = i + 34;
    i += 32;
  }
  return out + body.slice(at);
}

/** A tag's name as a `#tag`: spaces as dashes, other characters a tag can't hold left out; null without a letter. */
function tagText(name: string): string | null {
  // Short first: the trimming below walks back over each run of dashes.
  const body = name
    .slice(0, 100)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{M}\p{N}_\-/]/gu, "")
    .replace(/^[-/]+|[-/]+$/g, "");
  return /\p{L}/u.test(body) ? `#${body}` : null;
}

/** A day from a Joplin time (milliseconds since 1970, "0" for none) as `YYYY-MM-DD` in `timeZone`, or null. */
function dayOf(value: string | undefined, timeZone: string): string | null {
  const ms = Number(value);
  if (!value || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    // en-CA writes days as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Whether an item is in Joplin's trash. */
const trashed = (item: Item) => {
  const deleted = item.props.get("deleted_time");
  return Boolean(deleted && deleted !== "0");
};

export type JoplinResult = {
  files: Map<string, Uint8Array>;
  /** JEX exports read. */
  exports: number;
  /** Encrypted items left out, by the export's file name. */
  encrypted: { export: string; count: number }[];
};

/**
 * The upload's files with each JEX export's items as Markdown files and resources beside where
 * the export was (see above). An export folder holding no item is left as it is.
 */
export function unpackJoplinExports(files: Map<string, Uint8Array>, timeZone = "UTC"): JoplinResult {
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const folder = jexFolder(path);
    if (folder) folders.add(folder);
  }
  if (!folders.size) return { files, exports: 0, encrypted: [] };
  const out = new Map(files);
  const encrypted: JoplinResult["encrypted"] = [];
  let exports = 0;
  for (const folder of folders) {
    const inside = [...files.keys()].filter((p) => p.startsWith(`${folder}/`));
    const items = new Map<string, Item>();
    const blobs = new Map<string, string>();
    let locked = 0;
    for (const path of inside) {
      const name = path.slice(folder.length + 1);
      if (name.startsWith("resources/")) {
        const id = name.slice("resources/".length).replace(/\.[^.]*$/, "");
        if (ID.test(id)) blobs.set(id, path);
        continue;
      }
      if (!/^[0-9a-f]{32}\.md$/.test(name)) continue;
      const item = readItem(decodeText(files.get(path)!));
      if (!item) continue;
      if (item.props.get("encryption_applied") === "1") {
        locked++;
        continue;
      }
      items.set(item.props.get("id")!, item);
    }
    if (!items.size) continue;
    exports++;
    if (locked) encrypted.push({ export: folder.slice(folder.lastIndexOf("/") + 1), count: locked });
    for (const path of inside) out.delete(path);
    const base = folder.includes("/") ? `${folder.slice(0, folder.lastIndexOf("/"))}/` : "";

    const ofType = (type: number) => [...items.values()].filter((i) => Number(i.props.get("type_")) === type);
    const folderItems = new Map(ofType(TYPE.folder).filter((f) => !trashed(f)).map((f) => [f.props.get("id")!, f]));

    // Where each notebook goes: under its parent notebook, or at the top when that isn't in the export.
    const taken = new Map<string, Set<string>>();
    const takenIn = (dir: string) => {
      if (!taken.has(dir)) taken.set(dir, new Set());
      return taken.get(dir)!;
    };
    const folderPath = new Map<string, string>();
    const pathOfFolder = (id: string, seen = new Set<string>()): string => {
      const known = folderPath.get(id);
      if (known !== undefined) return known;
      const item = folderItems.get(id)!;
      const parent = item.props.get("parent_id") ?? "";
      const dir = folderItems.has(parent) && !seen.has(parent) ? `${pathOfFolder(parent, seen.add(id))}/` : base;
      const path = `${dir}${unique(safeName(item.title) || id, takenIn(dir))}`;
      folderPath.set(id, path);
      return path;
    };
    for (const id of folderItems.keys()) pathOfFolder(id);

    // Resources: the bytes under the name they had.
    const resourcePath = new Map<string, string>();
    for (const resource of ofType(TYPE.resource)) {
      const id = resource.props.get("id")!;
      const blob = blobs.get(id);
      if (!blob) continue;
      const extension = resource.props.get("file_extension") || blob.slice(blob.lastIndexOf("/") + 1).replace(/^[^.]*\.?/, "");
      let name = safeName(resource.props.get("filename") || resource.title) || id;
      if (extension && !name.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) name = `${name}.${extension}`;
      const path = `${base}_resources/${id}/${name}`;
      resourcePath.set(id, path);
      out.set(path, files.get(blob)!);
    }

    // Tags by note.
    const tagNames = new Map(ofType(TYPE.tag).map((t) => [t.props.get("id")!, t.title]));
    const tagsOf = new Map<string, string[]>();
    for (const link of ofType(TYPE.noteTag)) {
      const note = link.props.get("note_id") ?? "";
      const tag = tagNames.get(link.props.get("tag_id") ?? "");
      if (tag) tagsOf.set(note, [...(tagsOf.get(note) ?? []), tag]);
    }

    // Notes: their paths first, so links between them can be written.
    const notes = ofType(TYPE.note).filter((n) => !trashed(n) && n.props.get("is_conflict") !== "1");
    const notePath = new Map<string, string>();
    for (const note of notes) {
      const parent = note.props.get("parent_id") ?? "";
      const dir = folderItems.has(parent) ? `${folderPath.get(parent)}/` : base;
      const title = safeName(note.title) || safeName(firstLine(note.body)) || note.props.get("id")!;
      notePath.set(note.props.get("id")!, `${dir}${unique(title, takenIn(dir))}.md`);
    }
    for (const note of notes) {
      const id = note.props.get("id")!;
      const path = notePath.get(id)!;
      let body = rewriteItemLinks(note.body, (target) => {
        const to = notePath.get(target) ?? resourcePath.get(target);
        return to ? hrefFrom(path, to) : null;
      });
      if (note.props.get("is_todo") === "1") {
        const done = Number(note.props.get("todo_completed")) > 0;
        const due = dayOf(note.props.get("todo_due"), timeZone);
        body = `- [${done ? "x" : " "}] ${note.title.trim() || title(path)}${due ? ` @${due}` : ""}\n\n${body}`;
      }
      const tags = (tagsOf.get(id) ?? []).map(tagText).filter((t): t is string => t !== null);
      if (tags.length) body = `${body.trimEnd()}\n\n${tags.join(" ")}\n`;
      // The note's title is its file name; front matter keeps one a file name can't hold.
      const front = note.title.trim() ? `---\ntitle: "${note.title.trim()}"\n---\n\n` : "";
      out.set(path, new TextEncoder().encode(front + body));
    }
  }
  return { files: out, exports, encrypted };
}

const title = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
