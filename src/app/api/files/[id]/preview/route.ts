import { auth } from "@/lib/auth";
import { DocxPreviewFailure, docxPreview } from "@/server/docx-preview";
import { documentKind } from "@/server/file-text";
import { fileForViewer } from "@/server/files";
import { StorageError } from "@/server/storage";

/**
 * A Word document's preview for the file viewer (components/file-viewer): its text and pictures as
 * cleaned HTML in JSON (see server/docx-preview.ts), never served as a page of its own. Whoever
 * may open the file (see the file route, api/files/[id]) may read its preview; anyone else, and
 * any file that isn't a Word document, gets the file route's 404.
 *
 * Failures answer with a code the viewer explains: 413 `tooLarge`, 422 `unreadable`, 503 `busy`
 * (too many documents being read at once) or 502 `storage`.
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Type": "application/json; charset=utf-8",
};

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Cache-Control": "no-store", ...headers } });

const STATUS = { tooLarge: 413, unreadable: 422, busy: 503, missing: 404 } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const found = await fileForViewer(session?.user.id ?? null, id);
  if (!found || documentKind(found.contentType, found.name) !== "docx") return answer(404, { code: "notFound" });
  const etag = `"docx-preview-${found.id}"`;
  // As the file itself: access can be taken away, so only the viewer's own browser keeps it, briefly.
  const cached = { "Cache-Control": "private, max-age=300", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...HEADERS, ...cached } });
  try {
    const preview = await docxPreview(found);
    return answer(200, { html: preview.html, picturesLeftOut: preview.picturesLeftOut }, cached);
  } catch (error) {
    if (error instanceof DocxPreviewFailure) return answer(STATUS[error.code], { code: error.code === "missing" ? "notFound" : error.code });
    if (error instanceof StorageError) return answer(502, { code: "storage" });
    throw error;
  }
}
