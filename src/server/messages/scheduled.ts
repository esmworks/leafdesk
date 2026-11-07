/**
 * Messages written to go out later, and reminders of saved messages: a sweep every 15 seconds
 * (server.ts `startMessageTimers`) sends what is due as its writer, checked again as it goes, and
 * pushes the reminders that came. `runMessageTimers(now)` runs one round as of any moment.
 */
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { channelMessage, savedMessage, scheduledMessage, user } from "@/db/schema";
import { hasWords, snippet } from "@/lib/message-text";
import { MESSAGE_LIMITS, messagesPath } from "@/lib/messages";
import { pushToPerson } from "@/server/push";
import { startSweep } from "@/server/sweep";
import { MessageError, requireChannel, write } from "./core";
import { sendMessage } from "./posts";

const LATEST_MS = 366 * 86_400_000;

/** Writes a message to go out at `sendAt`, or changes one waiting (`id`). */
export async function scheduleMessage(
  userId: string,
  input: { id?: unknown; channelId?: unknown; threadId?: unknown; body?: unknown; fileIds?: unknown; sendAt?: unknown },
): Promise<string> {
  const { channel: row } = await requireChannel(userId, String(input.channelId ?? ""), "write");
  const body = typeof input.body === "string" ? input.body.replace(/\s+$/, "") : "";
  if (body.length > MESSAGE_LIMITS.body) throw new MessageError("tooLong");
  const fileIds = Array.isArray(input.fileIds) ? input.fileIds.filter((f): f is string => typeof f === "string").slice(0, MESSAGE_LIMITS.files) : [];
  if (!hasWords(body) && !fileIds.length) throw new MessageError("invalid");
  const sendAt = typeof input.sendAt === "string" ? new Date(input.sendAt) : null;
  if (!sendAt || Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() - 60_000 || sendAt.getTime() > Date.now() + LATEST_MS) throw new MessageError("invalid");
  const threadId = typeof input.threadId === "string" ? input.threadId : null;
  return write(row.workspaceId, async (tx, changed) => {
    if (typeof input.id === "string") {
      const updated = await tx
        .update(scheduledMessage)
        .set({ body, fileIds, sendAt, failure: null, rev: changed.rev })
        .where(and(eq(scheduledMessage.id, input.id), eq(scheduledMessage.userId, userId)))
        .returning({ id: scheduledMessage.id });
      if (!updated.length) throw new MessageError("notFound");
      changed.scheduled(userId, input.id);
      return input.id;
    }
    const [made] = await tx
      .insert(scheduledMessage)
      .values({ userId, channelId: row.id, workspaceId: row.workspaceId, threadId, body, fileIds, sendAt, rev: changed.rev })
      .returning({ id: scheduledMessage.id });
    changed.scheduled(userId, made.id);
    return made.id;
  });
}

/** Drops a message waiting to go out. */
export async function cancelScheduled(userId: string, workspaceId: string, id: unknown): Promise<void> {
  if (typeof id !== "string") throw new MessageError("invalid");
  await write(workspaceId, async (tx, changed) => {
    const gone = await tx
      .delete(scheduledMessage)
      .where(and(eq(scheduledMessage.id, id), eq(scheduledMessage.userId, userId), eq(scheduledMessage.workspaceId, workspaceId)))
      .returning({ id: scheduledMessage.id });
    if (gone.length) changed.scheduledGone(userId, id);
  });
}

/** Sends the scheduled messages due by `now` and pushes the reminders that came. */
export async function runMessageTimers(now = new Date()): Promise<{ sent: number; failed: number; reminded: number }> {
  let sent = 0;
  let failed = 0;
  const due = await db
    .select()
    .from(scheduledMessage)
    .where(and(lte(scheduledMessage.sendAt, now), isNull(scheduledMessage.failure)))
    .orderBy(asc(scheduledMessage.sendAt))
    .limit(100);
  for (const s of due) {
    try {
      // The scheduled row's id makes the message's: a round cut short and run again sends it once.
      await sendMessage(s.userId, { id: s.id, channelId: s.channelId, threadId: s.threadId, body: s.body, fileIds: s.fileIds });
      await write(s.workspaceId, async (tx, changed) => {
        await tx.delete(scheduledMessage).where(eq(scheduledMessage.id, s.id));
        changed.scheduledGone(s.userId, s.id);
      });
      sent++;
    } catch (error) {
      const code = error instanceof MessageError ? error.code : "internal";
      if (code === "internal") console.error("[messages] a scheduled message failed", error);
      await write(s.workspaceId, async (tx, changed) => {
        await tx.update(scheduledMessage).set({ failure: code, rev: changed.rev }).where(eq(scheduledMessage.id, s.id));
        changed.scheduled(s.userId, s.id);
      });
      failed++;
    }
  }

  const reminders = await db
    .update(savedMessage)
    .set({ remindedAt: now })
    .where(and(lte(savedMessage.remindAt, now), isNull(savedMessage.remindedAt), isNull(savedMessage.doneAt)))
    .returning();
  for (const r of reminders) {
    const [m] = await db
      .select({ body: channelMessage.body, channelId: channelMessage.channelId, threadId: channelMessage.threadId, author: user.name })
      .from(channelMessage)
      .leftJoin(user, eq(user.id, channelMessage.authorId))
      .where(eq(channelMessage.id, r.messageId));
    if (!m) continue;
    try {
      await requireChannel(r.userId, m.channelId);
    } catch {
      continue;
    }
    pushToPerson(r.userId, r.workspaceId, (t) => ({
      title: t("messageReminder"),
      body: `${m.author ?? t("someone")}: ${snippet(m.body, 160)}`,
      url: messagesPath(r.workspaceId, { channelId: m.channelId, messageId: r.messageId, threadId: m.threadId ?? undefined }),
      tag: `message-reminder:${r.messageId}`,
      read: "",
      snooze: "",
    }));
    await write(r.workspaceId, async (tx, changed) => {
      await tx
        .update(savedMessage)
        .set({ rev: changed.rev })
        .where(and(eq(savedMessage.userId, r.userId), eq(savedMessage.messageId, r.messageId)));
      changed.saved(r.userId, r.messageId);
    });
  }
  return { sent, failed, reminded: reminders.length };
}

export function startMessageTimers() {
  return startSweep(15_000, () => runMessageTimers(), "[messages] the timers' round failed");
}
