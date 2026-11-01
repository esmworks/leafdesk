import { auth } from "@/lib/auth";
import { dispositionOf } from "@/lib/files";
import { requireMembership } from "@/server/access";
import { chatFileOfPerson } from "@/server/agents/chat-files";
import { StorageError } from "@/server/storage";
import { refOf, storageOf } from "@/server/storage/workspace";

/**
 * Downloads a file an agent attached to its answer in a person's chat, for that person alone while
 * they are in the workspace (server/agents/chat-files.ts); anyone else gets the same 404 as for a
 * file that doesn't exist. The files are text (CSV, Markdown, text, JSON): always a download,
 * never sniffed, and sandboxed should a browser render it anyway.
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
  const found = await chatFileOfPerson(session.user.id, id);
  if (!found) return notFound();
  try {
    await requireMembership(session.user.id, found.workspaceId);
  } catch {
    return notFound();
  }
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": found.contentType,
    // A download whatever the type: never shown in the app's own origin.
    "Content-Disposition": dispositionOf("application/octet-stream", found.name),
    "Cache-Control": "private, max-age=300",
    "Content-Security-Policy": "default-src 'none'; sandbox",
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
