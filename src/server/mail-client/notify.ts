import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailMessage } from "@/db/schema";
import { env } from "@/lib/env";
import { mailPushPayload } from "@/lib/mail-push";
import { sectionOf } from "@/lib/mail-senders";
import { pushToPerson } from "@/server/push";
import { requireMailIn } from "./access";
import { senderRules } from "./senders";

/**
 * New mail pushed to its mailbox owner's devices (server/push.ts), for a mailbox whose owner left
 * `mailbox.notify` on: the index (indexer.ts `arrived`) calls notifyNewMail with the messages it
 * just added to the inbox, read by the minute's sweep or by a tab watching it. Only mail still
 * unread, sent lately, not the owner's own, and in the inbox's Focus counts: not automated (lists,
 * newsletters, replies sent by machines) unless a sender rule says otherwise (senders.ts); what a
 * pass found goes as one message (lib/mail-push.ts). Only while the owner may use the Mail tab there.
 */

/** Mail sent longer ago than this isn't new: one moved back into the inbox, or long held up on the way. */
const FRESH_MS = 86_400_000;

type Box = Pick<typeof mailbox.$inferSelect, "id" | "workspaceId" | "userId" | "address" | "notify">;

/** Pushes the new mail among `messageIds`; returns how many messages it named. */
export async function notifyNewMail(box: Box, messageIds: string[]): Promise<number> {
  if (!env.vapid || !box.notify || !messageIds.length) return 0;
  try {
    await requireMailIn(box.userId, box.workspaceId);
  } catch {
    return 0;
  }
  const messages = await db
    .select({
      id: mailMessage.id,
      threadId: mailMessage.threadId,
      folderId: mailMessage.folderId,
      fromName: mailMessage.fromName,
      fromAddress: mailMessage.fromAddress,
      seen: mailMessage.seen,
      draft: mailMessage.draft,
      automated: mailMessage.automated,
      sentAt: mailMessage.sentAt,
    })
    .from(mailMessage)
    .where(and(eq(mailMessage.mailboxId, box.id), inArray(mailMessage.id, messageIds), gt(mailMessage.sentAt, new Date(Date.now() - FRESH_MS))));
  if (!messages.length) return 0;
  // Mail the owner sent from any of their mailboxes here (a copy to themselves, a reply that came back).
  const own = new Set(
    (await db.select({ address: mailbox.address }).from(mailbox).where(and(eq(mailbox.workspaceId, box.workspaceId), eq(mailbox.userId, box.userId)))).map((b) =>
      b.address.toLowerCase(),
    ),
  );
  // What the inbox puts in Focus, by the owner's sender rules: never a blocked address's.
  const rules = await senderRules(
    box.userId,
    messages.map((m) => m.fromAddress),
  );
  const fresh = messages
    .filter((m) => !m.seen && !m.draft && !own.has(m.fromAddress.toLowerCase()) && sectionOf(m.automated, rules.get(m.fromAddress.toLowerCase()) ?? null) === "focus")
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  if (!fresh.length) return 0;
  pushToPerson(box.userId, box.workspaceId, (t) => mailPushPayload(box, fresh, t));
  return fresh.length;
}
