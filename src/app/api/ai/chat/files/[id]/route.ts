import { auth } from "@/lib/auth";
import { dispositionOf, isSafeInline } from "@/lib/files";
import { chatFileForOwner } from "@/server/ai-chat-files";
import { StorageError } from "@/server/storage";
import { refOf, storageOf } from "@/server/storage/workspace";

/**
 * Opens a file attached to an AI chat question, for the person who attached it and nobody else
 * (server/ai-chat-files.ts); anyone else gets the same 404 as for a file that doesn't exist. Served
 * as /api/files serves uploads: only raster images and PDFs in the browser, everything else as a
 * download, never sniffed, and sandboxed should a browser render it anyway.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function notFound() {
  return new Response("Not found", { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return notFound();
  const found = await chatFileForOwner(session.user.id, id);
  if (!found) return notFound();
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": found.contentType,
    "Content-Disposition": dispositionOf(found.contentType, found.name),
    "Cache-Control": "private, max-age=300",
    "Content-Security-Policy":
      found.contentType === "application/pdf"
        ? "frame-ancestors 'self'"
        : isSafeInline(found.contentType)
          ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
          : "default-src 'none'; sandbox",
    "Content-Length": String(found.size),
  };
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = await (await storageOf(found)).get(refOf(found));
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    return new Response("The file's storage isn't answering", { status: 502, headers: { ...BASE_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  }
  if (!body) return notFound();
  return new Response(body, { status: 200, headers });
}
