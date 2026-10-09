import { auth } from "@/lib/auth";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { AccessError } from "@/server/access";
import { isCrossSite } from "@/server/cross-site";
import { FileError, uploadFile, type UploadInput } from "@/server/files";
import { FormError, uploadFormFile, uploadPublicFormFile } from "@/server/forms";

/**
 * Uploads a file: `POST /api/files?pageId=<id>` with the raw bytes as the body, the file's type as
 * Content-Type and its name, URI-encoded, in `X-File-Name`. Answers 201 with the stored file (`url`
 * is what the block or files property keeps). The editor's BlockNote `uploadFile` and the files
 * property editor call this.
 *
 * Answers to a form's files question upload with `?form=<viewId>` (in the app, signed in) or
 * `?formToken=<token>` plus the form's ticket in `X-Form-Ticket` (public forms, maybe anonymous);
 * the file waits with the form's database until the answer is sent (see server/forms.ts).
 *
 * The custom header doubles as CSRF protection: a cross-site form can't send it, and a cross-site
 * fetch with it needs a CORS preflight this route doesn't answer. A foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const params = new URL(request.url).searchParams;
  const pageId = params.get("pageId");
  const formView = params.get("form");
  const formToken = params.get("formToken");
  if (!session && !formToken) return Response.json({ error: "Sign in to upload files" }, { status: 401 });

  if (isCrossSite(request)) {
    return Response.json({ error: "Cross-site uploads aren't allowed" }, { status: 403 });
  }
  const rawName = request.headers.get("x-file-name");
  if (rawName === null || !(pageId || formView || formToken) || !request.body) {
    return Response.json({ error: "Send the file as the body, with X-File-Name and ?pageId=" }, { status: 400 });
  }
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {}
  const length = request.headers.get("content-length");
  const input: UploadInput = {
    name,
    contentType: request.headers.get("content-type"),
    body: request.body,
    declaredSize: length && /^\d+$/.test(length) ? Number(length) : null,
  };

  try {
    const stored = formToken
      ? await uploadPublicFormFile(
          formToken,
          {
            userId: session?.user.id ?? null,
            ip: request.headers.get(CLIENT_IP_HEADER) ?? "unknown",
            ticket: request.headers.get("x-form-ticket"),
          },
          input,
        )
      : formView
        ? await uploadFormFile(session!.user.id, formView, input)
        : await uploadFile(session!.user.id, pageId!, input);
    // Someone answering a public form can't open the file afterwards; nothing names the database.
    const body = formToken
      ? { id: stored.id, url: stored.url, name: stored.name, contentType: stored.contentType, size: stored.size }
      : stored;
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessError) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof FormError) {
      const status = error.code === "rateLimited" ? 429 : error.code === "signInRequired" ? 401 : error.code === "closed" ? 404 : 403;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    if (error instanceof FileError) {
      const status = error.code === "tooLarge" || error.code === "quotaExceeded" ? 413 : error.code === "notAllowed" ? 403 : 400;
      return Response.json({ error: error.message, code: error.code, limit: error.limit }, { status });
    }
    throw error;
  }
}
