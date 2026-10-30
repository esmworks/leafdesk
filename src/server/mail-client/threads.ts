import { and, between, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailMessage } from "@/db/schema";
import { isReplySubject, SUBJECT_THREAD_DAYS, subjectKey } from "@/lib/mail-client";

/**
 * Which thread a message read into the index belongs to. The server's own thread id when it gives
 * one (Gmail); else the thread of the same message in another folder, of a message it answers, or
 * of one that answers it (read back in time, replies come first), joining two threads when it is
 * what links them; else, for a reply that names nothing it answers, the nearest thread of the same
 * subject within SUBJECT_THREAD_DAYS; else a thread of its own.
 */
export type ThreadedHeader = {
  mailboxId: string;
  folderId: string;
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  sentAt: Date;
  serverThreadId: string | null;
};

export async function threadFor(header: ThreadedHeader): Promise<string> {
  if (header.serverThreadId) return `t:${header.serverThreadId}`;
  const { mailboxId, messageId } = header;
  const answers = [...new Set([header.inReplyTo, ...header.references].filter((id): id is string => !!id))].slice(-50);
  const named = [...new Set([...(messageId ? [messageId] : []), ...answers])];

  let thread: string | null = null;
  if (named.length) {
    const [found] = await db
      .select({ threadId: mailMessage.threadId })
      .from(mailMessage)
      .where(and(eq(mailMessage.mailboxId, mailboxId), inArray(mailMessage.messageId, named)))
      .limit(1);
    thread = found?.threadId ?? null;
  }
  if (messageId) {
    const replies = await db
      .selectDistinct({ threadId: mailMessage.threadId })
      .from(mailMessage)
      .where(and(eq(mailMessage.mailboxId, mailboxId), or(eq(mailMessage.inReplyTo, messageId), sql`${mailMessage.references} @> array[${messageId}]::text[]`)))
      .limit(20);
    const others = replies.map((r) => r.threadId).filter((id) => id !== thread);
    if (!thread && others.length) thread = others.shift()!;
    // The message links threads read apart: they are one.
    if (thread && others.length) {
      await db
        .update(mailMessage)
        .set({ threadId: thread })
        .where(and(eq(mailMessage.mailboxId, mailboxId), inArray(mailMessage.threadId, others)));
    }
  }
  if (thread) return thread;

  const key = subjectKey(header.subject);
  if (key && isReplySubject(header.subject)) {
    const span = SUBJECT_THREAD_DAYS * 86_400_000;
    const [near] = await db
      .select({ threadId: mailMessage.threadId })
      .from(mailMessage)
      .where(
        and(
          eq(mailMessage.mailboxId, mailboxId),
          eq(mailMessage.subjectKey, key),
          between(mailMessage.sentAt, new Date(header.sentAt.getTime() - span), new Date(header.sentAt.getTime() + span)),
        ),
      )
      .orderBy(desc(mailMessage.sentAt))
      .limit(1);
    if (near) return near.threadId;
  }
  return messageId ? `m:${messageId}` : `u:${header.folderId}:${header.uid}`;
}
