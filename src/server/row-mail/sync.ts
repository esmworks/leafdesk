import { eq, sql } from "drizzle-orm";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "@/db";
import { mailbox } from "@/db/schema";
import { bareMessageId, dmarcFailed, isAutomated, MAX_MAIL_BYTES, normalizeAddress, parseHeaderBlock, parseMessageIds, type FolderState, type MailboxFolders } from "@/lib/mail";
import { findMembership, isGuest } from "@/server/access";
import { startSweep } from "@/server/sweep";
import { workspaceSettings } from "@/server/workspaces";
import { indexMailbox, isIndexed } from "@/server/mail-client/indexer";
import { connectError, openImap } from "./connect";
import { withMailCredentials } from "./credentials";
import { matchAddresses, matchThread, type RowMatch } from "./match";
import { knownMessage, storeIncoming } from "./store";

/**
 * Reads members' mailboxes every minute: the inbox and the sent folder, from where reading last
 * stopped. Only headers are read at first; a message is fetched whole only when it belongs on a
 * row (its thread is on one, or the other party's address is a row's), so mail that has nothing
 * to do with the workspace never leaves the mail server.
 */

/** Messages read from a folder in one go; the rest wait for the next sweep. */
const BATCH = 200;
const HEADERS = ["references", "auto-submitted", "precedence", "authentication-results", "x-autoreply", "x-autorespond"];

type Box = typeof mailbox.$inferSelect;

export { parseHeaderBlock };

const list = (addresses: { address?: string }[] | undefined) =>
  (addresses ?? []).map((a) => normalizeAddress(a.address)).filter((a): a is string => !!a);

/** The row a message belongs on: its thread's, else the other party's (whoever wrote it first, then the rest). */
async function rowFor(box: Box, kind: "inbox" | "sent", message: FetchMessageObject, threadIds: string[]): Promise<RowMatch | null> {
  const thread = await matchThread(box.workspaceId, box.userId, threadIds);
  if (thread) return thread;
  const own = box.address;
  const envelope = message.envelope ?? {};
  const others = (addresses: string[]) => addresses.filter((a) => a !== own);
  const first = kind === "inbox" ? others(list(envelope.from)) : others(list(envelope.to));
  const rest = kind === "inbox" ? others([...list(envelope.to), ...list(envelope.cc)]) : others(list(envelope.cc));
  return (await matchAddresses(box.workspaceId, box.userId, first)) ?? (await matchAddresses(box.workspaceId, box.userId, rest));
}

/** Reads what came into one folder since `state`; returns where reading stopped. */
async function readFolder(client: ImapFlow, box: Box, kind: "inbox" | "sent", state: FolderState): Promise<FolderState> {
  const lock = await client.getMailboxLock(state.path, { readOnly: true });
  try {
    const opened = client.mailbox;
    if (!opened) return state;
    const uidValidity = String(opened.uidValidity);
    // The server numbered the folder anew: start from what is there now rather than read it all again.
    if (uidValidity !== state.uidValidity) return { path: state.path, uidValidity, lastUid: Math.max(0, opened.uidNext - 1) };
    if (opened.uidNext - 1 <= state.lastUid) return state;
    // `n:*` always names the newest message, even when it is older than n: hence the filter.
    const found = await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true });
    const uids = (found || [])
      .filter((uid) => uid > state.lastUid)
      .sort((a, b) => a - b)
      .slice(0, BATCH);
    if (!uids.length) return state;
    const headers: FetchMessageObject[] = [];
    for await (const message of client.fetch(uids.join(","), { uid: true, envelope: true, size: true, headers: HEADERS }, { uid: true })) {
      headers.push(message);
    }
    headers.sort((a, b) => a.uid - b.uid);
    let lastUid = state.lastUid;
    for (const message of headers) {
      await readMessage(client, box, kind, message);
      lastUid = message.uid;
    }
    return { ...state, lastUid: Math.max(lastUid, uids[uids.length - 1]) };
  } finally {
    lock.release();
  }
}

async function readMessage(client: ImapFlow, box: Box, kind: "inbox" | "sent", message: FetchMessageObject) {
  const envelope = message.envelope ?? {};
  if (!envelope.messageId) return;
  const messageId = bareMessageId(envelope.messageId);
  if (!messageId || messageId.length > 998 || (await knownMessage(box.workspaceId, messageId))) return;
  const fields = parseHeaderBlock(message.headers);
  const inReplyTo = envelope.inReplyTo ? bareMessageId(envelope.inReplyTo) : null;
  const references = parseMessageIds(fields.get("references")).map(bareMessageId);
  const threadIds = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...references])];
  const match = await rowFor(box, kind, message, threadIds);
  if (!match || (message.size ?? 0) > MAX_MAIL_BYTES) return;
  const whole = await client.fetchOne(String(message.uid), { source: true }, { uid: true });
  if (!whole || !whole.source) return;
  const parsed = await simpleParser(whole.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
  const from = envelope.from?.[0];
  await storeIncoming(match, {
    workspaceId: box.workspaceId,
    mailboxId: box.id,
    ownerId: box.userId,
    direction: kind === "inbox" ? "in" : "out",
    messageId,
    inReplyTo,
    references,
    from: { address: normalizeAddress(from?.address) ?? from?.address ?? "", name: from?.name?.trim() || null },
    to: list(envelope.to),
    cc: list(envelope.cc),
    subject: envelope.subject ?? "",
    sentAt: envelope.date ? new Date(envelope.date) : new Date(),
    unverifiedSender: kind === "inbox" && dmarcFailed(fields.get("authentication-results")),
    automated: isAutomated({ autoSubmitted: fields.get("auto-submitted")?.[0], precedence: fields.get("precedence")?.[0] }),
    autoReply: {
      autoSubmitted: fields.get("auto-submitted")?.[0] ?? null,
      precedence: fields.get("precedence")?.[0] ?? null,
      xAutoreply: fields.get("x-autoreply")?.[0] ?? null,
      xAutorespond: fields.get("x-autorespond")?.[0] ?? null,
    },
    parsed,
  });
}

/** Reads one mailbox; how it went is kept on it for its owner's settings. */
export async function syncMailbox(box: Box) {
  const membership = await findMembership(box.userId, box.workspaceId);
  // Someone who left, or is only a guest now, has no mailbox here any more.
  if (!membership || isGuest(membership.role)) {
    await db.delete(mailbox).where(eq(mailbox.id, box.id));
    return;
  }
  if (!(await workspaceSettings(box.workspaceId)).email) return;
  const folders: MailboxFolders = { ...box.folders };
  try {
    const client = await withMailCredentials(box, openImap);
    try {
      for (const kind of ["inbox", "sent"] as const) {
        const state = folders[kind];
        if (state) folders[kind] = await readFolder(client, box, kind, state);
      }
      // The Mail tab's index, for owners who opened it, on the same connection. Its failures are
      // its own: they don't mark the mailbox as failing for mail on rows.
      if (await isIndexed(box.id)) {
        await indexMailbox(client, box).catch((error) => console.warn(`[mail-client] could not index mailbox ${box.id}: ${(error as Error)?.message}`));
      }
    } finally {
      await client.logout().catch(() => {});
    }
    await db.update(mailbox).set({ folders, status: "ok", statusError: null, syncedAt: new Date() }).where(eq(mailbox.id, box.id));
  } catch (error) {
    const failed = connectError(error);
    console.warn(`[row-mail] could not read mailbox ${box.id}: ${failed.code}`);
    await db.update(mailbox).set({ folders, status: "error", statusError: failed.code, syncedAt: new Date() }).where(eq(mailbox.id, box.id));
  }
}

/**
 * Mailboxes due a read, claimed so two servers don't read the same one: every minute, every
 * quarter of an hour while one fails (a wrong password shouldn't be tried sixty times an hour).
 */
async function claim(): Promise<Box[]> {
  const taken = await db.execute<{ id: string }>(sql`
    update ${mailbox} set synced_at = now()
    where id in (
      select id from ${mailbox}
      where synced_at is null
        or synced_at < now() - case when status = 'error' then interval '15 minutes' else interval '50 seconds' end
      order by synced_at nulls first
      limit 20
      for update skip locked
    )
    returning id
  `);
  const ids = [...taken].map((r) => r.id);
  if (!ids.length) return [];
  return db.select().from(mailbox).where(sql`${mailbox.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
}

export async function syncDue() {
  for (const box of await claim()) {
    try {
      await syncMailbox(box);
    } catch (error) {
      console.error("[row-mail] sync failed", error);
    }
  }
}

let stop: (() => void) | null = null;

/** Reads mailboxes every minute (server.ts). */
export function startRowMailSync() {
  stop ??= startSweep(60_000, syncDue, "[row-mail] sync sweep failed");
  return stop;
}
