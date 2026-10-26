import { strToU8, unzipSync } from "fflate";
import { IMPORT_LIMITS, importFileKind, isIgnoredPath, normalizePath } from "@/lib/import/markdown";
import { isVaultSettingsPath } from "@/lib/import/obsidian";
import { ImportError } from "@/lib/import/result";
import { isTextPack, textPackFolder } from "@/lib/import/textbundle";

/**
 * The files of an upload by path: loose files as they came (a folder picked in the browser keeps
 * its relative paths), and ZIP files unpacked in place of themselves. Several ZIPs (Notion splits
 * large exports into parts) merge into one tree, and ZIPs inside a ZIP are unpacked once more
 * (Notion's `Export-<id>.zip` holding `Export-<id>-Part-1.zip`, `…-Part-2.zip`). A TextPack (a
 * zipped TextBundle, see lib/import/textbundle) is unpacked into its bundle folder where it was,
 * counting as a ZIP for the nesting.
 *
 * Unpacking is bounded before it starts: entry sizes come from the ZIP's directory and the
 * decompressor never writes past them, so a ZIP bomb can't take more memory than the limits. An
 * entry counts as the larger of its two sizes: a stored entry is copied at its packed size whatever
 * its unpacked size says, and many directory records can point at the same packed bytes.
 * Entries whose path climbs out of the archive (`../…`) are left out and reported.
 */

export type UploadedFile = { path: string; data: Uint8Array };

export type SkippedFile = { path: string; reason: "nestedZip" | "unsafePath" | "deepPath" };

/**
 * Whether a normalized path is longer or deeper than an import takes (IMPORT_LIMITS): planning the
 * pages goes through every folder of every path, which for crafted ones would take very long.
 */
const tooDeep = (path: string) => path.length > IMPORT_LIMITS.pathChars || path.split("/").length > IMPORT_LIMITS.pathDepth;

type Budget = { files: number; bytes: number };

function take(budget: Budget, bytes: number) {
  budget.files++;
  budget.bytes += bytes;
  if (budget.files > IMPORT_LIMITS.files) {
    throw new ImportError(`An import can hold at most ${IMPORT_LIMITS.files} files`, "tooManyFiles", { limit: IMPORT_LIMITS.files });
  }
  if (budget.bytes > IMPORT_LIMITS.unpackedBytes) {
    throw new ImportError("The unpacked files are too large to import", "tooLarge", { limit: IMPORT_LIMITS.unpackedBytes });
  }
}

/** A path to show for an entry that has no safe one: its name, shortened. */
const shown = (name: string) => (name.length > 200 ? `${name.slice(0, 199)}…` : name);

/**
 * An entry's name as its ZIP meant it. Names are read as Latin-1 unless the entry flags them as
 * UTF-8, yet many tools (the Finder's "Compress" among them) write UTF-8 without the flag, which
 * turns "Planlama ışığı.md" into mojibake. A Latin-1 reading keeps every byte, so when those bytes
 * are valid UTF-8 with something past ASCII, that is what the name was. Names in an old Windows
 * code page (not UTF-8) stay as read.
 */
const utf8 = new TextDecoder("utf-8", { fatal: true });
export function entryName(name: string): string {
  let high = false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code > 0xff) return name;
    if (code >= 0x80) high = true;
  }
  if (!high) return name;
  try {
    return utf8.decode(strToU8(name, true));
  } catch {
    return name;
  }
}

/** What the upload says about itself while it's read: whether it holds an Obsidian vault's settings folder. */
type Seen = { vault: boolean };

function unzip(
  data: Uint8Array,
  budget: Budget,
  depth: number,
  out: Map<string, Uint8Array>,
  skipped: SkippedFile[],
  seen: Seen,
) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (entry) => {
        const name = entryName(entry.name);
        if (name.endsWith("/") || name.endsWith("\\")) return false;
        const path = normalizePath(name);
        if (!path) {
          if (name.trim()) skipped.push({ path: shown(name), reason: "unsafePath" });
          return false;
        }
        if (isIgnoredPath(path)) {
          if (isVaultSettingsPath(path)) seen.vault = true;
          return false;
        }
        if (tooDeep(path)) {
          skipped.push({ path: shown(path), reason: "deepPath" });
          return false;
        }
        take(budget, Math.max(entry.size, entry.originalSize));
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("The ZIP file can't be read", "badZip");
  }
  for (const [name, bytes] of Object.entries(entries)) {
    const path = normalizePath(entryName(name))!;
    const pack = isTextPack(path);
    if (importFileKind(path) === "zip" || pack) {
      if (depth >= 1) skipped.push({ path, reason: "nestedZip" });
      else if (pack) unpackTextPack(path, bytes, budget, depth + 1, out, skipped, seen);
      else unzip(bytes, budget, depth + 1, out, skipped, seen);
    } else out.set(path, bytes);
  }
}

/** Unpacks the TextPack at `path` into its bundle folder (see textPackFolder). */
function unpackTextPack(
  path: string,
  data: Uint8Array,
  budget: Budget,
  depth: number,
  out: Map<string, Uint8Array>,
  skipped: SkippedFile[],
  seen: Seen,
) {
  const inner = new Map<string, Uint8Array>();
  unzip(data, budget, depth, inner, skipped, seen);
  const folder = textPackFolder(path, [...inner.keys()]);
  for (const [entry, bytes] of inner) out.set(`${folder}${entry}`, bytes);
}

/**
 * The folder Notion wraps an export's files in: `Export-<uuid>/` (or, in each part of a split
 * export, `Export-<uuid>-Part-1/`). Not a page of its own.
 */
const EXPORT_FOLDER = /^Export-[0-9a-f-]+(?:-Part-\d+)?\//i;

/**
 * The upload's files by normalized path, what was left out of it, and whether it held an Obsidian
 * vault's `.obsidian` folder (left out too).
 */
export function collectFiles(files: UploadedFile[]): { files: Map<string, Uint8Array>; skipped: SkippedFile[]; vault: boolean } {
  const seen: Seen = { vault: false };
  const out = new Map<string, Uint8Array>();
  const skipped: SkippedFile[] = [];
  const budget: Budget = { files: 0, bytes: 0 };
  for (const file of files) {
    const path = normalizePath(file.path);
    if (!path) {
      if (file.path.trim()) skipped.push({ path: shown(file.path), reason: "unsafePath" });
      continue;
    }
    if (isIgnoredPath(path)) {
      if (isVaultSettingsPath(path)) seen.vault = true;
      continue;
    }
    if (tooDeep(path)) {
      skipped.push({ path: shown(path), reason: "deepPath" });
      continue;
    }
    if (importFileKind(path) === "zip") unzip(file.data, budget, 0, out, skipped, seen);
    else if (isTextPack(path)) unpackTextPack(path, file.data, budget, 0, out, skipped, seen);
    else {
      take(budget, file.data.byteLength);
      out.set(path, file.data);
    }
  }
  const unwrapped = new Map<string, Uint8Array>();
  for (const [path, bytes] of out) {
    const inner = path.replace(EXPORT_FOLDER, "");
    if (inner && !unwrapped.has(inner)) unwrapped.set(inner, bytes);
  }
  return { files: unwrapped, skipped, vault: seen.vault };
}
