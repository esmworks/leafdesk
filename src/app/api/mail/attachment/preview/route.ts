import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { DocxPreviewFailure, docxPreviewOf } from "@/server/docx-preview";
import { documentKind } from "@/server/file-text";
import { readAttachment } from "@/server/mail-client/read";
import { RowMailError } from "@/server/row-mail/settings";

/**
 * A Word document attached to a message, previewed for the file viewer as api/files/[id]/preview
 * previews uploads: cleaned HTML in JSON, read from the mail server for the mailbox's owner alone
 * (as api/mail/attachment). Anyone else, and any file that isn't a Word document, gets `notFound`.
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
};

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

const STATUS = { tooLarge: 413, unreadable: 422, busy: 503, missing: 404 } as const;

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return answer(404, { code: "notFound" });
  const url = new URL(request.url);
  try {
    const file = await readAttachment(session.user.id, { id: url.searchParams.get("m") ?? "", part: url.searchParams.get("p") ?? "" });
    if (documentKind(file.contentType, file.name) !== "docx") return answer(404, { code: "notFound" });
    const preview = await docxPreviewOf(file.name, new Uint8Array(file.data));
    return answer(200, { html: preview.html, picturesLeftOut: preview.picturesLeftOut });
  } catch (error) {
    if (error instanceof DocxPreviewFailure) return answer(STATUS[error.code], { code: error.code === "missing" ? "notFound" : error.code });
    if (error instanceof RowMailError && error.code === "tooMany") return answer(413, { code: "tooLarge" });
    if (error instanceof RowMailError || error instanceof AccessError) return answer(404, { code: "notFound" });
    return answer(502, { code: "storage" });
  }
}
