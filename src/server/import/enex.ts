import { decodeText } from "@/lib/import/csv";
import { ENEX_LIMITS, readEnex, type EnexNote } from "@/lib/import/enex";
import { cleanTitle, IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import type { PropertyType } from "@/lib/property-types";
import { requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { addProperty, type DatabaseProperty } from "@/server/databases";
import { createPage, type DatabaseSeedNames } from "@/server/pages";
import { collectFiles } from "./archive";
import { checkRows, discardDatabase, recordImport, reportInvalid, writeRows } from "./csv";
import { isPageImage } from "./docx-convert";
import { mediaHashes, noteBlocks, placedBlock, placeMedia, resourceFiles, type Placed } from "./enex-convert";
import { store } from "./markdown";
import { requireTopLevelPlace } from "./place";

/**
 * Imports Evernote exports (.enex, loose or in ZIPs) as databases under a page (or at the top level
 * of a workspace): one database per export, named after its file (Evernote names the file after
 * the notebook), with a row per note. A note's tags, creation and change times, author and source
 * URL become properties (each only when some note has it), and its content the row's body (see
 * lib/import/enex for what of ENML comes along). Its attachments are uploaded to the row: pictures
 * pages can show as images, the others as files; one that can't be stored (too large, out of
 * storage) is left out with a warning.
 *
 * Every export is read before anything is created, so a file that isn't one stops the import with
 * nothing kept. A note whose content can't be read (malformed, too large) is left out with a
 * warning while the others come along. If creating or writing fails midway, the databases created
 * so far are deleted again, with their uploads.
 */

/** Names of the properties an import creates and of the line standing for encrypted text, in the importer's language. */
export type EnexNames = {
  tags: string;
  created: string;
  updated: string;
  author: string;
  sourceUrl: string;
  encrypted: string;
};

export const ENGLISH_ENEX_NAMES: EnexNames = {
  tags: "Tags",
  created: "Created",
  updated: "Updated",
  author: "Author",
  sourceUrl: "Source URL",
  encrypted: "Encrypted text was left out.",
};

export type EnexImportInput = {
  workspaceId: string;
  /** The page the databases go under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private databases, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  /** .enex files, and ZIPs holding them (by their paths in the ZIP). */
  files: { name: string; data: Uint8Array }[];
  seedNames?: DatabaseSeedNames;
  names?: EnexNames;
};

export const isEnex = (name: string) => /\.enex$/i.test(name);
const isZip = (name: string) => /\.zip$/i.test(name);

/** A note read and converted, ready to be written. */
type ReadyNote = { note: EnexNote; blocks: PageBlock[] };
type ReadyExport = { name: string; title: string; notes: ReadyNote[] };

/** Reads the exports of the upload (ZIPs unpacked): every note's blocks, or a warning for those that can't be read. */
async function readExports(files: EnexImportInput["files"], names: EnexNames, warnings: WarningList): Promise<ReadyExport[]> {
  const loose = files.filter((f) => !isZip(f.name));
  const other = loose.find((f) => !isEnex(f.name));
  if (other) throw new ImportError(`“${other.name}” isn't an Evernote export`, "badEnex", { name: other.name });
  const exports = loose.map((f) => ({ name: f.name, data: f.data }));
  const zips = files.filter((f) => isZip(f.name));
  if (zips.length) {
    const unpacked = collectFiles(zips.map((f) => ({ path: f.name, data: f.data })));
    for (const skipped of unpacked.skipped) warnings.add({ code: "skipped", path: skipped.path, reason: skipped.reason });
    for (const [path, data] of unpacked.files) {
      if (isEnex(path)) exports.push({ name: path, data });
      else warnings.add({ code: "skipped", path, reason: "notEnex" });
    }
    if (exports.length === loose.length) {
      throw new ImportError(`“${zips[0].name}” holds no Evernote export`, "badEnex", { name: zips[0].name });
    }
  }
  if (exports.length > IMPORT_LIMITS.pages) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
  }

  const ready: ReadyExport[] = [];
  for (const file of exports) {
    const notes = readEnex(file.name, decodeText(file.data));
    const title = cleanTitle(file.name) || file.name.slice(0, 200);
    const readyNotes: ReadyNote[] = [];
    for (const note of notes) {
      const path = `${file.name}/${note.title || "…"}`;
      if (note.content.length > ENEX_LIMITS.contentChars) {
        warnings.add({ code: "skipped", path, reason: "tooLarge" });
        continue;
      }
      const blocks = await noteBlocks(path, note, names.encrypted, warnings);
      if (blocks) readyNotes.push({ note, blocks });
    }
    ready.push({ name: file.name, title, notes: readyNotes });
  }
  return ready;
}

/**
 * Uploads a note's attachments to its row, in the order its content shows them, then the ones it
 * doesn't show (at the end of its body). Returns the blocks for its body.
 */
async function noteBody(
  userId: string,
  rowId: string,
  path: string,
  { note, blocks }: ReadyNote,
  warnings: WarningList,
  counts: { files: number },
): Promise<PageBlock[]> {
  const byHash = resourceFiles(note);
  const placed = new Map<string, Placed>();
  const upload = async (hash: string) => {
    const found = byHash.get(hash);
    if (!found) return;
    const url = await store(userId, rowId, `${path}/${found.name}`, found.data, warnings, counts);
    if (url) placed.set(hash, { type: isPageImage(found.mime) ? "image" : "file", url, name: found.name });
  };
  const shown = [...new Set(mediaHashes(blocks))];
  for (const hash of shown) {
    if (byHash.has(hash)) await upload(hash);
    else warnings.add({ code: "missingFile", path: hash, page: path });
  }
  const unshown = [...byHash.keys()].filter((hash) => !shown.includes(hash));
  for (const hash of unshown) await upload(hash);
  return [...placeMedia(blocks, placed), ...unshown.flatMap((hash) => (placed.has(hash) ? [placedBlock(placed.get(hash)!)] : []))];
}

export async function importEnex(actor: WriteActor, input: EnexImportInput): Promise<ImportResult> {
  const { userId } = actor;
  const names = input.names ?? ENGLISH_ENEX_NAMES;
  if (!input.files.length) throw new ImportError("There is no Evernote export to import", "nothingToImport");
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Notebooks can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  } else await requireTopLevelPlace(userId, workspaceId, input.teamspaceId);

  // Read every export first: one that can't be read stops the import before anything is created.
  const warnings = new WarningList();
  const exports = await readExports(input.files, names, warnings);

  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  const created: { id: string; workspaceId: string; title: string }[] = [];
  try {
    for (const file of exports) {
      // Recorded once the import has gone through (recordImport), not as a database of its own.
      const database = await createPage(
        actor,
        {
          workspaceId,
          parentId: input.parentId,
          teamspaceId: input.teamspaceId,
          kind: "database",
          title: file.title,
          seedNames: input.seedNames,
          seedProperties: false,
        },
        { audit: false },
      );
      created.push({ id: database.id, workspaceId: database.workspaceId, title: database.title });
      counts.databases++;

      const notes = file.notes.map((n) => n.note);
      const props: DatabaseProperty[] = [];
      const add = async (name: string, type: PropertyType, options?: string[]) => {
        const prop = await addProperty(userId, database.id, { name, type, options });
        props.push(prop);
        return prop;
      };
      const tagNames = new Map<string, string>();
      for (const tag of notes.flatMap((n) => n.tags)) if (!tagNames.has(tag.toLowerCase())) tagNames.set(tag.toLowerCase(), tag.slice(0, 200));
      const tags = tagNames.size ? await add(names.tags, "multi_select", [...tagNames.values()]) : null;
      const createdProp = notes.some((n) => n.created) ? await add(names.created, "date") : null;
      const updatedProp = notes.some((n) => n.updated) ? await add(names.updated, "date") : null;
      const author = notes.some((n) => n.author) ? await add(names.author, "text") : null;
      const source = notes.some((n) => n.sourceUrl) ? await add(names.sourceUrl, "url") : null;

      const invalid = new Map<string, number>();
      const pending = notes.map((note) => {
        const values: Record<string, unknown> = {};
        if (tags && note.tags.length) values[tags.id] = note.tags;
        if (createdProp && note.created) values[createdProp.id] = note.created;
        if (updatedProp && note.updated) values[updatedProp.id] = note.updated;
        if (author && note.author) values[author.id] = note.author;
        if (source && note.sourceUrl) values[source.id] = note.sourceUrl;
        return { title: note.title, values };
      });
      const rows = await writeRows(database, userId, await checkRows(userId, database.id, pending, props, invalid));
      counts.rows += rows.length;
      reportInvalid(warnings, invalid, props);

      for (const [i, ready] of file.notes.entries()) {
        const body = await noteBody(userId, rows[i].id, `${file.name}/${ready.note.title || "…"}`, ready, warnings, counts);
        if (body.length) await getCollab().appendBlocks(rows[i].id, body, actor);
      }
    }
  } catch (error) {
    for (const database of created) await discardDatabase(database);
    throw error;
  }

  const result: ImportResult = {
    pages: created.map((d) => ({ id: d.id, title: d.title, kind: "database" as const })),
    created: counts,
    warnings: warnings.list,
    moreWarnings: warnings.more,
  };
  await recordImport(userId, workspaceId, result, "enex");
  return result;
}
