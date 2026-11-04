import { and, desc, eq, type SQL } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { db } from "@/db";
import { mailFolder, mailMessage, user, type mailbox } from "@/db/schema";
import { bareMessageId, MAX_MAIL_TEXT, normalizeAddress } from "@/lib/mail";
import { MAX_COMPOSE_BYTES, MAX_MAIL_HTML, MAX_MAIL_RECIPIENTS, type MailDraftInput } from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { INLINE_CID, outgoingBody } from "./outgoing";
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

async function findStored(box: Box, which: SQL): Promise<StoredMessage | null> {
  const [found] = await db
    .select({ message: mailMessage, path: mailFolder.path })
    .from(mailMessage)
    .innerJoin(mailFolder, eq(mailFolder.id, mailMessage.folderId))
    .where(and(eq(mailMessage.mailboxId, box.id), which))
    .orderBy(desc(mailMessage.sentAt))
    .limit(1);
  return found ? { ...found.message, path: found.path } : null;
}

/** A Message-ID as the index keeps it, or null when what came isn't one. */
function messageIdOf(value: unknown): string | null {
  const id = typeof value === "string" ? bareMessageId(value) : "";
  return id && id.length <= 998 && !/[\s<>]/.test(id) ? id : null;
}

/**
 * A message of the person's mailbox, with its folder's path: by its id in the index, else by its
 * Message-ID (`messageId`) wherever the index has it now, as after it was moved or its folder was
 * numbered anew, which gives it a new id; `gone` when the index has neither.
 */
export async function storedMessage(box: Box, id: unknown, messageId?: unknown): Promise<StoredMessage> {
  const byId = typeof id === "string" && id ? await findStored(box, eq(mailMessage.id, id)) : null;
  const bare = byId ? null : messageIdOf(messageId);
  const found = byId ?? (bare ? await findStored(box, eq(mailMessage.messageId, bare)) : null);
  if (!found) throw new RowMailError("gone");
  return found;
}

/**
 * The message an answer answers: its Message-ID and the references it carries on, and where it is
 * when the index has it (to mark it answered). An answer still goes when the index lost it, by the
 * Message-ID the composer knows.
 */
export type Answered = { messageId: string; references: string[]; stored: StoredMessage | null };

async function answered(box: Box, id: unknown, messageId: unknown): Promise<Answered | null> {
  const stored = await storedMessage(box, id, messageId).catch((error) => {
    if (error instanceof RowMailError && error.code === "gone" && messageIdOf(messageId)) return null;
    throw error;
  });
  if (stored) return stored.messageId ? { messageId: stored.messageId, references: stored.references, stored } : null;
  return { messageId: messageIdOf(messageId)!, references: [], stored: null };
}

export type Written = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | undefined;
  /** The message it answers, whose references it carries. */
  answers: Answered | null;
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
  const answers = draft.replyTo ? await answered(box, draft.replyTo, draft.sourceMessageId) : null;
  return { to, cc, bcc, subject, text, html: cleaned?.html, answers };
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

/** A picture put in the message's text (pasted or dropped there), sent with the Content-ID its `<img>` shows. */
export type InlineFile = { cid: string; file: File };
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Pictures the person put in the text, as parts of the message, within MAX_COMPOSE_BYTES with the `already` there. */
export async function inlineFiles(files: InlineFile[], already: number): Promise<Attachment[]> {
  if (!Array.isArray(files) || files.length > 20) throw new RowMailError("invalid");
  const out: Attachment[] = [];
  let bytes = already;
  for (const { cid, file } of files) {
    if (!(file instanceof File) || typeof cid !== "string" || !INLINE_CID.test(cid) || !PICTURE_TYPES.has(file.type)) throw new RowMailError("invalid");
    bytes += file.size;
    if (bytes > MAX_COMPOSE_BYTES) throw new RowMailError("tooMany");
    out.push({ filename: file.name || "image", content: Buffer.from(await file.arrayBuffer()), contentType: file.type, cid });
  }
  return out;
}

export const attachedBytes = (list: Attachment[]) => list.reduce((n, a) => n + a.content.length, 0);

/**
 * Files of a message on the mail server: the parts `parts` names, with "files" every file that
 * isn't an image of its text (what a forward brings), or by `cids` the images of its text that
 * have them. The connection is the mailbox's, its folder not held: this holds it.
 */
export async function filesOf(client: ImapFlow, message: StoredMessage, parts: string[] | "files" | { cids: Set<string> }): Promise<Attachment[]> {
  const lock = await client.getMailboxLock(message.path, { readOnly: true });
  try {
    const fetched = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!fetched || !fetched.bodyStructure) throw new RowMailError("gone");
    const out: Attachment[] = [];
    let bytes = 0;
    for (const part of messageParts(fetched.bodyStructure).attachments) {
      if (parts === "files" ? part.inline : Array.isArray(parts) ? !parts.includes(part.part) : !(part.inline && part.contentId && parts.cids.has(part.contentId))) continue;
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
  // A picture whose part didn't come along (an upload lost on the way) goes rather than show broken.
  const parts = new Set(attachments.flatMap((a) => (a.cid ? [a.cid] : [])));
  const html = w.html?.replace(/<img\b[^>]*\bsrc="cid:([^"]+)"[^>]*>/gi, (img, cid: string) => (parts.has(cid) ? img : ""));
  const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const references = w.answers ? [...w.answers.references, w.answers.messageId].slice(-20) : [];
  const node = new MailComposer({
    from: { name: box.displayName || person?.name || "", address: box.address },
    to: w.to,
    cc: w.cc.length ? w.cc : undefined,
    bcc: w.bcc.length ? w.bcc : undefined,
    subject: w.subject,
    text: w.text,
    html,
    messageId: `<${options.messageId}>`,
    inReplyTo: w.answers ? `<${w.answers.messageId}>` : undefined,
    references: references.length ? references.map((id) => `<${id}>`) : undefined,
    date: new Date(),
    attachments,
  }).compile();
  node.keepBcc = options.draft;
  return node.build();
}
