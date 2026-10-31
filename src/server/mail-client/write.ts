import { and, eq, inArray, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { db } from "@/db";
import { mailFolder, mailMessage, type mailbox } from "@/db/schema";
import { MAX_SENDS_PER_HOUR } from "@/lib/mail";
import { movableTo, type MailAction, type MailDraftInput } from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { connectError } from "@/server/row-mail/connect";
import { keepSent, SAVES_SENT, sendRaw } from "@/server/row-mail/send";
import { requireOwnMailbox } from "./access";
import { buildMessage, newMessageId, written } from "./compose";
import { draftForSend, sentDraft } from "./drafts";
import { makeFolder, recount } from "./folders";
import { withImap } from "./pool";

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
  return makeFolder(client, box, "Archive", "archive");
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

/**
 * Sends a message from one of the person's mailboxes: an answer (In-Reply-To and References of
 * the message it answers, which is marked answered), a forward (with the files of the message
 * it forwards) or a new one, with `files`. A message saved as a draft brings the files it kept
 * there, and its draft goes once it is sent. The sent folder keeps a copy where the server doesn't
 * itself; the next read puts it in the index.
 */
export async function sendMail(userId: string, draft: MailDraftInput, files: File[] = []): Promise<{ messageId: string }> {
  const box = await requireOwnMailbox(userId, draft?.mailboxId);
  const w = await written(box, draft, { toSend: true });
  const recent = (sends.get(box.id) ?? []).filter((at) => at > Date.now() - 3_600_000);
  if (recent.length >= MAX_SENDS_PER_HOUR) throw new RowMailError("rateLimited");
  const attachments = await draftForSend(userId, box, draft, files);
  const messageId = newMessageId(box);
  const raw = await buildMessage(userId, box, w, attachments, { messageId, draft: false });

  try {
    await sendRaw(box, raw, [...w.to, ...w.cc, ...w.bcc]);
  } catch (error) {
    const failed = connectError(error);
    throw new RowMailError(failed.code === "auth" || failed.code === "signIn" ? failed.code : "unreachable");
  }
  sends.set(box.id, [...recent, Date.now()]);

  await sentDraft(userId, box, draft.draft);
  const sent = (await folders(box)).find((f) => f.role === "sent");
  if (sent && !SAVES_SENT.includes(box.imapHost)) await keepSent(box, raw, sent.path);
  const answers = w.answers;
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
