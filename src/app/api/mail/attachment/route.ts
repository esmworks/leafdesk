import { auth } from "@/lib/auth";
import { dispositionOf, isSafeInline } from "@/lib/files";
import { AccessError } from "@/server/access";
import { readAttachment } from "@/server/mail-client/read";
import { RowMailError } from "@/server/row-mail/settings";

/**
 * A file of a message in the Mail tab, read from the mail server for the mailbox's owner and nobody
 * else (server/mail-client/read.ts); anyone else gets the same 404 as for a file that doesn't exist.
 * Served as /api/files serves uploads: only raster images and PDFs in the browser, everything else
 * as a download, never sniffed, and sandboxed should a browser render it anyway. `?m=` is the
 * message's id in the index, `?p=` the part.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

const answer = (status: number, text: string) => new Response(text, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain" } });

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return answer(404, "Not found");
  const url = new URL(request.url);
  try {
    const file = await readAttachment(session.user.id, { id: url.searchParams.get("m") ?? "", part: url.searchParams.get("p") ?? "" });
    const download = url.searchParams.get("download") === "1";
    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": file.contentType,
        "Content-Disposition": download ? dispositionOf("application/octet-stream", file.name) : dispositionOf(file.contentType, file.name),
        "Content-Security-Policy":
          file.contentType === "application/pdf"
            ? "frame-ancestors 'self'"
            : isSafeInline(file.contentType)
              ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
              : "default-src 'none'; sandbox",
        "Content-Length": String(file.data.length),
      },
    });
  } catch (error) {
    if (error instanceof RowMailError && error.code === "tooMany") return answer(413, "The file is too large");
    if (error instanceof RowMailError || error instanceof AccessError) return answer(404, "Not found");
    return answer(502, "The mail server isn't answering");
  }
}
