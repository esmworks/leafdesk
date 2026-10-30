import { renderDocx } from "@/server/docx-document";
import { recordExport } from "@/server/export";
import { pageDocument, type PageDocumentOptions } from "@/server/pdf";

/**
 * The page `pageId` as a Word document (.docx), read as `userId` exactly as its PDF is (see
 * pdf.ts pagePdf, whose options it takes): the page menu's "Export as Word" and the AI chat's
 * create_docx. A letterhead's theme is a PDF layout: the document takes the letterhead's own logo,
 * lines and accent instead (docx-document.ts). Recorded in the audit log as an export.
 */
export async function pageDocx(userId: string, pageId: string, options: PageDocumentOptions = {}) {
  const { target, letterhead, input } = await pageDocument(userId, pageId, options);
  const bytes = await renderDocx({ ...input, letterhead });
  await recordExport(userId, { workspaceId: target.workspaceId, page: { id: target.id, title: target.title }, format: "docx", comments: options.comments ?? false, pages: 1 });
  return { bytes, title: input.title, workspaceId: target.workspaceId };
}
