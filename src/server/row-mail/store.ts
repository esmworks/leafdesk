import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import type { ParsedMail } from "mailparser";
import { db } from "@/db";
import { file, rowEmail, rowEmailAttachment } from "@/db/schema";
import { MAX_MAIL_TEXT, type RowEmailDirection } from "@/lib/mail";
import { storeFile } from "@/server/files";
import { recordRowEmail } from "@/server/notifications";
import { rowFollowers } from "@/server/row-follow";
import { seeRowMail } from "./access";
import type { RowMatch } from "./match";

/** A message read from a mailbox, to put on the row it matched. */
export type IncomingMail = {
  workspaceId: string;
  mailboxId: string;
  /** The mailbox's owner: told about mail that comes in, and the sender of what their sent folder holds. */
  ownerId: string;
  direction: RowEmailDirection;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  sentAt: Date;
  unverifiedSender: boolean;
  /** Written by a machine (an auto-reply, bulk mail): kept, but nobody is told. */
  automated: boolean;
  parsed: ParsedMail;
};

/** Attachments a message brings at most; the rest are left in the mailbox. */
const MAX_ATTACHMENTS = 20;

/**
 * Puts a message on its row with its attachments (as files of the row) and tells, for mail that
 * came in, the mailbox's owner and the row's followers who may read it. A message already on a row
 * of the workspace (it reached two mailboxes, or it is the copy of one sent from here) is left
 * alone. Returns the new message's id, or null.
 */
export async function storeIncoming(match: RowMatch, mail: IncomingMail): Promise<string | null> {
  const text = (mail.parsed.text ?? "").replace(/\r\n/g, "\n").slice(0, MAX_MAIL_TEXT);
  const [stored] = await db
    .insert(rowEmail)
    .values({
      workspaceId: mail.workspaceId,
      mailboxId: mail.mailboxId,
      databaseId: match.databaseId,
      rowId: match.rowId,
      direction: mail.direction,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references.slice(-50),
      fromAddress: mail.from.address,
      fromName: mail.from.name,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject.slice(0, 2000),
      text,
      unverifiedSender: mail.unverifiedSender,
      sentAt: mail.sentAt,
      status: mail.direction === "in" ? "received" : "sent",
      sentBy: mail.direction === "out" ? mail.ownerId : null,
    })
    .onConflictDoNothing()
    .returning({ id: rowEmail.id });
  if (!stored) return null;

  const attachments = mail.parsed.attachments.filter((a) => a.content?.length).slice(0, MAX_ATTACHMENTS);
  const kept: { fileId: string; name: string; contentId: string | null }[] = [];
  for (const attachment of attachments) {
    try {
      const saved = await storeFile(
        { workspaceId: mail.workspaceId, pageId: match.rowId, uploadedBy: null },
        {
          name: attachment.filename || "attachment",
          contentType: attachment.contentType,
          body: Readable.from(attachment.content),
          declaredSize: attachment.size ?? attachment.content.length,
        },
      );
      kept.push({ fileId: saved.id, name: saved.name, contentId: attachment.cid ?? null });
    } catch (error) {
      // Over the file size or the workspace's storage: the message comes without it.
      console.warn("[row-mail] an attachment was left out", (error as Error).message);
    }
  }
  if (kept.length) {
    await db.insert(rowEmailAttachment).values(kept.map((k) => ({ rowEmailId: stored.id, ...k })));
    // Kept with the message, so the cleanup of uploads no page shows leaves them.
    await db
      .update(file)
      .set({ referencedAt: new Date() })
      .where(
        inArray(
          file.id,
          kept.map((k) => k.fileId),
        ),
      );
  }

  if (mail.direction === "in" && !mail.automated) {
    const followers = (await rowFollowers(match.rowId)) ?? [];
    const told = await seeRowMail([mail.ownerId, ...followers], match.rowId);
    await recordRowEmail(mail.workspaceId, match.rowId, stored.id, told);
  }
  return stored.id;
}

/** Whether a message with this id is on a row of the workspace already. */
export async function knownMessage(workspaceId: string, messageId: string) {
  const [found] = await db
    .select({ id: rowEmail.id })
    .from(rowEmail)
    .where(and(eq(rowEmail.workspaceId, workspaceId), eq(rowEmail.messageId, messageId)))
    .limit(1);
  return !!found;
}
