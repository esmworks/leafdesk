import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { isCrossSite } from "@/server/cross-site";
import { FileError } from "@/server/files";
import { MessageError } from "@/server/messages/core";
import { uploadMessageFile } from "@/server/messages/files";

/**
 * Uploads a file for a message: `POST /api/messages/files?channelId=<id>` with the raw bytes as the
 * body, the file's type as Content-Type, its name URI-encoded in `X-File-Name` and, for an image,
 * its size in pixels in `X-Image-Size` (`<width>x<height>`, read in the browser, so the message
 * keeps its room while the image loads). Answers 201 with the file; its `id` goes with the message.
 *
 * The custom header doubles as CSRF protection, as for /api/files; a foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return Response.json({ error: "Sign in to send files" }, { status: 401 });
  if (isCrossSite(request)) return Response.json({ error: "Cross-site uploads aren't allowed" }, { status: 403 });
  const channelId = new URL(request.url).searchParams.get("channelId");
  const rawName = request.headers.get("x-file-name");
  if (rawName === null || !channelId || !request.body) {
    return Response.json({ error: "Send the file as the body, with X-File-Name and ?channelId=" }, { status: 400 });
  }
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {}
  const length = request.headers.get("content-length");
  const [width, height] = (request.headers.get("x-image-size") ?? "").split("x").map((n) => (/^\d{1,6}$/.test(n) ? Number(n) : null));
  try {
    const stored = await uploadMessageFile(
      session.user.id,
      channelId,
      {
        name,
        contentType: request.headers.get("content-type"),
        body: request.body,
        declaredSize: length && /^\d+$/.test(length) ? Number(length) : null,
      },
      { width, height },
    );
    return Response.json(stored, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessError) return Response.json({ error: "Not found" }, { status: 404 });
    if (error instanceof MessageError) return Response.json({ error: error.message, code: error.code }, { status: error.code === "notFound" ? 404 : 403 });
    if (error instanceof FileError) {
      const status = error.code === "tooLarge" || error.code === "quotaExceeded" ? 413 : error.code === "notAllowed" ? 403 : error.code === "storageFailed" ? 502 : 400;
      return Response.json({ error: error.message, code: error.code, limit: error.limit }, { status });
    }
    throw error;
  }
}
