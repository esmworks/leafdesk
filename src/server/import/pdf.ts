import { pdfHtml, type PdfPageText } from "@/lib/import/pdf";
import { cleanTitle, IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { createPage } from "@/server/pages";
import { recordImport } from "./csv";
import { DOCX_LIMITS, htmlBlocks } from "./docx-convert";
import { discard, store } from "./markdown";
import { requireTopLevelPlace } from "./place";

/**
 * Imports PDFs as pages under a page (or at the top level of a workspace): one page per PDF, made
 * of its text layer (see lib/import/pdf for how headings, paragraphs, lists and page breaks are
 * read from the layout), titled by the heading it starts with, else by its file name. With
 * `attach`, the PDF itself is uploaded to the page and shown at its end (its preview is tall: the text
 * comes first), for what text can't carry (pictures, tables, the layout); one that can't be stored (too large, out of storage) is left out
 * with a warning.
 *
 * The PDF is read by the same reader full-text search uses for uploaded PDFs (unpdf), in the
 * server's process, within PDF_LIMITS. A PDF without a text layer (a scan) stops the import with
 * `pdfNoText` rather than making an empty page. All or nothing, like the Word import: every PDF is
 * read before a page is created, and pages created before a failure are deleted again.
 */

const MB = 1024 * 1024;

export const PDF_LIMITS = {
  /** One PDF (as full-text search reads them, see file-text.ts). */
  bytes: 25 * MB,
  /** Pages of one PDF. */
  pages: 500,
  /** Reading one PDF's text. */
  timeoutMs: 60_000,
  /** The HTML made of one PDF. */
  htmlBytes: DOCX_LIMITS.htmlBytes,
};

export type PdfImportInput = {
  workspaceId: string;
  /** The page the PDFs go under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  files: { name: string; data: Uint8Array }[];
  /** Upload each PDF to its page and show it there too. */
  attach?: boolean;
};

export const isPdf = (name: string) => /\.pdf$/i.test(name);

/** The text of a PDF's pages with their places and sizes; throws an ImportError when it can't be read. */
export async function pdfPages(name: string, data: Uint8Array): Promise<PdfPageText[]> {
  const unreadable = () => new ImportError(`“${name}” can't be read as a PDF`, "badPdf", { name });
  const tooComplex = () => new ImportError(`“${name}” is too large to import as one page`, "pdfTooComplex", { name });
  if (data.byteLength > PDF_LIMITS.bytes) throw new ImportError(`“${name}” is too large to import`, "tooLarge", { limit: PDF_LIMITS.bytes });
  // Not a PDF at all (the header may follow a little junk, as readers allow).
  if (!new TextDecoder("latin1").decode(data.subarray(0, 1024)).includes("%PDF-")) throw unreadable();
  // A missing module is a server problem: it throws outside the catch below.
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Quiet: a damaged file is reported as badPdf, not logged.
    pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  } catch {
    throw unreadable();
  }
  try {
    if (pdf.numPages > PDF_LIMITS.pages) throw tooComplex();
    const started = Date.now();
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      if (Date.now() - started > PDF_LIMITS.timeoutMs) throw tooComplex();
      let page;
      let content;
      try {
        page = await pdf.getPage(n);
        content = await page.getTextContent();
      } catch {
        throw unreadable();
      }
      const { width, height } = page.getViewport({ scale: 1 });
      const items = content.items.flatMap((item) => {
        if (!("str" in item)) return [];
        const [a, b, c, d, x, y] = item.transform as number[];
        // Turned text (a watermark, a label up the margin) isn't part of the reading.
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) return [];
        return [{ str: item.str, x, y, size: Math.abs(d), width: item.width, rtl: item.dir === "rtl" }];
      });
      pages.push({ width, height, items });
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** A PDF read as a page: its title (null: none at its top) and blocks. */
export async function pdfBlocks(name: string, data: Uint8Array): Promise<{ title: string | null; blocks: PageBlock[] }> {
  const { html, chars } = pdfHtml(await pdfPages(name, data));
  if (!chars) throw new ImportError(`“${name}” has no text to import: it looks like a scan`, "pdfNoText", { name });
  if (Buffer.byteLength(html) > PDF_LIMITS.htmlBytes) throw new ImportError(`“${name}” is too large to import as one page`, "pdfTooComplex", { name });
  return htmlBlocks(name, html, { unreadable: "badPdf", tooComplex: "pdfTooComplex" });
}

export async function importPdf(actor: WriteActor, input: PdfImportInput): Promise<ImportResult> {
  const { userId } = actor;
  if (!input.files.length) throw new ImportError("There is no PDF to import", "nothingToImport");
  if (input.files.length > IMPORT_LIMITS.pages) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
  }
  const other = input.files.find((f) => !isPdf(f.name));
  if (other) throw new ImportError(`“${other.name}” isn't a PDF`, "badPdf", { name: other.name });
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Pages can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  } else await requireTopLevelPlace(userId, workspaceId, input.teamspaceId);

  // Read every PDF first: one that can't be read (or a scan) stops the import before anything is created.
  const documents = [];
  for (const file of input.files) {
    const { title, blocks } = await pdfBlocks(file.name, file.data);
    documents.push({ ...file, title: title ?? (cleanTitle(file.name) || file.name.slice(0, 200)), blocks });
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
      const blocks: unknown[] = [...document.blocks];
      if (input.attach) {
        const url = await store(userId, id, document.name, document.data, warnings, counts);
        if (url) blocks.push({ type: "file", props: { url, name: document.name, caption: "" } });
      }
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
  await recordImport(userId, workspaceId, result, "pdf");
  return result;
}
