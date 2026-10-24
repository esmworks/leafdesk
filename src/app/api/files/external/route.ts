import { auth } from "@/lib/auth";
import { downloadName, EXTERNAL_DOWNLOAD_MS, MAX_EXTERNAL_DOWNLOAD } from "@/lib/downloads";
import { dispositionOf } from "@/lib/files";
import { AccessError, requirePageAccess } from "@/server/access";
import { checkConnectionUrl, ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";

/**
 * Downloads a file a page shows from another site (an image, video, audio or file block with a web
 * address, see lib/downloads): `GET /api/files/external?url=…&pageId=…&name=…`, for someone signed
 * in who may view the page. The server fetches it the way connections reach their servers
 * (server/connections/fetch.ts: https on a public address only, each redirect checked again) with
 * nothing of the request it was asked with (no cookies), at most MAX_EXTERNAL_DOWNLOAD bytes within
 * EXTERNAL_DOWNLOAD_MS, and streams it back as an attachment, never shown as a page of this site.
 */

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

function fail(status: number, message: string) {
  return new Response(message, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

/** The bytes of `body`, failing the stream once more than `limit` have come. */
function limited(body: ReadableStream<Uint8Array>, limit: number, abort: () => void): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          abort();
          controller.error(new Error("The file is too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail(401, "Sign in to download files");
  const params = new URL(request.url).searchParams;
  const pageId = params.get("pageId") ?? "";
  try {
    await requirePageAccess(session.user.id, pageId, "view");
  } catch (error) {
    if (error instanceof AccessError) return fail(404, "Not found");
    throw error;
  }
  let target: URL;
  try {
    target = checkConnectionUrl(params.get("url") ?? "");
  } catch (error) {
    if (error instanceof ConnectionFetchError) return fail(400, "This address can't be downloaded");
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_DOWNLOAD_MS);
  let response: Response;
  try {
    response = await connectionFetch(target, { headers: { Accept: "*/*" }, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof ConnectionFetchError) return fail(400, "This address can't be downloaded");
    return fail(502, "The file couldn't be fetched");
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    await response.body?.cancel().catch(() => undefined);
    return fail(502, "The file couldn't be fetched");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_EXTERNAL_DOWNLOAD) {
    clearTimeout(timer);
    await response.body.cancel().catch(() => undefined);
    return fail(413, "The file is too large");
  }

  const name = downloadName(target, params.get("name"));
  const headers: Record<string, string> = {
    ...HEADERS,
    // Saved, never shown: whatever the other site says it is.
    "Content-Type": "application/octet-stream",
    "Content-Disposition": dispositionOf("application/octet-stream", name),
  };
  if (Number.isFinite(length) && length > 0) headers["Content-Length"] = String(length);
  const body = limited(response.body, MAX_EXTERNAL_DOWNLOAD, () => controller.abort());
  // The timer ends the download when it runs out; a finished one no longer needs it.
  return new Response(
    body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush: () => clearTimeout(timer),
      }),
    ),
    { status: 200, headers },
  );
}
