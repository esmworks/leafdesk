import { and, eq, inArray, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { db } from "@/db";
import { mailFolder, mailMessage, user, type mailbox } from "@/db/schema";
import { MAX_MAIL_TEXT, MAX_SENDS_PER_HOUR, normalizeAddress } from "@/lib/mail";
import { MAX_COMPOSE_BYTES, MAX_MAIL_HTML, MAX_MAIL_RECIPIENTS, movableTo, type MailAction, type MailDraftInput } from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { connectError } from "@/server/row-mail/connect";
import { keepSent, SAVES_SENT, sendRaw } from "@/server/row-mail/send";
import { requireOwnMailbox } from "./access";
import { outgoingBody } from "./outgoing";
import { withImap } from "./pool";
import { decodeTransfer, messageParts, readPart } from "./structure";

/**
 * What the Mail tab changes on the mail server: flags, moves between folders, deleting for good
 * from the trash, and sending. The index follows at once, so the list shows the change before the
 * next sweep reads it back.
 */

type Box = typeof mailbox.$inferSelect;
type FolderRow = typeof mailFolder.$inferSelect;
type MessageRow = typeof mailMessage.$inferSelect;

const MAX_THREADS = 200;
const MOVES: Partial<Record<MailAction, "archive" | "trash" | "junk" | "inbox">> = { archive: "archive", trash: "trash", junk: "junk", inbox: "inbox" };
const FLAGS: Partial<Record<MailAction, { flag: string; on: boolean; column: "seen" | "flagged" }>> = {
  read: { flag: "\\Seen", on: true, column: "seen" },
  unread: { flag: "\\Seen", on: false, column: "seen" },
  star: { flag: "\\Flagged", on: true, column: "flagged" },
  unstar: { flag: "\\Flagged", on: false, column: "flagged" },
};
/** Gmail archives by taking a message out of the inbox: it stays in All Mail. */
const ARCHIVES_BY_REMOVING = ["imap.gmail.com"];

async function folders(box: Box) {
  return db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
}

/** The folder a move goes to; an archive folder is made where the server has none (not Gmail). */
async function destination(client: ImapFlow, box: Box, all: FolderRow[], role: "archive" | "trash" | "junk" | "inbox") {
  const found = all.find((f) => f.role === role);
  if (found) return found;
  if (role !== "archive" || ARCHIVES_BY_REMOVING.includes(box.imapHost)) return null;
  const made = await client.mailboxCreate("Archive");
  const [row] = await db
    .insert(mailFolder)
    .values({ mailboxId: box.id, path: made.path, name: "Archive", role: "archive", position: 4 })
    .onConflictDoUpdate({ target: [mailFolder.mailboxId, mailFolder.path], set: { role: "archive" } })
    .returning();
  return row;
}

async function recount(client: ImapFlow, folder: FolderRow) {
  const status = await client.status(folder.path, { unseen: true, messages: true }).catch(() => null);
  if (status) await db.update(mailFolder).set({ unseen: status.unseen ?? folder.unseen, total: status.messages ?? folder.total }).where(eq(mailFolder.id, folder.id));
}

/**
 * Does `action` to threads of a folder. Moves (archive, trash, junk, back to the inbox, or to the
 * folder `to` names) and "delete" (for good, from the trash or junk only) take the thread's
 * messages in this folder; read and unread all of the thread's messages; star its newest message
 * here, unstar all.
 */
export async function mailAction(userId: string, input: { mailboxId: string; folderId: string; threadIds: string[]; action: MailAction; to?: string }) {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const all = await folders(box);
  const folder = all.find((f) => f.id === input.folderId);
  const threadIds = Array.isArray(input.threadIds) ? [...new Set(input.threadIds.filter((t) => typeof t === "string" && t))].slice(0, MAX_THREADS) : [];
  const action = input.action;
  const to = action === "move" ? all.find((f) => f.id === input.to && f.id !== folder?.id && movableTo(f)) : undefined;
  if (!folder || !threadIds.length || !(action in MOVES || action in FLAGS || action === "delete" || to)) throw new RowMailError("invalid");
  if (action === "delete" && folder.role !== "trash" && folder.role !== "junk") throw new RowMailError("invalid");

  const flag = FLAGS[action];
  const hidden = folder.role === "trash" || folder.role === "junk" ? [] : all.filter((f) => f.role === "trash" || f.role === "junk").map((f) => f.id);
  let messages: MessageRow[] = await db
    .select()
    .from(mailMessage)
    .where(
      and(
        eq(mailMessage.mailboxId, box.id),
        inArray(mailMessage.threadId, threadIds),
        flag && action !== "star" ? (hidden.length ? sql`${mailMessage.folderId} not in (${sql.join(hidden.map((id) => sql`${id}`), sql`, `)})` : undefined) : eq(mailMessage.folderId, folder.id),
      ),
    );
  if (action === "star") {
    const newest = new Map<string, MessageRow>();
    for (const m of messages) if (!newest.has(m.threadId) || newest.get(m.threadId)!.sentAt < m.sentAt) newest.set(m.threadId, m);
    messages = [...newest.values()];
  }
  if (flag) messages = messages.filter((m) => m[flag.column] !== flag.on);
  if (!messages.length) return;

  await withImap(box, async (client) => {
    const byFolder = new Map<string, MessageRow[]>();
    for (const m of messages) byFolder.set(m.folderId, [...(byFolder.get(m.folderId) ?? []), m]);
    const target = to ?? (MOVES[action] ? await destination(client, box, all, MOVES[action]!) : null);
    if (MOVES[action] && !target && !(action === "archive" && ARCHIVES_BY_REMOVING.includes(box.imapHost))) throw new RowMailError("gone");
    for (const [folderId, list] of byFolder) {
      const source = all.find((f) => f.id === folderId);
      if (!source || source.id === target?.id) continue;
      const uids = list.map((m) => m.uid).join(",");
      const lock = await client.getMailboxLock(source.path);
      try {
        if (flag) {
          if (flag.on) await client.messageFlagsAdd(uids, [flag.flag], { uid: true });
          else await client.messageFlagsRemove(uids, [flag.flag], { uid: true });
          await db
            .update(mailMessage)
            .set({ [flag.column]: flag.on })
            .where(
              and(
                eq(mailMessage.folderId, source.id),
                inArray(
                  mailMessage.uid,
                  list.map((m) => m.uid),
                ),
              ),
            );
        } else if (target) {
          const moved = await client.messageMove(uids, target.path, { uid: true });
          for (const m of list) {
            const uid = moved && moved.uidMap?.get(m.uid);
            // With the new number the message stays listed where it went; without, the next read finds it there.
            if (uid) await db.update(mailMessage).set({ folderId: target.id, uid }).where(eq(mailMessage.id, m.id)).catch(() => db.delete(mailMessage).where(eq(mailMessage.id, m.id)));
            else await db.delete(mailMessage).where(eq(mailMessage.id, m.id));
          }
        } else {
          // Deleting for good, or archiving on Gmail (out of the inbox, still in All Mail).
          await client.messageDelete(uids, { uid: true });
          await db.delete(mailMessage).where(
            inArray(
              mailMessage.id,
              list.map((m) => m.id),
            ),
          );
        }
      } finally {
        lock.release();
      }
      // STATUS is asked with no folder held open (RFC 3501 says not of the selected one).
      await recount(client, source);
    }
    if (target) await recount(client, target);
  });
}

/** Sends from the Mail tab, per mailbox an hour, in this process (row-mail's sending counts its own). */
const sends = ((globalThis as typeof globalThis & { __leafdeskMailSends?: Map<string, number[]> }).__leafdeskMailSends ??= new Map<string, number[]>());

function addresses(values: unknown): string[] {
  if (!Array.isArray(values)) throw new RowMailError("invalid");
  const out = values.map(normalizeAddress);
  if (out.some((a) => !a)) throw new RowMailError("invalid");
  return [...new Set(out as string[])];
}

type Attachment = { filename: string; content: Buffer; contentType: string; cid?: string };

/**
 * Sends a message from one of the person's mailboxes: an answer (In-Reply-To and References of
 * the message it answers, which is marked answered), a forward (with the files of the message
 * it forwards) or a new one, with `files`. The sent folder keeps a copy where the server doesn't
 * itself; the next read puts it in the index.
 */
export async function sendMail(userId: string, draft: MailDraftInput, files: File[] = []): Promise<{ messageId: string }> {
  const box = await requireOwnMailbox(userId, draft?.mailboxId);
  const to = addresses(draft.to);
  const cc = addresses(draft.cc ?? []).filter((a) => !to.includes(a));
  const bcc = addresses(draft.bcc ?? []).filter((a) => !to.includes(a) && !cc.includes(a));
  const subject = typeof draft.subject === "string" ? draft.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 900) : "";
  // What the editor wrote, as HTML, with its plain-text part written from it; else plain text alone.
  const written = typeof draft.html === "string" && draft.html.length <= MAX_MAIL_HTML ? await outgoingBody(draft.html) : null;
  if (typeof draft.html === "string" && !written) throw new RowMailError("invalid");
  const text = written ? written.text : typeof draft.text === "string" ? draft.text.replace(/\r\n/g, "\n") : "";
  const recipients = [...to, ...cc, ...bcc];
  if (!recipients.length || recipients.length > MAX_MAIL_RECIPIENTS || text.length > MAX_MAIL_TEXT || (!subject && !text.trim())) throw new RowMailError("invalid");
  if (!Array.isArray(files) || files.length > 20 || files.some((f) => !(f instanceof File))) throw new RowMailError("invalid");

  const recent = (sends.get(box.id) ?? []).filter((at) => at > Date.now() - 3_600_000);
  if (recent.length >= MAX_SENDS_PER_HOUR) throw new RowMailError("rateLimited");

  const earlierId = draft.replyTo ?? draft.forward ?? null;
  let earlier: (MessageRow & { path: string }) | null = null;
  if (earlierId) {
    const [found] =
      typeof earlierId === "string"
        ? await db
            .select({ message: mailMessage, path: mailFolder.path })
            .from(mailMessage)
            .innerJoin(mailFolder, eq(mailFolder.id, mailMessage.folderId))
            .where(and(eq(mailMessage.id, earlierId), eq(mailMessage.mailboxId, box.id)))
        : [];
    if (!found) throw new RowMailError("gone");
    earlier = { ...found.message, path: found.path };
  }

  const attachments: Attachment[] = [];
  let bytes = 0;
  for (const file of files) {
    bytes += file.size;
    if (bytes > MAX_COMPOSE_BYTES) throw new RowMailError("tooMany");
    attachments.push({ filename: file.name || "file", content: Buffer.from(await file.arrayBuffer()), contentType: file.type || "application/octet-stream" });
  }
  if (draft.forward && earlier) {
    const forwarded = earlier;
    await withImap(box, async (client) => {
      const lock = await client.getMailboxLock(forwarded.path, { readOnly: true });
      try {
        const fetched = await client.fetchOne(String(forwarded.uid), { uid: true, bodyStructure: true }, { uid: true });
        for (const part of fetched && fetched.bodyStructure ? messageParts(fetched.bodyStructure).attachments : []) {
          if (part.inline) continue;
          bytes += part.size;
          if (bytes > MAX_COMPOSE_BYTES * 1.4) throw new RowMailError("tooMany");
          const raw = await readPart(client, forwarded.uid, part.part, Math.ceil(MAX_COMPOSE_BYTES * 1.4));
          if (!raw) continue;
          attachments.push({ filename: part.name, content: decodeTransfer(raw, part.encoding), contentType: part.contentType });
        }
      } finally {
        lock.release();
      }
    });
  }

  const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const messageId = `${crypto.randomUUID()}@${box.address.split("@")[1]}`;
  const answers = draft.replyTo && earlier?.messageId ? earlier : null;
  const references = answers ? [...answers.references, answers.messageId!].slice(-20) : [];
  const raw = await new MailComposer({
    from: { name: box.displayName || person?.name || "", address: box.address },
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    text,
    html: written?.html,
    messageId: `<${messageId}>`,
    inReplyTo: answers ? `<${answers.messageId}>` : undefined,
    references: references.length ? references.map((id) => `<${id}>`) : undefined,
    date: new Date(),
    attachments,
  })
    .compile()
    .build();

  try {
    await sendRaw(box, raw, recipients);
  } catch (error) {
    const failed = connectError(error);
    throw new RowMailError(failed.code === "auth" || failed.code === "signIn" ? failed.code : "unreachable");
  }
  sends.set(box.id, [...recent, Date.now()]);

  const sent = (await folders(box)).find((f) => f.role === "sent");
  if (sent && !SAVES_SENT.includes(box.imapHost)) await keepSent(box, raw, sent.path);
  if (answers) {
    await withImap(box, async (client) => {
      const lock = await client.getMailboxLock(answers.path);
      try {
        await client.messageFlagsAdd(String(answers.uid), ["\\Answered"], { uid: true });
      } finally {
        lock.release();
      }
    }).catch(() => {});
    await db.update(mailMessage).set({ answered: true }).where(eq(mailMessage.id, answers.id));
  }
  return { messageId };
}
