import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { db } from "@/db";
import { mailFolder, mailMessage, mailSend, mailSnooze, rowEmail, type mailbox } from "@/db/schema";
import { bareMessageId, MAX_SENDS_PER_HOUR } from "@/lib/mail";
import { MAIL_MAX_THREADS, MAIL_UNDO_SECONDS, movableTo, snoozableFrom, type MailAction, type MailDraftInput, type MailHeldSend, type MailSentPlace, type MailUndoneSend } from "@/lib/mail-client";
import { snoozeAllowed } from "@/lib/mail-snooze";
import { RowMailError, type RowMailErrorCode } from "@/server/row-mail/settings";
import { connectError } from "@/server/row-mail/connect";
import { keepSent, SAVES_SENT, sendRaw } from "@/server/row-mail/send";
import { requireOwnMailbox } from "./access";
import { buildMessage, newMessageId, written, type Attachment, type InlineFile, type Written } from "./compose";
import { draftForSend, keepAsDraft, sentDraft } from "./drafts";
import { makeFolder, recount } from "./folders";
import { indexFolder } from "./indexer";
import { withImap } from "./pool";
import { withQuote, type Quote } from "./quote";

/**
 * What the Mail tab changes on the mail server: flags, moves between folders, deleting for good
 * from the trash, and sending. The index follows at once, so the list shows the change before the
 * next sweep reads it back.
 */

type Box = typeof mailbox.$inferSelect;
type FolderRow = typeof mailFolder.$inferSelect;
type MessageRow = typeof mailMessage.$inferSelect;

type MoveRole = "archive" | "trash" | "junk" | "inbox" | "snoozed";
const MOVES: Partial<Record<MailAction, MoveRole>> = { archive: "archive", trash: "trash", junk: "junk", inbox: "inbox", snooze: "snoozed" };
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

/** The folder a move goes to; an archive (not on Gmail) or snoozed folder is made where the server has none. */
export async function destination(client: ImapFlow, box: Box, all: FolderRow[], role: MoveRole) {
  const found = all.find((f) => f.role === role);
  if (found) return found;
  if (role === "snoozed") return makeFolder(client, box, "Snoozed", "snoozed");
  if (role !== "archive" || ARCHIVES_BY_REMOVING.includes(box.imapHost)) return null;
  return makeFolder(client, box, "Archive", "archive");
}

/** Moves messages of the folder `client` holds open to `target`, the index following. */
async function moveHeld(client: ImapFlow, list: MessageRow[], target: FolderRow) {
  const moved = await client.messageMove(list.map((m) => m.uid).join(","), target.path, { uid: true });
  for (const m of list) {
    const uid = moved && moved.uidMap?.get(m.uid);
    // With the new number the message stays listed where it went; without, the next read finds it there.
    if (uid) await db.update(mailMessage).set({ folderId: target.id, uid }).where(eq(mailMessage.id, m.id)).catch(() => db.delete(mailMessage).where(eq(mailMessage.id, m.id)));
    else await db.delete(mailMessage).where(eq(mailMessage.id, m.id));
  }
}

/**
 * Moves these messages of a mailbox to its junk folder, on the background lane: mail from a
 * blocked sender as it comes (senders.ts). Nothing happens where the server has no junk folder.
 */
export async function junkMessages(box: Box, messages: MessageRow[]) {
  if (!messages.length) return;
  const all = await folders(box);
  const junk = all.find((f) => f.role === "junk");
  if (!junk) return;
  await withImap(
    box,
    async (client) => {
      for (const source of all) {
        const list = messages.filter((m) => m.folderId === source.id);
        if (!list.length || source.id === junk.id) continue;
        const lock = await client.getMailboxLock(source.path);
        try {
          await moveHeld(client, list, junk);
        } finally {
          lock.release();
        }
        await recount(client, source);
      }
      await recount(client, junk);
    },
    "background",
  );
}

/**
 * Does `action` to threads of a folder. Moves (archive, trash, junk, back to the inbox, or to the
 * folder `to` names) and "delete" (for good, from the trash or junk only) take the thread's
 * messages in this folder; read and unread all of the thread's messages; star its newest message
 * here, unstar all. "snooze" moves them to the snoozed folder until `until` (snooze.ts brings them
 * back); any other move takes a thread's snooze off.
 */
export async function mailAction(userId: string, input: { mailboxId: string; folderId: string; threadIds: string[]; action: MailAction; to?: string; until?: string }) {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const all = await folders(box);
  const folder = all.find((f) => f.id === input.folderId);
  const threadIds = Array.isArray(input.threadIds) ? [...new Set(input.threadIds.filter((t) => typeof t === "string" && t))].slice(0, MAIL_MAX_THREADS) : [];
  const action = input.action;
  const to = action === "move" ? all.find((f) => f.id === input.to && f.id !== folder?.id && movableTo(f)) : undefined;
  if (!folder || !threadIds.length || !(action in MOVES || action in FLAGS || action === "delete" || to)) throw new RowMailError("invalid");
  if (action === "delete" && folder.role !== "trash" && folder.role !== "junk") throw new RowMailError("invalid");
  const until = action === "snooze" && typeof input.until === "string" ? new Date(input.until) : null;
  if (action === "snooze" && !(until && snoozeAllowed(until.getTime(), Date.now()) && snoozableFrom(folder))) throw new RowMailError("invalid");

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
          await moveHeld(client, list, target);
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
  if (flag) return;
  await db.delete(mailSnooze).where(and(eq(mailSnooze.mailboxId, box.id), inArray(mailSnooze.threadId, threadIds)));
  if (until) await db.insert(mailSnooze).values([...new Set(messages.map((m) => m.threadId))].map((threadId) => ({ mailboxId: box.id, threadId, until })));
}

/**
 * Empties the trash or the junk folder: every message in it on the server goes for good, those the
 * index hasn't read yet too.
 */
export async function emptyFolder(userId: string, input: { mailboxId: string; folderId: string }) {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const folder = (await folders(box)).find((f) => f.id === input.folderId);
  if (!folder || (folder.role !== "trash" && folder.role !== "junk")) throw new RowMailError("invalid");
  await withImap(box, async (client) => {
    const lock = await client.getMailboxLock(folder.path);
    try {
      // Searched, not counted: a connection that holds the folder open already may not have heard of
      // new messages. Deleted as one range, not a UID list a large trash would make too long a line.
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      if (uids.length) await client.messageDelete("1:*", { uid: true });
      await db.delete(mailMessage).where(eq(mailMessage.folderId, folder.id));
    } finally {
      lock.release();
    }
    await recount(client, folder);
  });
}

type Prepared = { userId: string; box: Box; draft: MailDraftInput; w: Written; attachments: Attachment[]; quote: Quote | null; raw: Buffer; messageId: string };

/** What the mailbox sent in the last hour: from the Mail tab and to rows, held together to MAX_SENDS_PER_HOUR. */
async function sentThisHour(box: Box) {
  const [row] = await db.execute<{ n: number }>(sql`
    select (select count(*) from ${mailSend} where ${mailSend.mailboxId} = ${box.id} and ${mailSend.sentAt} > now() - interval '1 hour')
      + (select count(*) from ${rowEmail} where ${rowEmail.mailboxId} = ${box.id} and ${rowEmail.direction} = 'out' and ${rowEmail.createdAt} > now() - interval '1 hour') as n
  `);
  return Number(row?.n ?? 0);
}

/**
 * A message ready to go out, checked: who it goes to and what it says, within the hour's sends,
 * with its files gathered (those it kept in its draft, those it forwards, `files`, the pictures of
 * its text, `inline`) and its MIME
 * message built, so what can be wrong with it shows before it waits.
 */
async function prepare(userId: string, draft: MailDraftInput, files: File[], inline: InlineFile[]): Promise<Prepared> {
  const box = await requireOwnMailbox(userId, draft?.mailboxId);
  const typed = await written(box, draft, { toSend: true });
  if ((await sentThisHour(box)) >= MAX_SENDS_PER_HOUR) throw new RowMailError("rateLimited");
  const { attachments, quote } = await draftForSend(userId, box, draft, typed, files, inline);
  const w = withQuote(typed, quote);
  const messageId = newMessageId(box);
  const raw = await buildMessage(userId, box, w, attachments, { messageId, draft: false });
  return { userId, box, draft, w, attachments, quote, raw, messageId };
}

/**
 * Sends a prepared message: an answer is marked answered, the draft it was saved as goes, and the
 * sent folder keeps a copy where the server doesn't itself (the next read puts it in the index).
 */
async function deliver({ userId, box, draft, w, raw }: Prepared) {
  try {
    await sendRaw(box, raw, [...w.to, ...w.cc, ...w.bcc]);
  } catch (error) {
    const failed = connectError(error);
    throw new RowMailError(failed.code === "auth" || failed.code === "signIn" ? failed.code : "unreachable");
  }
  await db.insert(mailSend).values({ mailboxId: box.id });
  await db.delete(mailSend).where(and(eq(mailSend.mailboxId, box.id), lt(mailSend.sentAt, sql`now() - interval '1 day'`)));

  await sentDraft(userId, box, draft.draft);
  const sent = (await folders(box)).find((f) => f.role === "sent");
  if (sent && !SAVES_SENT.includes(box.imapHost)) await keepSent(box, raw, sent.path);
  const answers = w.answers?.stored;
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
}

/**
 * Sends a message from one of the person's mailboxes at once: an answer (In-Reply-To and
 * References of the message it answers), a forward (with the files of the message it forwards)
 * or a new one, with `files`. A message saved as a draft brings the files it kept there.
 */
export async function sendMail(userId: string, draft: MailDraftInput, files: File[] = [], inline: InlineFile[] = []): Promise<void> {
  await deliver(await prepare(userId, draft, files, inline));
}

/**
 * Messages sent from the Mail tab wait MAIL_UNDO_SECONDS here, in this process, for Undo. Waiting
 * on the server, not in the browser, a message still goes when its tab is closed meanwhile; a
 * restart in those seconds loses it, but for the draft it was last saved as.
 */
type Held = Prepared & {
  timer: ReturnType<typeof setTimeout> | null;
  state: "held" | "sending" | "sent" | "undone" | "failed";
  error: RowMailErrorCode | null;
  /** Where the sent copy is in the index, once it went and was found there. */
  sent: MailSentPlace | null;
};
const held = ((globalThis as typeof globalThis & { __leafdeskMailHeld?: Map<string, Held> }).__leafdeskMailHeld ??= new Map<string, Held>());
/** How long the outcome of a send stays to be asked for. */
const KEPT_MS = 10 * 60_000;

const settled = (id: string) => setTimeout(() => held.delete(id), KEPT_MS).unref?.();

/**
 * Sends a message (as sendMail) after MAIL_UNDO_SECONDS, unless undone. Returns the id to undo it
 * by and to ask how it went: a send that fails then keeps the message as a draft.
 */
export async function holdMail(userId: string, draft: MailDraftInput, files: File[] = [], inline: InlineFile[] = []): Promise<MailHeldSend> {
  const prepared = await prepare(userId, draft, files, inline);
  const id = crypto.randomUUID();
  held.set(id, { ...prepared, timer: setTimeout(() => void sendHeld(id), MAIL_UNDO_SECONDS * 1000), state: "held", error: null, sent: null });
  return { sendId: id };
}

/** Sends a held message now (when its seconds are up; the e2e check calls it). */
export async function sendHeld(id: string) {
  const entry = held.get(id);
  if (!entry || entry.state !== "held") return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.state = "sending";
  try {
    await deliver(entry);
    entry.sent = await findSent(entry).catch(() => null);
    entry.state = "sent";
  } catch (error) {
    entry.error = error instanceof RowMailError ? error.code : "unreachable";
    entry.state = "failed";
    if (!(error instanceof RowMailError)) console.error("[mail-client] a held message could not be sent", error);
    await keepAsDraft(entry.userId, entry.draft, entry.attachments, entry.quote).catch((e) => console.error("[mail-client] a message not sent could not be kept as a draft", e));
  }
  settled(id);
}

/** Tries for the sent folder's next read to find it. */
const FIND_SENT_TRIES = 3;

/**
 * Reads the sent folder into the index now, so the message just sent can be opened: a server that
 * keeps the sent copy itself (SAVES_SENT) may show it a moment later, so it looks a few times.
 */
async function findSent({ box, messageId }: Prepared): Promise<MailSentPlace | null> {
  const wanted = bareMessageId(messageId);
  for (let tries = 0; tries < FIND_SENT_TRIES; tries++) {
    if (tries) await new Promise((done) => setTimeout(done, 1500));
    // Read again each time: the folder's row says how far the index has read it.
    const sent = (await folders(box)).find((f) => f.role === "sent");
    if (!sent) return null;
    await withImap(box, (client) => indexFolder(client, box, sent, 20), "background");
    const [found] = await db
      .select({ folderId: mailMessage.folderId, threadId: mailMessage.threadId })
      .from(mailMessage)
      .where(and(eq(mailMessage.mailboxId, box.id), eq(mailMessage.folderId, sent.id), eq(mailMessage.messageId, wanted)))
      .limit(1);
    if (found) return { mailboxId: box.id, ...found };
  }
  return null;
}

/**
 * Takes back a message still waiting: it goes back to the drafts folder (in place of the draft it
 * was saved as), and its draft's id comes back to open it again. Null when it went already.
 */
export async function undoSend(userId: string, id: string): Promise<MailUndoneSend | null> {
  const entry = typeof id === "string" ? held.get(id) : undefined;
  if (!entry || entry.userId !== userId) throw new RowMailError("gone");
  if (entry.state !== "held") return null;
  if (entry.timer) clearTimeout(entry.timer);
  entry.state = "undone";
  settled(id);
  const saved = await keepAsDraft(userId, entry.draft, entry.attachments, entry.quote);
  return { id: saved.id, replyTo: entry.w.answers?.stored?.id ?? null };
}

/** How a held message went, for its sender. */
export function sendStatus(userId: string, id: string): { state: Held["state"] | "gone"; error: RowMailErrorCode | null; sent: MailSentPlace | null } {
  const entry = typeof id === "string" ? held.get(id) : undefined;
  if (!entry || entry.userId !== userId) return { state: "gone", error: null, sent: null };
  return { state: entry.state, error: entry.error, sent: entry.sent };
}
