import { dmarcFailed, parseHeaderBlock } from "@/lib/mail";
import type { MailUnsubscribe } from "@/lib/mail-client";
import { unsubscribeOffer, unsubscribeTargets } from "@/lib/mail-unsubscribe";
import { connectionFetch } from "@/server/connections/fetch";
import { RowMailError } from "@/server/row-mail/settings";
import { withImap } from "./pool";
import { ownMessage } from "./read";
import { sendMail } from "./write";

/**
 * Leaves the mailing list a message came from, on the spot: the list's one-click POST (RFC 8058)
 * from this server, else a mail to the list's address from the mailbox (kept in Sent). The way is
 * read again from the message on the mail server, never taken from the browser; a list offering
 * only a web address is visited by the person instead (lib/mail-unsubscribe.ts).
 */

const POST_MS = 10_000;

/** Unsubscribes with `post`, the fetch (tests pass their own); returns how it went. */
export async function unsubscribe(userId: string, input: { id: string }, post = connectionFetch): Promise<MailUnsubscribe["how"]> {
  const { box, message, folder } = await ownMessage(userId, input?.id);
  const fields = await withImap(box, async (client) => {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const fetched = await client.fetchOne(String(message.uid), { uid: true, headers: ["authentication-results", "list-unsubscribe", "list-unsubscribe-post"] }, { uid: true });
      return fetched ? parseHeaderBlock(fetched.headers) : null;
    } finally {
      lock.release();
    }
  });
  if (!fields) throw new RowMailError("gone");
  const targets = unsubscribeTargets(fields.get("list-unsubscribe")?.[0], fields.get("list-unsubscribe-post")?.[0]);
  const offer = folder.role === "sent" ? null : unsubscribeOffer(targets, dmarcFailed(fields.get("authentication-results")));
  if (offer?.how === "oneClick" && targets.https) {
    // An address the list's sender gave: only WEB_FETCH_ALLOWED_HOSTS may reach past the public web.
    const answered = await post(
      targets.https,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", signal: AbortSignal.timeout(POST_MS) },
      { untrusted: true },
    ).catch(() => null);
    await answered?.body?.cancel().catch(() => undefined);
    if (!answered?.ok) throw new RowMailError("unsubscribeFailed");
    return "oneClick";
  }
  if (offer?.how === "mail" && targets.mail) {
    const { address, subject, body } = targets.mail;
    await sendMail(userId, { mailboxId: box.id, to: [address], cc: [], bcc: [], subject: subject || "unsubscribe", text: body || "unsubscribe" });
    return "mail";
  }
  throw new RowMailError("invalid");
}
