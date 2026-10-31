import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { db } from "@/db";
import { mailFolder, mailMessage, type mailbox } from "@/db/schema";
import { normalizeAddress } from "@/lib/mail";
import { MAX_COMPOSE_BYTES, type MailAddress, type MailDraftInput, type MailDraftRef, type MailDraftView, type MailSavedDraft } from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { requireOwnMailbox } from "./access";
import { addedFiles, attachedBytes, buildMessage, filesOf, newMessageId, storedMessage, written, type Attachment, type StoredMessage, type Written } from "./compose";
import { makeFolder, recount, type FolderRow } from "./folders";
import { indexFolder, indexUids } from "./indexer";
import { cleanMailHtml } from "./html";
import { editableBody } from "./outgoing";
import { freshQuote, keptQuote, splitQuote, withQuote, type Quote } from "./quote";
import { withImap } from "./pool";
import { decodeText, fileView, messageParts, readParts } from "./structure";

/**
 * Drafts of the Mail tab, kept where the person's other mail programs see them: in the mailbox's
 * drafts folder on the mail server. Each save puts the whole message there again (APPEND) and
 * takes the one before out; a draft keeps one Message-ID from its first save to its last, which
 * finds its copies there even when the index doesn't know them yet. Files the person kept come
 * from the draft before, read on the server, so they travel from the browser only once.
 */

type Box = typeof mailbox.$inferSelect;

const MESSAGE_ID = /^[^\s<>"]{1,300}$/;
/** Bytes of a draft's text or HTML read to open it. */
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const travelling = (bytes: number) => Math.ceil(bytes * 1.4) + 1024;

/** The mailbox's drafts folder, made where the server has none. */
async function draftsFolder(client: ImapFlow, box: Box): Promise<FolderRow> {
  const [found] = await db
    .select()
    .from(mailFolder)
    .where(and(eq(mailFolder.mailboxId, box.id), eq(mailFolder.role, "drafts")));
  return found ?? makeFolder(client, box, "Drafts", "drafts");
}

/** A draft of the person's, by its id in the index: in a drafts folder, or `invalid`. */
async function ownDraft(userId: string, id: unknown) {
  const [found] =
    typeof id === "string" && id
      ? await db.select({ message: mailMessage, folder: mailFolder }).from(mailMessage).innerJoin(mailFolder, eq(mailFolder.id, mailMessage.folderId)).where(eq(mailMessage.id, id))
      : [];
  if (!found) return null;
  const box = await requireOwnMailbox(userId, found.message.mailboxId);
  if (found.folder.role !== "drafts") throw new RowMailError("invalid");
  return { box, folder: found.folder, message: { ...found.message, path: found.folder.path } as StoredMessage };
}

/**
 * What the composer last saved: the draft it names (when the index has it) and its Message-ID,
 * in `box` unless the draft is in another of the person's mailboxes (the sender was changed).
 */
async function earlierDraft(userId: string, box: Box, ref: MailDraftRef | null | undefined) {
  if (!ref || typeof ref !== "object") return null;
  const found = await ownDraft(userId, ref.id);
  const messageId = typeof ref.messageId === "string" && MESSAGE_ID.test(ref.messageId) ? ref.messageId : (found?.message.messageId ?? null);
  const keep = Array.isArray(ref.keep) ? ref.keep.filter((p): p is string => typeof p === "string" && /^\d+(\.\d+)*$/.test(p)).slice(0, 40) : [];
  if (!found && !messageId) return null;
  return { box: found?.box ?? box, message: found?.message ?? null, messageId, keep };
}
type Earlier = NonNullable<Awaited<ReturnType<typeof earlierDraft>>>;

/** The files a message keeps from its draft before, or (a first save, or a send without one) brings from what it forwards. */
async function carriedFiles(box: Box, input: MailDraftInput, earlier: Earlier | null): Promise<Attachment[]> {
  if (earlier?.message) {
    const message = earlier.message;
    return earlier.keep.length ? withImap(earlier.box, (client) => filesOf(client, message, earlier.keep)) : [];
  }
  if (!input.forward) return [];
  const forwarded = await storedMessage(box, input.forward);
  return withImap(box, (client) => filesOf(client, forwarded, "files"));
}

/** Everything a message brings: what it carries over, then the files added now. */
async function draftFiles(box: Box, input: MailDraftInput, files: File[], earlier: Earlier | null) {
  const carried = await carriedFiles(box, input, earlier);
  if (attachedBytes(carried) > MAX_COMPOSE_BYTES) throw new RowMailError("tooMany");
  return [...carried, ...(await addedFiles(files, attachedBytes(carried)))];
}

/**
 * Takes the copies of a draft out of its mailbox's drafts folder (the one the index names and any
 * with its Message-ID), but for the one just saved (`except`). Only the person's own drafts folder
 * is touched.
 */
async function removeCopies(earlier: Earlier, except: { mailboxId: string; uid: number } | null) {
  const [folder] = await db
    .select()
    .from(mailFolder)
    .where(and(eq(mailFolder.mailboxId, earlier.box.id), eq(mailFolder.role, "drafts")));
  if (!folder) return;
  await withImap(
    earlier.box,
    async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const uids = new Set<number>();
        if (earlier.message && earlier.message.folderId === folder.id) uids.add(earlier.message.uid);
        if (earlier.messageId) {
          const found = await client.search({ header: { "message-id": earlier.messageId } }, { uid: true });
          for (const uid of Array.isArray(found) ? found : []) uids.add(uid);
        }
        if (except?.mailboxId === earlier.box.id) uids.delete(except.uid);
        if (!uids.size) return;
        await client.messageDelete([...uids].join(","), { uid: true });
        await db.delete(mailMessage).where(and(eq(mailMessage.folderId, folder.id), inArray(mailMessage.uid, [...uids])));
      } finally {
        lock.release();
      }
      await recount(client, folder);
    },
    "background",
  );
}

/**
 * Saves what the composer holds as a draft in the mailbox's drafts folder (in place of the one it
 * saved before, `input.draft`), with the files it kept from that one and `files` added now.
 * Returns the new draft's id in the index, its Message-ID and its files.
 */
export async function saveDraft(userId: string, input: MailDraftInput, files: File[] = []): Promise<MailSavedDraft> {
  const box = await requireOwnMailbox(userId, input?.mailboxId);
  const w = await written(box, input, { toSend: false });
  const earlier = await earlierDraft(userId, box, input.draft);
  const attachments = await draftFiles(box, input, files, earlier);
  const quote = await quoteFor(box, input, earlier);
  return storeDraft(userId, box, withQuote(w, quote), [...attachments, ...(quote?.files ?? [])], earlier, quote);
}

/**
 * The earlier mail a message carries under what was written (quote.ts): the one its draft before
 * carries, else the message it answers or forwards under the header the composer wrote.
 */
async function quoteFor(box: Box, input: MailDraftInput, earlier: Earlier | null): Promise<Quote | null> {
  const asked = input.quote;
  if (!asked || typeof asked !== "object") return null;
  if (earlier?.message) {
    const draft = earlier.message;
    const kept = await withImap(earlier.box, (client) => keptQuote(client, draft));
    if (kept) return kept;
  }
  const header = Array.isArray(asked.header) ? asked.header.filter((line): line is string => typeof line === "string").slice(0, 12).map((line) => line.replace(/[\r\n]+/g, " ").slice(0, 500)) : null;
  const sourceId = input.forward ?? input.replyTo;
  if (!header?.length || !sourceId) return null;
  const source = await storedMessage(box, sourceId);
  return withImap(box, (client) => freshQuote(client, source, header, !!input.forward));
}

/**
 * Keeps a message that was to be sent as a draft again, with the files it was going with: sending
 * it was undone, or failed.
 */
export async function keepAsDraft(userId: string, input: MailDraftInput, attachments: Attachment[], quote: Quote | null): Promise<MailSavedDraft> {
  const box = await requireOwnMailbox(userId, input?.mailboxId);
  const w = await written(box, input, { toSend: false });
  return storeDraft(userId, box, withQuote(w, quote), attachments, await earlierDraft(userId, box, input.draft), quote);
}

/** Puts a draft in the drafts folder in place of `earlier`; its files come back but for the quote's images. */
async function storeDraft(userId: string, box: Box, w: Written, attachments: Attachment[], earlier: Earlier | null, quote: Quote | null): Promise<MailSavedDraft> {
  // The same Message-ID from the first save on (the draft is found by it); a new one for a draft
  // moved to another mailbox, which must not be taken for its copy there.
  const messageId = earlier?.messageId && earlier.box.id === box.id ? earlier.messageId : newMessageId(box);
  const raw = await buildMessage(userId, box, w, attachments, { messageId, draft: true });

  const saved = await withImap(
    box,
    async (client) => {
      let folder = await draftsFolder(client, box);
      // A folder never read is read first: reading it later would number its messages anew in the index.
      if (!folder.uidValidity) {
        await indexFolder(client, box, folder, 50);
        [folder] = await db.select().from(mailFolder).where(eq(mailFolder.id, folder.id));
      }
      const appended = await client.append(folder.path, raw, ["\\Draft", "\\Seen"]);
      const lock = await client.getMailboxLock(folder.path);
      try {
        let uid = appended && typeof appended.uid === "number" ? appended.uid : null;
        if (!uid) {
          // No UIDPLUS: the newest copy with its Message-ID is the one just put there.
          const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
          uid = Array.isArray(found) && found.length ? Math.max(...found) : null;
        }
        if (!uid) return { folder, uid: null, attachments: [] };
        await indexUids(client, box, folder, [uid]);
        const fetched = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        const parts = fetched && fetched.bodyStructure ? messageParts(fetched.bodyStructure).attachments : [];
        return { folder, uid, attachments: parts.filter((a) => !(a.inline && a.contentId && quote?.cids.has(a.contentId))).map(fileView) };
      } finally {
        lock.release();
      }
    },
    "background",
  );
  // Only once the new copy is there does the one before go: a failed save leaves it as it was.
  if (earlier) await removeCopies(earlier, saved.uid ? { mailboxId: box.id, uid: saved.uid } : null);
  await withImap(box, (client) => recount(client, saved.folder), "background").catch(() => {});
  const [row] = saved.uid
    ? await db
        .select({ id: mailMessage.id })
        .from(mailMessage)
        .where(and(eq(mailMessage.folderId, saved.folder.id), eq(mailMessage.uid, saved.uid)))
    : [];
  return { id: row?.id ?? null, messageId, attachments: saved.attachments };
}

/** Throws a draft away, from the mail server and the index. */
export async function discardDraft(userId: string, ref: MailDraftRef): Promise<null> {
  const found = await ownDraft(userId, ref?.id);
  if (!found && !(typeof ref?.messageId === "string" && MESSAGE_ID.test(ref.messageId))) return null;
  const box = found?.box ?? (typeof ref?.mailboxId === "string" ? await requireOwnMailbox(userId, ref.mailboxId) : null);
  if (!box) throw new RowMailError("invalid");
  const earlier = await earlierDraft(userId, box, { ...ref, keep: [] });
  if (earlier) await removeCopies(earlier, null);
  return null;
}

/** After sending what a draft held, its copies go (a failure only warns: the message went). */
export async function sentDraft(userId: string, box: Box, ref: MailDraftRef | null | undefined) {
  const earlier = await earlierDraft(userId, box, ref).catch(() => null);
  if (!earlier) return;
  await removeCopies(earlier, null).catch((error) => console.warn(`[mail-client] could not remove a sent draft: ${(error as Error)?.message}`));
}

/** What the composer needs before sending: the files and the quote the draft it saved last brings. */
export async function draftForSend(userId: string, box: Box, input: MailDraftInput, files: File[]) {
  const earlier = await earlierDraft(userId, box, input.draft);
  const attachments = await draftFiles(box, input, files, earlier);
  const quote = await quoteFor(box, input, earlier);
  return { attachments: [...attachments, ...(quote?.files ?? [])], quote };
}

const viewAddresses = (list: { address?: string; name?: string }[] | undefined): MailAddress[] =>
  (list ?? []).flatMap((a) => {
    const address = normalizeAddress(a.address);
    return address ? [{ address, name: a.name?.trim() || null }] : [];
  });

/**
 * A draft opened to write on: its recipients (Bcc too), subject, what it says as the editor reads
 * it, its files, and the message it answers when that is in the index.
 */
export async function openDraft(userId: string, id: string): Promise<MailDraftView> {
  const found = await ownDraft(userId, id);
  if (!found) throw new RowMailError("gone");
  const { box, message, folder } = found;
  const read = await withImap(box, async (client) => {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const fetched = await client.fetchOne(String(message.uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
      if (!fetched || !fetched.bodyStructure) return null;
      const parts = messageParts(fetched.bodyStructure);
      const wanted = [parts.text, parts.html].filter((p) => !!p).map((p) => ({ part: p!.part, limit: travelling(MAX_DRAFT_BYTES) }));
      const raw = await readParts(client, message.uid, wanted);
      const textOf = (ref: typeof parts.text) => {
        const bytes = ref && raw.get(ref.part);
        return bytes ? decodeText(bytes, ref.encoding, ref.charset) : null;
      };
      return { envelope: fetched.envelope ?? {}, parts, html: textOf(parts.html), text: textOf(parts.text) ?? "" };
    } finally {
      lock.release();
    }
  });
  if (!read) throw new RowMailError("gone");
  // The quote it carries is shown apart, not written on (quote.ts).
  const split = read.html ? await splitQuote(read.html) : null;
  const [answers] = message.inReplyTo
    ? await db
        .select({ id: mailMessage.id })
        .from(mailMessage)
        .where(and(eq(mailMessage.mailboxId, box.id), eq(mailMessage.messageId, message.inReplyTo), ne(mailMessage.folderId, folder.id)))
        .orderBy(desc(mailMessage.sentAt))
        .limit(1)
    : [];
  return {
    id: message.id,
    mailboxId: box.id,
    messageId: message.messageId,
    to: viewAddresses(read.envelope.to),
    cc: viewAddresses(read.envelope.cc),
    bcc: viewAddresses(read.envelope.bcc),
    subject: message.subject,
    html: await editableBody(split?.html ?? null, read.text),
    replyTo: answers?.id ?? null,
    attachments: read.parts.attachments.filter((a) => !(a.inline && a.contentId && split?.quote?.includes(`cid:${a.contentId}`))).map(fileView),
    quote: split?.quote ? (await cleanMailHtml(split.quote, { images: false, inline: new Map() })).html : null,
  };
}
