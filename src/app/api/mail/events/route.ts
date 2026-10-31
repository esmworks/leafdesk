import { auth } from "@/lib/auth";
import { MAX_MAILBOXES } from "@/lib/mail";
import { requireOwnMailbox } from "@/server/mail-client/access";
import { watchMailbox, type MailChange } from "@/server/mail-client/watch";

export const dynamic = "force-dynamic";

/**
 * New mail in the Mail tab as it comes: an event stream with a `{ mailboxId, folderId }` message
 * each time a mailbox's inbox changed on the mail server and its index was read again (watch.ts).
 * `?box=` names the mailboxes, each the person's own (anyone else gets a 404, as for one that
 * doesn't exist). The stream ends after a few minutes and the browser opens it again, which checks
 * the session and the mailboxes again.
 */
const PING_MS = 25_000;
const LIFETIME_MS = 10 * 60_000;

const answer = (status: number) => new Response("Not found", { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return answer(404);
  const ids = [...new Set(new URL(request.url).searchParams.getAll("box"))];
  if (!ids.length || ids.length > MAX_MAILBOXES) return answer(404);
  try {
    for (const id of ids) await requireOwnMailbox(session.user.id, id);
  } catch {
    return answer(404);
  }

  const encoder = new TextEncoder();
  let end = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          end();
        }
      };
      const stops = ids.map((id) => watchMailbox(id, (change: MailChange) => send(`data: ${JSON.stringify(change)}\n\n`)));
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      const over = setTimeout(() => {
        end();
        try {
          controller.close();
        } catch {}
      }, LIFETIME_MS);
      end = () => {
        end = () => {};
        clearInterval(ping);
        clearTimeout(over);
        for (const stop of stops) stop();
      };
      request.signal.addEventListener("abort", () => end());
      // The browser waits this long before opening it again after it ends.
      send("retry: 3000\n\n");
    },
    cancel() {
      end();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
