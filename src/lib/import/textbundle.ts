import { decodeText } from "./csv-parse";
import { rewriteLinks } from "./markdown";

/**
 * TextBundles and TextPacks in a Markdown import (see server/import/markdown.ts). A TextBundle is
 * a folder `Name.textbundle/` holding `info.json` (its version and the text's type), the text as
 * `text.md` (or `text.markdown`, or `text.txt` for plain text) and `assets/` with the files the
 * text links to (`![](assets/photo.jpg)`). A TextPack (`Name.textpack`) is a TextBundle in a ZIP;
 * server/import/archive unpacks it into its bundle folder beside where it was (textPackFolder).
 *
 * Each bundle with a text becomes one Markdown file of the upload, `Name.md` beside the bundle
 * folder, its links pointed from there at the same files; the assets stay where they were, so the
 * Markdown import uploads the ones the text shows, as it does for any note's pictures and files,
 * and reports those it doesn't. `info.json` goes. A bundle without a text is left as it is.
 */

const BUNDLE = /\.textbundle$/i;
const TEXT_EXTENSIONS = ["md", "markdown", "txt"];

export const isTextPack = (path: string) => /\.textpack$/i.test(path);

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The bundle folder a file is in (`Notes/Trip.textbundle` for `Notes/Trip.textbundle/assets/a.png`), or null. */
export function bundleFolder(path: string): string | null {
  const segments = path.split("/");
  const at = segments.findIndex((segment, i) => i < segments.length - 1 && BUNDLE.test(segment));
  return at === -1 ? null : segments.slice(0, at + 1).join("/");
}

/**
 * Where a TextPack's entries go, as a prefix for their paths: beside the pack when they are in
 * `Name.textbundle/` folders of their own (as zipping the bundle writes them), else in a bundle
 * folder named after the pack (zipped from inside the bundle).
 */
export function textPackFolder(packPath: string, entries: string[]): string {
  const dir = dirname(packPath) ? `${dirname(packPath)}/` : "";
  if (entries.length && entries.every((p) => bundleFolder(p)?.split("/").length === 1)) return dir;
  return `${dir}${basename(packPath).replace(/\.textpack$/i, "")}.textbundle/`;
}

/** The text's type from `info.json` (a uniform type identifier), or null. */
function bundleType(info: Uint8Array | undefined): string | null {
  if (!info || info.byteLength > 64 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(decodeText(info));
    const type = parsed && typeof parsed === "object" ? (parsed as { type?: unknown }).type : null;
    return typeof type === "string" ? type.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The bundle's text file among the files right inside it: the one its type names first, else Markdown before plain text. */
function textFile(folder: string, files: Map<string, Uint8Array>): string | null {
  const type = bundleType(files.get(`${folder}/info.json`));
  const order = type === "public.plain-text" ? ["txt", "md", "markdown"] : TEXT_EXTENSIONS;
  const inside = [...files.keys()].filter((p) => dirname(p) === folder);
  for (const ext of order) {
    const found = inside.find((p) => basename(p).toLowerCase() === `text.${ext}`);
    if (found) return found;
  }
  return null;
}

/** `path` as a link from the file at `from`: relative, each part URL-encoded (resolveLink decodes it). */
function hrefFrom(from: string, path: string): string {
  const fromDir = dirname(from) ? dirname(from).split("/") : [];
  const parts = path.split("/");
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  return [...fromDir.slice(common).map(() => ".."), ...parts.slice(common).map(encodeURIComponent)].join("/");
}

/**
 * The upload's files with each TextBundle's text as a Markdown file beside its folder (see
 * above), and how many bundles there were.
 */
export function unpackTextBundles(files: Map<string, Uint8Array>): { files: Map<string, Uint8Array>; bundles: number } {
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const folder = bundleFolder(path);
    if (folder) folders.add(folder);
  }
  if (!folders.size) return { files, bundles: 0 };

  // Each bundle's text, and the Markdown file it becomes: `Name.md`, numbered when that is taken.
  const taken = new Set([...files.keys()].map((p) => p.toLowerCase()));
  const moved = new Map<string, { text: string; to: string }>();
  for (const folder of [...folders].sort()) {
    const text = textFile(folder, files);
    if (!text) continue;
    const dir = dirname(folder) ? `${dirname(folder)}/` : "";
    const name = basename(folder).replace(BUNDLE, "").trim() || "Untitled";
    let to = `${dir}${name}.md`;
    for (let n = 2; taken.has(to.toLowerCase()); n++) to = `${dir}${name} (${n}).md`;
    taken.add(to.toLowerCase());
    moved.set(folder, { text, to });
  }
  if (!moved.size) return { files, bundles: 0 };

  // A link to another bundle (its folder or its text) leads to that bundle's Markdown file.
  const pageOf = new Map<string, string>();
  for (const [folder, { text, to }] of moved) {
    pageOf.set(folder, to);
    pageOf.set(text, to);
  }
  const out = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const [path, bytes] of files) {
    const folder = bundleFolder(path);
    const bundle = folder ? moved.get(folder) : undefined;
    if (!bundle) {
      out.set(path, bytes);
      continue;
    }
    if (path === `${folder}/info.json`) continue;
    if (path !== bundle.text) {
      out.set(path, bytes);
      continue;
    }
    const markdown = rewriteLinks(decodeText(bytes), path, ({ path: target }) => hrefFrom(bundle.to, pageOf.get(target) ?? target));
    out.set(bundle.to, encoder.encode(markdown));
  }
  return { files: out, bundles: moved.size };
}
