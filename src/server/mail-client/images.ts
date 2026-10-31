import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailImageSender, mailMessage } from "@/db/schema";
import { normalizeAddress } from "@/lib/mail";
import { imagesWanted, type MailImagesFrom } from "@/lib/mail-images";
import { RowMailError } from "@/server/row-mail/settings";
import { requireOwnMailbox } from "./access";

/**
 * What the Mail tab remembers about images from other sites (rules in lib/mail-images.ts): the
 * messages whose images the owner asked for, and each mailbox's senders whose images always load.
 */

type Box = typeof mailbox.$inferSelect;
type MessageRow = typeof mailMessage.$inferSelect;

/** The same message in every folder it is in: one opened from the archive is the one read in the inbox. */
const copiesOf = (box: Box, message: MessageRow) =>
  message.messageId ? and(eq(mailMessage.mailboxId, box.id), eq(mailMessage.messageId, message.messageId)) : eq(mailMessage.id, message.id);

/** Why the message's images might load before it is read, remembering a request for them; null when they stay out. */
export async function imagesFor(box: Box, message: MessageRow, asked: boolean): Promise<MailImagesFrom | null> {
  const from = normalizeAddress(message.fromAddress) ?? "";
  const [remembered, trusted] = await Promise.all([
    message.imagesShown || asked
      ? message.imagesShown
      : db
          .select({ id: mailMessage.id })
          .from(mailMessage)
          .where(and(copiesOf(box, message), eq(mailMessage.imagesShown, true)))
          .limit(1)
          .then((rows) => rows.length > 0),
    from
      ? db
          .select({ address: mailImageSender.address })
          .from(mailImageSender)
          .where(and(eq(mailImageSender.mailboxId, box.id), eq(mailImageSender.address, from)))
          .then((rows) => rows.length > 0)
      : false,
  ]);
  if (asked && !message.imagesShown) await db.update(mailMessage).set({ imagesShown: true }).where(copiesOf(box, message));
  return imagesWanted({ asked: asked || remembered, trustedSender: trusted, mailboxAddress: box.address, fromAddress: from });
}

/** Always loads images in mail from this sender to the mailbox. */
export async function trustImageSender(userId: string, input: { mailboxId: string; address: string }) {
  const box = await requireOwnMailbox(userId, input?.mailboxId);
  const address = normalizeAddress(input?.address);
  if (!address) throw new RowMailError("invalid");
  await db.insert(mailImageSender).values({ mailboxId: box.id, address }).onConflictDoNothing();
  return null;
}

/** Stops loading images from this sender unless asked. Works while email is off, too: it only takes trust away. */
export async function forgetImageSender(userId: string, input: { mailboxId: string; address: string }) {
  const [box] =
    typeof input?.mailboxId === "string" ? await db.select({ id: mailbox.id }).from(mailbox).where(and(eq(mailbox.id, input.mailboxId), eq(mailbox.userId, userId))) : [];
  if (!box) throw new RowMailError("noMailbox");
  const address = normalizeAddress(input?.address);
  if (address) await db.delete(mailImageSender).where(and(eq(mailImageSender.mailboxId, box.id), eq(mailImageSender.address, address)));
  return null;
}

export type ImageSenderView = { mailboxId: string; mailbox: string; address: string };

/** The senders whose images the person's mailboxes always load, for Settings. */
export async function listImageSenders(userId: string): Promise<ImageSenderView[]> {
  return db
    .select({ mailboxId: mailImageSender.mailboxId, mailbox: mailbox.address, address: mailImageSender.address })
    .from(mailImageSender)
    .innerJoin(mailbox, eq(mailbox.id, mailImageSender.mailboxId))
    .where(eq(mailbox.userId, userId))
    .orderBy(asc(mailbox.address), asc(mailImageSender.address));
}
