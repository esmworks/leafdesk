import { and, desc, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailFolder, mailMessage, mailSnooze } from "@/db/schema";
import { startSweep } from "@/server/sweep";
import { recount } from "./folders";
import { withImap } from "./pool";

/**
 * Brings snoozed conversations back. Snoozing (write.ts `mailAction`, action "snooze") moved a
 * thread's messages to the mailbox's snoozed folder and kept a mail_snooze row; when its moment
 * comes they go back to the inbox, the newest unread, and the row's `woke_at` lists the thread at
 * the top of the inbox as of then (read.ts `threadPage`). A mailbox that can't be reached is tried
 * again at the next sweep. Rows woken a fortnight ago are dropped.
 */

type Box = typeof mailbox.$inferSelect;

const KEEP_WOKEN_MS = 14 * 86_400_000;
/** Mailboxes brought back to per run; the rest wait a minute. */
const BOXES_PER_RUN = 50;

/** Brings back what is due at `now` (the sweep's clock; scripts pass a later one). */
export async function runMailSnoozes(now = new Date()) {
  await db.delete(mailSnooze).where(lt(mailSnooze.wokeAt, new Date(now.getTime() - KEEP_WOKEN_MS)));
  const due = await db
    .select()
    .from(mailSnooze)
    .where(and(isNull(mailSnooze.wokeAt), lte(mailSnooze.until, now)));
  const byBox = new Map<string, string[]>();
  for (const row of due) byBox.set(row.mailboxId, [...(byBox.get(row.mailboxId) ?? []), row.threadId]);
  for (const [mailboxId, threadIds] of [...byBox].slice(0, BOXES_PER_RUN)) {
    try {
      const [box] = await db.select().from(mailbox).where(eq(mailbox.id, mailboxId));
      if (box) await wake(box, threadIds);
      await db
        .update(mailSnooze)
        .set({ wokeAt: now })
        .where(and(eq(mailSnooze.mailboxId, mailboxId), inArray(mailSnooze.threadId, threadIds), isNull(mailSnooze.wokeAt)));
    } catch (error) {
      console.error(`[mail-client] snoozed mail of mailbox ${mailboxId} couldn't come back`, error);
    }
  }
}

/** Moves the threads' messages in the snoozed folder back to the inbox, the newest of each unread. */
async function wake(box: Box, threadIds: string[]) {
  const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  const snoozed = folders.find((f) => f.role === "snoozed");
  const inbox = folders.find((f) => f.role === "inbox");
  if (!snoozed || !inbox) return;
  const messages = await db
    .select()
    .from(mailMessage)
    .where(and(eq(mailMessage.folderId, snoozed.id), inArray(mailMessage.threadId, threadIds)))
    .orderBy(desc(mailMessage.sentAt));
  if (!messages.length) return;
  const newest = new Map<string, number>();
  for (const m of messages) if (!newest.has(m.threadId)) newest.set(m.threadId, m.uid);
  const unread = [...newest.values()];

  await withImap(
    box,
    async (client) => {
      const lock = await client.getMailboxLock(snoozed.path);
      try {
        // Flags go along with a move: the newest is unread before it leaves.
        await client.messageFlagsRemove(unread.join(","), ["\\Seen"], { uid: true });
        const moved = await client.messageMove(messages.map((m) => m.uid).join(","), inbox.path, { uid: true });
        for (const m of messages) {
          const uid = moved && moved.uidMap?.get(m.uid);
          const seen = m.seen && !unread.includes(m.uid);
          // Without the new number the message is left to the next read of the inbox, as other moves do.
          if (uid) await db.update(mailMessage).set({ folderId: inbox.id, uid, seen }).where(eq(mailMessage.id, m.id)).catch(() => db.delete(mailMessage).where(eq(mailMessage.id, m.id)));
          else await db.delete(mailMessage).where(eq(mailMessage.id, m.id));
        }
      } finally {
        lock.release();
      }
      await recount(client, snoozed);
      await recount(client, inbox);
    },
    "background",
  );
}

let stop: (() => void) | null = null;

/** Brings snoozed mail back every minute (server.ts). */
export function startMailSnoozes() {
  stop ??= startSweep(60_000, () => runMailSnoozes(), "[mail-client] snooze sweep failed");
  return stop;
}
