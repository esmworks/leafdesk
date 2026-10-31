import { and, count, eq, gte, inArray, lte, min, sql } from "drizzle-orm";
import type { FetchMessageObject, FetchQueryObject, ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "@/db";
import { mailFolder, mailMessage, type mailbox } from "@/db/schema";
import { bareMessageId, normalizeAddress, parseHeaderBlock, parseMessageIds } from "@/lib/mail";
import { MAIL_BACKFILL_DAYS, MAIL_BACKFILL_LIMIT, previewText, subjectKey, type MailAddress } from "@/lib/mail-client";
import { discoverFolders, type FolderRow } from "./folders";
import { hasFiles, messageParts } from "./structure";
import { threadFor } from "./threads";

/**
 * Keeps the Mail tab's index of a mailbox: the headers of each folder's messages, their flags,
 * and which are gone. New mail is read first; then each folder back in time, MAIL_BACKFILL_DAYS
 * and MAIL_BACKFILL_LIMIT at most, a little each pass. Only the start of each message is read,
 * for its first line; bodies are read when it is opened (read.ts).
 */

type Box = typeof mailbox.$inferSelect;

/** Messages read into the index in one pass over a mailbox, all folders together. */
const PASS_BUDGET = 400;
/** Bytes of a message read for its first line. */
const PREVIEW_BYTES = 16 * 1024;
/** The owner's own folders are looked at this often; the inbox and the other roles every pass. */
const OWN_FOLDER_EVERY_MS = 10 * 60_000;
/** The folder list is read again this often (servers that list counts with it: every pass). */
const FOLDER_LIST_EVERY_MS = 10 * 60_000;
/** Without CONDSTORE, flags are read again for this many of the newest messages each pass. */
const RECENT_FLAGS = 300;

const FETCH: FetchQueryObject = { uid: true, envelope: true, flags: true, bodyStructure: true, headers: ["references"], threadId: true, size: true, internalDate: true, source: { maxLength: PREVIEW_BYTES } };

const addresses = (list: { address?: string; name?: string }[] | undefined): MailAddress[] =>
  (list ?? []).flatMap((a) => {
    const address = normalizeAddress(a.address);
    return address ? [{ address, name: a.name?.trim() || null }] : [];
  });

async function preview(source: Buffer | undefined) {
  if (!source?.length) return "";
  try {
    const parsed = await simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
    return previewText(parsed.text ?? "");
  } catch {
    return "";
  }
}

function dateOf(message: FetchMessageObject) {
  for (const value of [message.envelope?.date, message.internalDate]) {
    const date = value ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/** Writes fetched messages into the index, each into its thread. */
async function store(box: Box, folder: FolderRow, messages: FetchMessageObject[]) {
  for (const message of messages) {
    const envelope = message.envelope ?? {};
    const fields = parseHeaderBlock(message.headers);
    const rawId = envelope.messageId ? bareMessageId(envelope.messageId) : "";
    const messageId = rawId && rawId.length <= 998 ? rawId : null;
    const inReplyTo = envelope.inReplyTo ? bareMessageId(envelope.inReplyTo).slice(0, 998) || null : null;
    const references = parseMessageIds(fields.get("references"))
      .map(bareMessageId)
      .filter((id) => id && id.length <= 998)
      .slice(-50);
    const subject = (envelope.subject ?? "").slice(0, 2000);
    const sentAt = dateOf(message);
    const threadId = await threadFor({
      mailboxId: box.id,
      folderId: folder.id,
      uid: message.uid,
      messageId,
      inReplyTo,
      references,
      subject,
      sentAt,
      serverThreadId: message.threadId ?? null,
    });
    const from = addresses(envelope.from)[0];
    const flags = message.flags ?? new Set<string>();
    await db
      .insert(mailMessage)
      .values({
        mailboxId: box.id,
        folderId: folder.id,
        uid: message.uid,
        messageId,
        threadId,
        inReplyTo,
        references,
        fromAddress: from?.address ?? "",
        fromName: from?.name ?? null,
        to: addresses(envelope.to).slice(0, 100),
        cc: addresses(envelope.cc).slice(0, 100),
        subject,
        subjectKey: subjectKey(subject),
        preview: await preview(message.source),
        sentAt,
        seen: flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        answered: flags.has("\\Answered"),
        draft: flags.has("\\Draft"),
        hasAttachments: hasFiles(messageParts(message.bodyStructure)),
        size: message.size ?? 0,
      })
      .onConflictDoNothing();
  }
}

/** A search's numbers; a search the server didn't answer stops the pass, which must not read it as "none". */
function found(result: number[] | false | undefined): number[] {
  if (!Array.isArray(result)) throw new Error("The mail server did not answer a search");
  return result;
}

async function fetchUids(client: ImapFlow, uids: number[]) {
  const out: FetchMessageObject[] = [];
  if (!uids.length) return out;
  for await (const message of client.fetch(uids.join(","), FETCH, { uid: true })) out.push(message);
  return out;
}

/** Reads messages just put in a folder (a saved draft) into the index; the caller holds the folder open. */
export async function indexUids(client: ImapFlow, box: Box, folder: FolderRow, uids: number[]) {
  await store(box, folder, await fetchUids(client, uids));
}

type FlagState = { uid: number; flags: Set<string> };

async function applyFlags(folder: FolderRow, changed: FlagState[]) {
  for (const { uid, flags } of changed) {
    await db
      .update(mailMessage)
      .set({ seen: flags.has("\\Seen"), flagged: flags.has("\\Flagged"), answered: flags.has("\\Answered"), draft: flags.has("\\Draft") })
      .where(and(eq(mailMessage.folderId, folder.id), eq(mailMessage.uid, uid)));
  }
}

/**
 * One pass over a folder: new mail, flag changes, messages gone, then reading back in time as far
 * as `budget` allows. Returns how many messages it read.
 */
export async function indexFolder(client: ImapFlow, box: Box, folder: FolderRow, budget: number): Promise<number> {
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  let read = 0;
  try {
    const opened = client.mailbox;
    if (!opened) return 0;
    const uidValidity = String(opened.uidValidity);
    const newest = Math.max(0, opened.uidNext - 1);
    let { lastUid, oldestUid, modseq } = folder;
    if (uidValidity !== folder.uidValidity) {
      // Numbered anew (or never read): what was kept means nothing now. Start at the newest and read back.
      await db.delete(mailMessage).where(eq(mailMessage.folderId, folder.id));
      lastUid = newest;
      oldestUid = newest + 1;
      modseq = null;
    }

    // New mail, oldest first, so a pass cut short goes on from where it stopped.
    if (newest > lastUid && budget > 0) {
      const fresh = found(await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })).filter((uid) => uid > lastUid).sort((a, b) => a - b);
      const take = fresh.slice(0, budget);
      await store(box, folder, await fetchUids(client, take));
      read += take.length;
      lastUid = take.length < fresh.length ? take[take.length - 1] : Math.max(lastUid, newest);
    }

    const [range] = await db.select({ low: min(mailMessage.uid), kept: count() }).from(mailMessage).where(eq(mailMessage.folderId, folder.id));
    const low = range?.low ?? null;
    if (low !== null) {
      // Flags changed elsewhere (read on the phone, starred in another program).
      const highest = opened.highestModseq;
      const condstore = !!highest && !opened.noModseq && client.enabled.has("CONDSTORE");
      if (condstore && highest && modseq) {
        if (highest > BigInt(modseq)) {
          const changed: FlagState[] = [];
          for await (const m of client.fetch(`${low}:${lastUid}`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(modseq) })) {
            changed.push({ uid: m.uid, flags: m.flags ?? new Set() });
          }
          await applyFlags(folder, changed);
        }
      } else {
        const recent = await db
          .select({ uid: mailMessage.uid })
          .from(mailMessage)
          .where(eq(mailMessage.folderId, folder.id))
          .orderBy(sql`${mailMessage.uid} desc`)
          .limit(RECENT_FLAGS);
        if (recent.length) {
          const changed: FlagState[] = [];
          for await (const m of client.fetch(`${recent[recent.length - 1].uid}:${lastUid}`, { uid: true, flags: true }, { uid: true })) {
            changed.push({ uid: m.uid, flags: m.flags ?? new Set() });
          }
          await applyFlags(folder, changed);
        }
      }
      modseq = condstore && highest ? String(highest) : null;

      // Messages moved or deleted elsewhere.
      const there = new Set(found(await client.search({ uid: `${low}:${Math.max(low, lastUid)}` }, { uid: true })));
      const ours = await db
        .select({ uid: mailMessage.uid })
        .from(mailMessage)
        .where(and(eq(mailMessage.folderId, folder.id), gte(mailMessage.uid, low), lte(mailMessage.uid, lastUid)));
      const gone = ours.map((r) => r.uid).filter((uid) => !there.has(uid));
      for (let i = 0; i < gone.length; i += 500) {
        await db.delete(mailMessage).where(and(eq(mailMessage.folderId, folder.id), inArray(mailMessage.uid, gone.slice(i, i + 500))));
      }
    } else if (opened.highestModseq && !opened.noModseq && client.enabled.has("CONDSTORE")) {
      modseq = String(opened.highestModseq);
    }

    // Back in time, newest first, until the limits.
    const limit = folder.role ? MAIL_BACKFILL_LIMIT.role : MAIL_BACKFILL_LIMIT.own;
    const want = Math.min(budget - read, limit - (range?.kept ?? 0));
    if (oldestUid > 1 && want > 0) {
      const since = new Date(Date.now() - MAIL_BACKFILL_DAYS * 86_400_000);
      const older = found(await client.search({ uid: `1:${oldestUid - 1}`, since }, { uid: true })).filter((uid) => uid < oldestUid).sort((a, b) => b - a);
      const take = older.slice(0, want);
      await store(box, folder, await fetchUids(client, take));
      read += take.length;
      oldestUid = take.length < older.length ? take[take.length - 1] : 1;
    } else if (want <= 0 && (range?.kept ?? 0) >= limit) {
      oldestUid = Math.min(oldestUid, 1);
    }

    // The sweep and the Mail tab's own connection may read a folder at once: neither takes back what the other got to.
    const sameNumbering = uidValidity === folder.uidValidity;
    await db
      .update(mailFolder)
      .set({
        uidValidity,
        lastUid: sameNumbering ? sql`greatest(${mailFolder.lastUid}, ${lastUid})` : lastUid,
        oldestUid: sameNumbering ? sql`least(${mailFolder.oldestUid}, ${oldestUid})` : oldestUid,
        modseq,
        total: opened.exists,
        syncedAt: new Date(),
        ...(client.capabilities.has("LIST-STATUS") ? {} : { unseen: found(await client.search({ seen: false }, { uid: true })).length }),
      })
      .where(eq(mailFolder.id, folder.id));
    return read;
  } finally {
    lock.release();
  }
}

/** When each mailbox's folder list was last read in this process (a restart reads it again). */
const g = globalThis as typeof globalThis & { __leafdeskMailListed?: Map<string, number> };
const listed = (g.__leafdeskMailListed ??= new Map());

/** Whether the mailbox's owner has opened Mail, so it is indexed. */
export async function isIndexed(mailboxId: string) {
  const [one] = await db.select({ id: mailFolder.id }).from(mailFolder).where(eq(mailFolder.mailboxId, mailboxId)).limit(1);
  return !!one;
}

/**
 * One pass over an indexed mailbox (row-mail/sync.ts runs it on the same connection every minute):
 * the folder list now and then, the inbox and the other roles every time, the owner's own folders
 * every OWN_FOLDER_EVERY_MS, all within PASS_BUDGET.
 */
export async function indexMailbox(client: ImapFlow, box: Box, options: { force?: boolean } = {}) {
  let folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  const listedAt = listed.get(box.id) ?? 0;
  if (options.force || !folders.length || client.capabilities.has("LIST-STATUS") || Date.now() - listedAt > FOLDER_LIST_EVERY_MS) {
    folders = await discoverFolders(client, box);
    listed.set(box.id, Date.now());
  }
  let budget = PASS_BUDGET;
  const now = Date.now();
  for (const folder of folders) {
    if (budget <= 0) break;
    const due = options.force || folder.role || !folder.syncedAt || now - folder.syncedAt.getTime() > OWN_FOLDER_EVERY_MS;
    if (!due) continue;
    try {
      budget -= await indexFolder(client, box, folder, budget);
    } catch (error) {
      // A folder that can't be opened (deleted a moment ago, no rights) doesn't stop the others.
      console.warn(`[mail-client] could not read folder of mailbox ${box.id}: ${(error as Error)?.message}`);
    }
  }
}
