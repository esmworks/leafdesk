import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailDatabase, page, rowEmail, rowEmailAttachment, user } from "@/db/schema";
import { fileUrl } from "@/lib/files";
import { normalizeAddress, ROW_EMAIL_PAGE, type RowEmailView } from "@/lib/mail";
import { AccessError } from "@/server/access";
import { workspaceSettings } from "@/server/workspaces";
import { requestRowMailAccess } from "./access";

/**
 * A row's email section: its messages, newest first, a page at a time, for whoever may read them
 * (see access.ts). Hidden ones stay out; whoever brought one in (the mailbox's owner) or has full
 * access to the database may hide it.
 */

export type RowEmailList = {
  emails: RowEmailView[];
  /** More older ones to load, before the last one's time. */
  more: boolean;
  /** Email on rows is on in the workspace and the viewer has a mailbox there: they may write. */
  canSend: boolean;
  /** The viewer's mailboxes in the workspace, which mail may go out from: the default first, each with its signature as plain text. */
  senders: { id: string; address: string; displayName: string | null; signatureText: string | null }[];
  /** The row's own addresses (its matched email properties), for a new message's To. */
  addresses: string[];
};

export async function listRowEmails(userId: string, rowId: string, before?: string | null): Promise<RowEmailList | null> {
  const access = await requestRowMailAccess(userId, rowId);
  if (!access) return null;
  const cursor = before ? new Date(before) : null;
  const rows = await db
    .select({ email: rowEmail, owner: mailbox.userId, mailboxId: mailbox.id, sender: { id: user.id, name: user.name, image: user.image } })
    .from(rowEmail)
    .leftJoin(mailbox, eq(mailbox.id, rowEmail.mailboxId))
    .leftJoin(user, eq(user.id, rowEmail.sentBy))
    .where(
      and(
        eq(rowEmail.rowId, rowId),
        ne(rowEmail.status, "hidden"),
        cursor && !Number.isNaN(cursor.getTime()) ? lt(rowEmail.sentAt, cursor) : undefined,
      ),
    )
    .orderBy(desc(rowEmail.sentAt), desc(rowEmail.id))
    .limit(ROW_EMAIL_PAGE + 1);
  const shown = rows.slice(0, ROW_EMAIL_PAGE);
  const attachments = shown.length
    ? await db
        .select()
        .from(rowEmailAttachment)
        .where(
          inArray(
            rowEmailAttachment.rowEmailId,
            shown.map((r) => r.email.id),
          ),
        )
    : [];
  const [settings, own, [row], [matched]] = await Promise.all([
    workspaceSettings(access.workspaceId),
    db
      .select({ id: mailbox.id, address: mailbox.address, displayName: mailbox.displayName, signatureText: mailbox.signatureText })
      .from(mailbox)
      .where(and(eq(mailbox.workspaceId, access.workspaceId), eq(mailbox.userId, userId)))
      .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt)),
    db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)),
    db.select({ propertyIds: mailDatabase.propertyIds }).from(mailDatabase).where(eq(mailDatabase.databaseId, access.databaseId)),
  ]);
  const values = (row?.properties ?? {}) as Record<string, unknown>;
  const addresses = [...new Set((matched?.propertyIds ?? []).map((id) => normalizeAddress(values[id])).filter((a): a is string => !!a))];
  return {
    emails: shown.map(({ email, owner, mailboxId, sender }) => ({
      id: email.id,
      direction: email.direction,
      status: email.status,
      from: { address: email.fromAddress, name: email.fromName },
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      text: email.text,
      html: null,
      sentAt: email.sentAt.toISOString(),
      unverifiedSender: email.unverifiedSender,
      error: email.status === "failed" ? email.error : null,
      sentBy: sender?.id ? { id: sender.id, name: sender.name, image: sender.image } : null,
      attachments: attachments
        .filter((a) => a.rowEmailId === email.id)
        .map((a) => ({ fileId: a.fileId, name: a.name, url: fileUrl(a.fileId), contentId: a.contentId })),
      canHide: access.databaseFull || owner === userId || email.sentBy === userId,
      ownMailboxId: owner === userId ? mailboxId : null,
    })),
    more: rows.length > ROW_EMAIL_PAGE,
    canSend: settings.email && own.length > 0 && atLeastEdit(access.level),
    senders: own,
    addresses,
  };
}

const atLeastEdit = (level: string) => level === "edit" || level === "full";

/** Hides a message from its row (and the inbox): its mailbox's owner, its sender or full access to the database. */
export async function hideRowEmail(userId: string, rowEmailId: string) {
  const [found] = await db
    .select({ rowId: rowEmail.rowId, owner: mailbox.userId, sentBy: rowEmail.sentBy, status: rowEmail.status })
    .from(rowEmail)
    .leftJoin(mailbox, eq(mailbox.id, rowEmail.mailboxId))
    .where(eq(rowEmail.id, rowEmailId));
  if (!found) throw new AccessError();
  const access = await requestRowMailAccess(userId, found.rowId);
  if (!access || !(access.databaseFull || found.owner === userId || found.sentBy === userId)) throw new AccessError();
  // One still waiting to go out is held back instead: hiding it stops it.
  await db
    .update(rowEmail)
    .set({ status: "hidden", nextAttemptAt: null })
    .where(and(eq(rowEmail.id, rowEmailId), ne(rowEmail.status, "hidden")));
}
