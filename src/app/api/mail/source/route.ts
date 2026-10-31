import { auth } from "@/lib/auth";
import { dispositionOf } from "@/lib/files";
import { AccessError } from "@/server/access";
import { readSource } from "@/server/mail-client/read";
import { RowMailError } from "@/server/row-mail/settings";

/**
 * A message of the Mail tab as the mail server keeps it, headers and all, for the mailbox's owner
 * and nobody else (anyone else gets the same 404 as for a message that doesn't exist). Shown as
 * plain text, never sniffed and sandboxed, or with `?download=1` saved as an .eml file. `?m=` is
 * the message's id in the index.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

const answer = (status: number, text: string) => new Response(text, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain" } });

/** A file name from the subject: no characters file systems refuse, not too long. */
const fileName = (subject: string) => `${subject.replace(/[\\/:*?"<>|\x00-\x1f\s]+/g, " ").trim().slice(0, 80).trim() || "message"}.eml`;

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return answer(404, "Not found");
  const url = new URL(request.url);
  try {
    const message = await readSource(session.user.id, { id: url.searchParams.get("m") ?? "" });
    const download = url.searchParams.get("download") === "1";
    return new Response(new Uint8Array(message.data), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": download ? "message/rfc822" : "text/plain; charset=utf-8",
        "Content-Disposition": download ? dispositionOf("application/octet-stream", fileName(message.subject)) : "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Length": String(message.data.length),
      },
    });
  } catch (error) {
    if (error instanceof RowMailError && error.code === "tooMany") return answer(413, "The message is too large");
    if (error instanceof RowMailError || error instanceof AccessError) return answer(404, "Not found");
    return answer(502, "The mail server isn't answering");
  }
}
