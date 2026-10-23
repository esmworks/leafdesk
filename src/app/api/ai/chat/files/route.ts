import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { uploadChatFile } from "@/server/ai-chat-files";
import { isCrossSite } from "@/server/cross-site";
import { FileError } from "@/server/files";

/**
 * Attaches a file to an AI chat question: `POST /api/ai/chat/files?workspaceId=<id>` with the raw
 * bytes as the body, the file's type as Content-Type and its name, URI-encoded, in `X-File-Name`
 * (as /api/files). Answers 201 with the file (`id` goes with the question, `url` opens it, for the
 * person who attached it only); see server/ai-chat-files.ts for what may be attached.
 *
 * The custom header doubles as CSRF protection: a cross-site form can't send it, and a cross-site
 * fetch with it needs a CORS preflight this route doesn't answer. A foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return Response.json({ error: "Sign in to attach files" }, { status: 401 });
  if (isCrossSite(request)) return Response.json({ error: "Cross-site uploads aren't allowed" }, { status: 403 });
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  const rawName = request.headers.get("x-file-name");
  if (rawName === null || !workspaceId || !request.body) {
    return Response.json({ error: "Send the file as the body, with X-File-Name and ?workspaceId=" }, { status: 400 });
  }
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {}
  const length = request.headers.get("content-length");
  try {
    const stored = await uploadChatFile(session.user.id, workspaceId, {
      name,
      contentType: request.headers.get("content-type"),
      body: request.body,
      declaredSize: length && /^\d+$/.test(length) ? Number(length) : null,
    });
    return Response.json(stored, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessError) return Response.json({ error: "Not found" }, { status: 404 });
    if (error instanceof FileError) {
      const status = error.code === "tooLarge" || error.code === "quotaExceeded" ? 413 : error.code === "notAllowed" ? 403 : error.code === "storageFailed" ? 502 : 400;
      return Response.json({ error: error.message, code: error.code, limit: error.limit }, { status });
    }
    throw error;
  }
}
