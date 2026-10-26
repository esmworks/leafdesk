import { cleanTitle, IMPORT_LIMITS } from "@/lib/import/markdown";
import { readMhtml } from "@/lib/import/mhtml";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { createPage } from "@/server/pages";
import { recordImport } from "./csv";
import { imageSources, isPageImage, placeImages } from "./docx-convert";
import { discard, store } from "./markdown";
import { mhtmlDocument, type MhtmlDocument } from "./mhtml-convert";

/**
 * Imports single-file web pages (.mht, .mhtml) as pages under a page (or at the top level of a
 * workspace): OneNote's *Single File Web Page* export of a page or a section, and web pages saved
 * that way by a browser or Word (see mhtml-convert for what is read). A file becomes one page, or,
 * for a OneNote section, a page named after the section with a page under it for each of its
 * pages. The pictures the file holds are uploaded to the page that shows them; one it doesn't hold
 * (linked from elsewhere: nothing is fetched), of a type pages don't show, or that can't be stored
 * is left out with a warning.
 *
 * All or nothing, like the Word import: every file is read before a page is created, so one that
 * can't be read stops the import with nothing kept, and if creating or writing fails midway the
 * pages created so far are deleted again (their uploads with them).
 */

export type MhtmlImportInput = {
  workspaceId: string;
  /** The page the files go under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  files: { name: string; data: Uint8Array }[];
};

export const isMhtml = (name: string) => /\.(mht|mhtml)$/i.test(name);

export async function importMhtml(actor: WriteActor, input: MhtmlImportInput): Promise<ImportResult> {
  const { userId } = actor;
  if (!input.files.length) throw new ImportError("There is no web archive to import", "nothingToImport");
  const other = input.files.find((f) => !isMhtml(f.name));
  if (other) throw new ImportError(`“${other.name}” isn't a single-file web page`, "badMhtml", { name: other.name });
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Pages can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  }

  // Read every file first: one that can't be read stops the import before anything is created.
  const documents: { name: string; document: MhtmlDocument }[] = [];
  let pageCount = 0;
  for (const file of input.files) {
    const document = await mhtmlDocument(file.name, readMhtml(file.name, file.data));
    pageCount += document.pages.length + (document.section ? 1 : 0);
    if (pageCount > IMPORT_LIMITS.pages) {
      throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
    }
    documents.push({ name: file.name, document });
  }

  const warnings = new WarningList();
  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  const roots: { id: string; title: string }[] = [];
  const base = { workspaceId, teamspaceId: input.teamspaceId };
  try {
    for (const { name, document } of documents) {
      const fileTitle = cleanTitle(name) || name.slice(0, 200);
      let parentId = input.parentId;
      if (document.section) {
        const section = await createPage(actor, { ...base, parentId, title: document.section }, { audit: false });
        roots.push({ id: section.id, title: document.section });
        counts.pages++;
        parentId = section.id;
      }
      const images = new Map(document.images.map((image) => [image.token, image]));
      // A picture shown on several pages is stored once, with the first page that shows it.
      const urls = new Map<string, string>();
      const tried = new Set<string>();
      for (const page of document.pages) {
        // A OneNote page without a title stays untitled in a section; a file of one page takes the file's name.
        const title = page.title ?? (document.section ? "" : fileTitle);
        const { id } = await createPage(actor, { ...base, parentId, title }, { audit: false });
        if (!document.section) roots.push({ id, title });
        counts.pages++;
        for (const source of new Set(imageSources(page.blocks))) {
          const image = images.get(source);
          if (!image || tried.has(source)) continue;
          tried.add(source);
          const path = `${name}/${image.name}`;
          if (!image.part) warnings.add({ code: "fileNotStored", path, reason: "external" });
          else if (!isPageImage(image.type)) warnings.add({ code: "fileNotStored", path, reason: "unsupportedType" });
          else {
            const url = await store(userId, id, path, image.part.data, warnings, counts);
            if (url) urls.set(source, url);
          }
        }
        const blocks = placeImages(page.blocks, urls);
        if (blocks.length) await getCollab().appendBlocks(id, blocks, actor);
      }
    }
  } catch (error) {
    await discard(workspaceId, roots);
    throw error;
  }

  const result: ImportResult = {
    pages: roots.map((r) => ({ id: r.id, title: r.title, kind: "page" as const })),
    created: counts,
    warnings: warnings.list,
    moreWarnings: warnings.more,
  };
  await recordImport(userId, workspaceId, result, documents.some((d) => d.document.oneNote) ? "onenote" : "mhtml");
  return result;
}
