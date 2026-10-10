import { cleanTitle, IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { createPage } from "@/server/pages";
import { recordImport } from "./csv";
import { docxBlocks, docxToHtml, imageName, imageSources, isPageImage, placeImages } from "./docx-convert";
import { discard, store } from "./markdown";

/**
 * Imports Word documents (.docx) as pages under a page (or at the top level of a workspace): one
 * page per document, titled by the heading it starts with, else by its file name (see
 * docx-convert for what of a document comes along). Its pictures are uploaded to the page; one
 * that can't be (too large, out of storage, linked from outside the document, a type pages don't
 * show) is left out with a warning.
 *
 * All or nothing, like the Markdown import: every document is read before a page is created, so a
 * damaged one stops the import with nothing kept, and if creating or writing fails midway the
 * pages created so far are deleted again (their uploads with them).
 */

export type DocxImportInput = {
  workspaceId: string;
  /** The page the documents go under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  files: { name: string; data: Uint8Array }[];
};

export const isDocx = (name: string) => /\.docx$/i.test(name);

export async function importDocx(actor: WriteActor, input: DocxImportInput): Promise<ImportResult> {
  const { userId } = actor;
  if (!input.files.length) throw new ImportError("There is no Word document to import", "nothingToImport");
  if (input.files.length > IMPORT_LIMITS.pages) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
  }
  const other = input.files.find((f) => !isDocx(f.name));
  if (other) throw new ImportError(`“${other.name}” isn't a Word document`, "badDocx", { name: other.name });
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Pages can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  }

  // Read every document first: one that can't be read stops the import before anything is created.
  const documents = [];
  for (const file of input.files) {
    const { html, images } = await docxToHtml(file.name, file.data);
    const { title, blocks } = await docxBlocks(file.name, html);
    documents.push({ name: file.name, title: title ?? (cleanTitle(file.name) || file.name.slice(0, 200)), blocks, images });
  }

  const warnings = new WarningList();
  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  const roots: { id: string; title: string }[] = [];
  try {
    for (const document of documents) {
      const { id } = await createPage(
        actor,
        { workspaceId, parentId: input.parentId, teamspaceId: input.teamspaceId, title: document.title },
        { audit: false },
      );
      roots.push({ id, title: document.title });
      counts.pages++;
      // Pictures in the order the document shows them, numbered for the warnings (mammoth gives no names).
      const images = new Map(document.images.map((image) => [image.token, image]));
      const urls = new Map<string, string>();
      for (const [i, source] of imageSources(document.blocks).entries()) {
        const image = images.get(source);
        const path = `${document.name}/${imageName(i + 1, image?.contentType ?? "")}`;
        // No picture behind it: one linked from outside the document, which mammoth doesn't fetch.
        if (!image) warnings.add({ code: "fileNotStored", path, reason: "external" });
        else if (!isPageImage(image.contentType)) warnings.add({ code: "fileNotStored", path, reason: "unsupportedType" });
        else {
          const url = await store(userId, id, path, image.data, warnings, counts);
          if (url) urls.set(source, url);
        }
      }
      const blocks = placeImages(document.blocks, urls);
      if (blocks.length) await getCollab().appendBlocks(id, blocks, actor);
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
  await recordImport(userId, workspaceId, result, "docx");
  return result;
}
