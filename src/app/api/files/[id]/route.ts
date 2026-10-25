import { auth } from "@/lib/auth";
import { dispositionOf, isSafeInline, parseRange } from "@/lib/files";
import { fileForViewer } from "@/server/files";
import { StorageError } from "@/server/storage";
import { refOf, storageOf } from "@/server/storage/workspace";

/**
 * Serves an uploaded file to whoever may read it (see server/files.ts `fileForViewer`): people who
 * can view a page showing it, and visitors of a published page showing it. Anyone else gets the
 * same 404 as for a file that doesn't exist.
 *
 * Only raster images, video, audio and PDF are shown in the browser; everything else (SVG and
 * HTML included) is a download, never sniffed into something else, and sandboxed should a browser
 * render it anyway; `?download=1` makes any file a download. Single byte ranges are served, so
 * video and audio can seek. PDFs can be framed
 * by this site only (the inline viewer), with `?view=pdf` guaranteeing the frame gets a PDF.
 *
 * The bytes come from wherever the file is stored (the workspace's own storage or the instance's),
 * always through here: that storage needs no public access.
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
  const found = await fileForViewer(session?.user.id ?? null, id);
  if (!found) return notFound();
  // Inline PDF viewers (components/page/pdf-viewer.tsx) ask for `?view=pdf`: anything that isn't
  // stored as a PDF is refused there, so a frame never downloads or shows another kind of file.
  const search = new URL(request.url).searchParams;
  const view = search.get("view");
  if (view !== null && (view !== "pdf" || found.contentType !== "application/pdf")) return notFound();
  // "Download" in a block's menu (lib/downloads) asks for `?download=1`: saved, never shown.
  const download = search.get("download") === "1" && view === null;

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": found.contentType,
    "Content-Disposition": download ? dispositionOf("application/octet-stream", found.name) : dispositionOf(found.contentType, found.name),
    // Access can be taken away, so only the viewer's own browser keeps it, and not for long.
    "Cache-Control": "private, max-age=300",
    ETag: `"${found.id}"`,
    "Accept-Ranges": "bytes",
  };
  // Browsers' PDF viewers don't run in a sandbox; every other type can do without scripts entirely.
  // PDFs are shown in place by this site's pages (see pdf-viewer.tsx) and may be framed by them
  // alone; the viewer runs in the browser's own origin, never with this site's.
  if (found.contentType === "application/pdf") {
    headers["Content-Security-Policy"] = "frame-ancestors 'self'";
    headers["X-Frame-Options"] = "SAMEORIGIN";
  } else {
    headers["Content-Security-Policy"] = isSafeInline(found.contentType)
      ? "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
      : "default-src 'none'; sandbox";
  }

  // The bytes behind an id never change.
  if (request.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get("range"), found.size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${found.size}` } });
  }
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = await (await storageOf(found)).get(refOf(found), range ?? undefined);
  } catch (error) {
    // The workspace's own storage refused or couldn't be reached (Settings > Storage shows why).
    if (!(error instanceof StorageError)) throw error;
    return new Response("The file's storage isn't answering", {
      status: 502,
      headers: { ...BASE_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" },
    });
  }
  if (!body) return notFound();
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${found.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(body, { status: 206, headers });
  }
  headers["Content-Length"] = String(found.size);
  return new Response(body, { status: 200, headers });
}
