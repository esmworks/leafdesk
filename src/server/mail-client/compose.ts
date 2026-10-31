import { and, eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { db } from "@/db";
import { mailFolder, mailMessage, user, type mailbox } from "@/db/schema";
import { MAX_MAIL_TEXT, normalizeAddress } from "@/lib/mail";
import { MAX_COMPOSE_BYTES, MAX_MAIL_HTML, MAX_MAIL_RECIPIENTS, type MailDraftInput } from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { outgoingBody } from "./outgoing";
import { decodeTransfer, messageParts, readPart } from "./structure";

/**
 * A message written in the Mail tab, made into what goes out or is kept as a draft: who it goes to
 * and what it says checked, the files it brings gathered (new ones, ones kept from its last saved
 * draft or from the message it forwards), and the MIME message built.
 */

type Box = typeof mailbox.$inferSelect;
type MessageRow = typeof mailMessage.$inferSelect;
export type StoredMessage = MessageRow & { path: string };
export type Attachment = { filename: string; content: Buffer; contentType: string; cid?: string };

/** Files from the mail server may take a third more on the way (base64). */
const ON_THE_WAY = 1.4;

function addresses(values: unknown): string[] {
  if (!Array.isArray(values)) throw new RowMailError("invalid");
  const out = values.map(normalizeAddress);
  if (out.some((a) => !a)) throw new RowMailError("invalid");
  return [...new Set(out as string[])];
}

/** A message of the person's mailbox, with its folder's path; `gone` when it isn't in the index. */
export async function storedMessage(box: Box, id: unknown): Promise<StoredMessage> {
  const [found] =
    typeof id === "string" && id
      ? await db
          .select({ message: mailMessage, path: mailFolder.path })
          .from(mailMessage)
          .innerJoin(mailFolder, eq(mailFolder.id, mailMessage.folderId))
          .where(and(eq(mailMessage.id, id), eq(mailMessage.mailboxId, box.id)))
      : [];
  if (!found) throw new RowMailError("gone");
  return { ...found.message, path: found.path };
}

export type Written = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | undefined;
  /** The message it answers, whose references it carries. */
  answers: StoredMessage | null;
};

/**
 * What a draft says, checked: a message to send needs a recipient and something written, a draft
 * to keep doesn't. The HTML is the editor's, cleaned (outgoing.ts); a draft keeps where its
 * signature is, so it opens again with it.
 */
export async function written(box: Box, draft: MailDraftInput, options: { toSend: boolean }): Promise<Written> {
  const to = addresses(draft.to ?? []);
  const cc = addresses(draft.cc ?? []).filter((a) => !to.includes(a));
  const bcc = addresses(draft.bcc ?? []).filter((a) => !to.includes(a) && !cc.includes(a));
  const subject = typeof draft.subject === "string" ? draft.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 900) : "";
  // What the editor wrote, as HTML, with its plain-text part written from it; else plain text alone.
  const cleaned = typeof draft.html === "string" && draft.html.length <= MAX_MAIL_HTML ? await outgoingBody(draft.html, { keepSignature: !options.toSend }) : null;
  if (typeof draft.html === "string" && !cleaned) throw new RowMailError("invalid");
  const text = cleaned ? cleaned.text : typeof draft.text === "string" ? draft.text.replace(/\r\n/g, "\n") : "";
  const recipients = to.length + cc.length + bcc.length;
  if (recipients > MAX_MAIL_RECIPIENTS || text.length > MAX_MAIL_TEXT) throw new RowMailError("invalid");
  if (options.toSend && (!recipients || (!subject && !text.trim()))) throw new RowMailError("invalid");
  const answers = draft.replyTo ? await storedMessage(box, draft.replyTo) : null;
  return { to, cc, bcc, subject, text, html: cleaned?.html, answers: answers?.messageId ? answers : null };
}

/** Files the person added, as attachments, within MAX_COMPOSE_BYTES with the `already` there. */
export async function addedFiles(files: File[], already: number): Promise<Attachment[]> {
  if (!Array.isArray(files) || files.length > 20 || files.some((f) => !(f instanceof File))) throw new RowMailError("invalid");
  const out: Attachment[] = [];
  let bytes = already;
  for (const file of files) {
    bytes += file.size;
    if (bytes > MAX_COMPOSE_BYTES) throw new RowMailError("tooMany");
    out.push({ filename: file.name || "file", content: Buffer.from(await file.arrayBuffer()), contentType: file.type || "application/octet-stream" });
  }
  return out;
}

export const attachedBytes = (list: Attachment[]) => list.reduce((n, a) => n + a.content.length, 0);

/**
 * Files of a message on the mail server: the parts `parts` names, or with "files" every file that
 * isn't an image of its text (what a forward brings). The connection is the mailbox's, its folder
 * not held: this holds it.
 */
export async function filesOf(client: ImapFlow, message: StoredMessage, parts: string[] | "files"): Promise<Attachment[]> {
  const lock = await client.getMailboxLock(message.path, { readOnly: true });
  try {
    const fetched = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!fetched || !fetched.bodyStructure) throw new RowMailError("gone");
    const out: Attachment[] = [];
    let bytes = 0;
    for (const part of messageParts(fetched.bodyStructure).attachments) {
      if (parts === "files" ? part.inline : !parts.includes(part.part)) continue;
      bytes += part.size;
      if (bytes > MAX_COMPOSE_BYTES * ON_THE_WAY) throw new RowMailError("tooMany");
      const raw = await readPart(client, message.uid, part.part, Math.ceil(MAX_COMPOSE_BYTES * ON_THE_WAY));
      if (!raw) continue;
      out.push({ filename: part.name, content: decodeTransfer(raw, part.encoding), contentType: part.contentType, cid: part.inline && part.contentId ? part.contentId : undefined });
    }
    return out;
  } finally {
    lock.release();
  }
}

/** A new Message-ID on the mailbox's domain. */
export const newMessageId = (box: Box) => `${crypto.randomUUID()}@${box.address.split("@")[1]}`;

/**
 * The MIME message: from the mailbox (its name, else the person's), answering what `w.answers`
 * names (In-Reply-To, References). A draft keeps its Bcc header, which a sent message never shows.
 */
export async function buildMessage(userId: string, box: Box, w: Written, attachments: Attachment[], options: { messageId: string; draft: boolean }) {
  const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const references = w.answers ? [...w.answers.references, w.answers.messageId!].slice(-20) : [];
  const node = new MailComposer({
    from: { name: box.displayName || person?.name || "", address: box.address },
    to: w.to,
    cc: w.cc.length ? w.cc : undefined,
    bcc: w.bcc.length ? w.bcc : undefined,
    subject: w.subject,
    text: w.text,
    html: w.html,
    messageId: `<${options.messageId}>`,
    inReplyTo: w.answers ? `<${w.answers.messageId}>` : undefined,
    references: references.length ? references.map((id) => `<${id}>`) : undefined,
    date: new Date(),
    attachments,
  }).compile();
  node.keepBcc = options.draft;
  return node.build();
}
