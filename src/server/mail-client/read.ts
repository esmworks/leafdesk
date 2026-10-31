import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailFolder, mailMessage, page } from "@/db/schema";
import { dmarcFailed, normalizeAddress, parseHeaderBlock } from "@/lib/mail";
import { imagesShown, type MailImagesFrom } from "@/lib/mail-images";
import { unsubscribeOffer, unsubscribeTargets } from "@/lib/mail-unsubscribe";
import {
  ALL_INBOXES,
  MAIL_PAGE,
  parseMailQuery,
  type MailAddress,
  type MailAttachmentView,
  type MailBody,
  type MailboxTabView,
  type MailFolderView,
  type MailMessageView,
  type MailThreadItem,
  type MailThreadPage,
  type MailThreadView,
} from "@/lib/mail-client";
import { RowMailError } from "@/server/row-mail/settings";
import { mailDatabases } from "@/server/row-mail/match";
import { requireMailIn, requireOwnMailbox } from "./access";
import { discoverFolders, orderFolders } from "./folders";
import { cleanMailHtml, htmlText } from "./html";
import { indexFolder, indexMailbox, indexUids, isIndexed } from "./indexer";
import { bodyHeld, heldBody } from "./body-cache";
import { imagesFor } from "./images";
import { ConnectionLost, SHORT_MS, warmImap, withImap, type ImapLane } from "./pool";
import { decodeText, decodeTransfer, fileView, messageParts, readPart, readParts, type PartRef } from "./structure";

/**
 * What the Mail tab reads: the person's mailboxes and folders, a folder's threads from the index,
 * a thread's messages, and a message's body and files from the mail server.
 */

type Box = typeof mailbox.$inferSelect;
type MessageRow = typeof mailMessage.$inferSelect;
type FolderRow = typeof mailFolder.$inferSelect;

/** Bytes of a message's text or HTML read at most. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Images a message carries shown inline: each and all together. */
const MAX_INLINE_IMAGE = 1024 * 1024;
const MAX_INLINE_TOTAL = 5 * 1024 * 1024;
/**
 * Reading a body (sign-in included) takes longer than this only on a connection that stopped
 * answering: it is closed then and the body read once more on a new one (readBody).
 */
const BODY_MS = 30_000;
/** A file downloaded from a message, at most. */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
/** How often opening a folder asks the mail server for what is new, at most. */
const REFRESH_EVERY_MS = 15_000;

function folderView(f: FolderRow): MailFolderView {
  const depth = f.role || !f.delimiter ? 0 : Math.min(3, f.path.split(f.delimiter).length - 1);
  return { id: f.id, path: f.path, name: f.name, role: f.role, unseen: f.unseen, total: f.total, depth };
}

function tabView(box: Box, folders: FolderRow[] | null): MailboxTabView {
  return {
    id: box.id,
    address: box.address,
    displayName: box.displayName,
    isDefault: box.isDefault,
    status: box.status,
    statusError: box.statusError,
    folders: folders ? orderFolders(folders).map(folderView) : null,
    syncedAt: box.syncedAt?.toISOString() ?? null,
    signature: box.signature,
  };
}

const firstReads = ((globalThis as typeof globalThis & { __leafdeskMailFirstReads?: Map<string, Promise<void>> }).__leafdeskMailFirstReads ??= new Map<string, Promise<void>>());

/** The person's mailboxes in the workspace, their default first, with their folders once read. */
export async function listMailboxes(userId: string, workspaceId: string): Promise<MailboxTabView[]> {
  await requireMailIn(userId, workspaceId);
  const boxes = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt));
  if (!boxes.length) return [];
  const folders = await db
    .select()
    .from(mailFolder)
    .where(
      inArray(
        mailFolder.mailboxId,
        boxes.map((b) => b.id),
      ),
    );
  return boxes.map((box) => {
    const own = folders.filter((f) => f.mailboxId === box.id);
    // A mailbox not read yet is read now, in the background: the sidebar then shows its unread
    // mail and opening it is quick. A failing one waits for the minute's read to reach it again.
    if (!own.length && box.status !== "error") void firstRead(box, "background").catch((error) => console.warn(`[mail-client] could not read mailbox ${box.id}: ${(error as Error)?.message}`));
    // Until that read ends its folders are there but its inbox isn't yet: it shows as not read.
    return tabView(box, own.length && !firstReads.has(box.id) ? own : null);
  });
}

/**
 * Reads a mailbox's folders and the newest of its inbox, once: after it the minute sweep
 * (row-mail/sync.ts) keeps it and reads further back. A read already under way is waited for.
 */
function firstRead(box: Box, lane: ImapLane) {
  const running = firstReads.get(box.id);
  if (running) return running;
  const done = (async () => {
    if (await isIndexed(box.id)) return;
    await withImap(
      box,
      async (client) => {
        const folders = await discoverFolders(client, box);
        const inbox = folders.find((f) => f.role === "inbox");
        if (inbox) await indexFolder(client, box, inbox, MAIL_PAGE);
      },
      lane,
    );
  })().finally(() => firstReads.delete(box.id));
  firstReads.set(box.id, done);
  return done;
}

/** Opens a mailbox in the Mail tab: the first time, after its first read (firstRead). */
export async function openMailbox(userId: string, mailboxId: string): Promise<MailboxTabView> {
  const box = await requireOwnMailbox(userId, mailboxId);
  await firstRead(box, "open");
  const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  return tabView(box, folders);
}

const refreshed = ((globalThis as typeof globalThis & { __leafdeskMailRefreshed?: Map<string, number> }).__leafdeskMailRefreshed ??= new Map());

/** The folder was just read from the server (watch.ts, as its inbox changed): a tab asking now isn't asked to wait for it again. */
export const folderRefreshed = (folderId: string) => refreshed.set(folderId, Date.now());

/** Asks the mail server what is new in a folder, as the person looks at it (not more often than REFRESH_EVERY_MS). */
export async function refreshFolder(userId: string, mailboxId: string, folderId: string): Promise<MailFolderView[]> {
  const box = await requireOwnMailbox(userId, mailboxId);
  const [folder] = await db
    .select()
    .from(mailFolder)
    .where(and(eq(mailFolder.id, folderId), eq(mailFolder.mailboxId, box.id)));
  if (!folder) throw new RowMailError("gone");
  // The page is open: the first click shouldn't wait to sign in.
  warmImap(box, folder.path);
  if (Date.now() - (refreshed.get(folder.id) ?? 0) > REFRESH_EVERY_MS) {
    refreshed.set(folder.id, Date.now());
    await withImap(box, (client) => indexFolder(client, box, folder, MAIL_PAGE * 2), "background");
  }
  const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  return orderFolders(folders).map(folderView);
}

/** Reads everything again now (the Refresh button): the folder list and every folder. */
export async function refreshMailbox(userId: string, mailboxId: string): Promise<MailboxTabView> {
  const box = await requireOwnMailbox(userId, mailboxId);
  await withImap(box, (client) => indexMailbox(client, box, { force: true }), "background");
  const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  return tabView(box, folders);
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The SQL a search box's words and filters become, on mail_message; messages in `found` match the words too (their text did, on the mail server). */
function searchCondition(input: string, found: string[] = []): SQL | undefined {
  const query = parseMailQuery(input);
  const parts: SQL[] = [];
  if (query.from) parts.push(sql`(${mailMessage.fromAddress} ilike ${like(query.from)} or ${mailMessage.fromName} ilike ${like(query.from)})`);
  if (query.to) parts.push(sql`(${mailMessage.to}::text ilike ${like(query.to)} or ${mailMessage.cc}::text ilike ${like(query.to)})`);
  if (query.subject) parts.push(sql`${mailMessage.subject} ilike ${like(query.subject)}`);
  if (query.unread !== undefined) parts.push(eq(mailMessage.seen, !query.unread));
  if (query.starred) parts.push(eq(mailMessage.flagged, true));
  if (query.attachment) parts.push(eq(mailMessage.hasAttachments, true));
  if (query.after) parts.push(sql`${mailMessage.sentAt} >= ${query.after}::date`);
  if (query.before) parts.push(sql`${mailMessage.sentAt} < ${query.before}::date`);
  const words = query.words.slice(0, 10).map((word) => {
    const w = like(word);
    return sql`(${mailMessage.subject} ilike ${w} or ${mailMessage.preview} ilike ${w} or ${mailMessage.fromAddress} ilike ${w} or ${mailMessage.fromName} ilike ${w} or ${mailMessage.to}::text ilike ${w})`;
  });
  if (words.length) parts.push(found.length ? or(and(...words), inArray(mailMessage.id, found))! : and(...words)!);
  return parts.length ? and(...parts) : undefined;
}

/** Folders searched on the mail server for a search's words, at most, roles first. */
const BODY_FOLDERS = 6;
/** Messages found there per folder, the newest, and how many of them not yet in the index are read into it. */
const BODY_HITS = 100;
const BODY_READ = 30;
const BODY_SEARCH_MS = 8_000;
/** What a search found on the servers is kept this long, so its next pages list the same. */
const BODY_KEPT_MS = 3 * 60_000;
const ROLE_RANK = ["inbox", "sent", "archive", "drafts"];
const bodySearches = ((globalThis as typeof globalThis & { __leafdeskMailBodySearches?: Map<string, { at: number; ids: string[] }> }).__leafdeskMailBodySearches ??= new Map());

/**
 * The messages whose text has a search's words, as the mail servers find them (SEARCH BODY): the
 * index keeps only each message's first lines. Messages found that the index doesn't have yet
 * (older than it reads back) are read into it, a few per folder. A server slow to answer or
 * refusing leaves the index's own matches; asked again with `cursor`, only what was found is used.
 */
async function bodyMatches(key: string, searched: { box: Box; folders: FolderRow[] }[], words: string[], again: boolean): Promise<string[]> {
  const now = Date.now();
  for (const [k, kept] of bodySearches) if (now - kept.at >= BODY_KEPT_MS) bodySearches.delete(k);
  const kept = bodySearches.get(key);
  if (kept || again) return kept?.ids ?? [];
  const rank = (f: FolderRow) => (f.role && ROLE_RANK.includes(f.role) ? ROLE_RANK.indexOf(f.role) : ROLE_RANK.length);
  const ids = await Promise.all(
    searched.map(({ box, folders }) =>
      withImap(
        box,
        async (client) => {
          const out: string[] = [];
          for (const folder of [...folders].sort((a, b) => rank(a) - rank(b)).slice(0, BODY_FOLDERS)) {
            const lock = await client.getMailboxLock(folder.path, { readOnly: true });
            try {
              let uids: number[] = [];
              for (const [i, word] of words.entries()) {
                const hits = await client.search({ body: word }, { uid: true });
                const set = new Set(Array.isArray(hits) ? hits : []);
                uids = i === 0 ? [...set] : uids.filter((uid) => set.has(uid));
                if (!uids.length) break;
              }
              const newest = uids.sort((a, b) => b - a).slice(0, BODY_HITS);
              if (!newest.length) continue;
              const indexed = () =>
                db
                  .select({ id: mailMessage.id, uid: mailMessage.uid })
                  .from(mailMessage)
                  .where(and(eq(mailMessage.folderId, folder.id), inArray(mailMessage.uid, newest)));
              let known = await indexed();
              const missing = newest.filter((uid) => !known.some((m) => m.uid === uid)).slice(0, BODY_READ);
              if (missing.length) {
                await indexUids(client, box, folder, missing);
                known = await indexed();
              }
              out.push(...known.map((m) => m.id));
            } finally {
              lock.release();
            }
          }
          return out;
        },
        "open",
        { within: BODY_SEARCH_MS },
      ).catch((error) => {
        console.warn(`[mail-client] searching mailbox ${box.id} on its server:`, (error as Error)?.message ?? error);
        return [] as string[];
      }),
    ),
  );
  const flat = ids.flat();
  bodySearches.set(key, { at: Date.now(), ids: flat });
  return flat;
}

type RowChip = NonNullable<MailThreadItem["row"]>;

/**
 * The rows of the workspace's mail databases these addresses are, for the chips beside threads:
 * as row-mail/match.ts matches mail to rows (the first database where exactly one row the person
 * sees holds the address), in one query per database.
 */
async function rowsForAddresses(workspaceId: string, userId: string, addresses: string[]): Promise<Map<string, RowChip>> {
  const out = new Map<string, RowChip>();
  let wanted = [...new Set(addresses.map(normalizeAddress).filter((a): a is string => !!a))];
  if (!wanted.length) return out;
  for (const { databaseId, propertyIds } of await mailDatabases(workspaceId)) {
    if (!wanted.length) break;
    const value = (id: string) => sql`lower(regexp_replace(trim(coalesce(${page.properties} ->> ${id}, '')), '^mailto:', '', 'i'))`;
    const list = sql.join(
      wanted.map((a) => sql`${a}`),
      sql`, `,
    );
    const rows = await db
      .select({
        id: page.id,
        title: page.title,
        icon: page.icon,
        values: sql<string[]>`array[${sql.join(propertyIds.map(value), sql`, `)}]`,
      })
      .from(page)
      .where(
        and(
          eq(page.parentId, databaseId),
          eq(page.workspaceId, workspaceId),
          isNull(page.archivedAt),
          eq(page.inTemplate, false),
          eq(page.isTemplate, false),
          sql`(${sql.join(
            propertyIds.map((id) => sql`${value(id)} in (${list})`),
            sql` or `,
          )})`,
          sql`page_access_level(${userId}, ${page.id}) > 0`,
        ),
      )
      .limit(500);
    const byAddress = new Map<string, typeof rows>();
    for (const row of rows) {
      for (const address of new Set(row.values)) {
        if (wanted.includes(address)) byAddress.set(address, [...(byAddress.get(address) ?? []), row]);
      }
    }
    for (const [address, matched] of byAddress) {
      if (matched.length !== 1) continue;
      out.set(address, { rowId: matched[0].id, databaseId, title: matched[0].title, icon: matched[0].icon });
    }
    // An address matched here, once or twice, is settled: later databases don't get it.
    wanted = wanted.filter((a) => !byAddress.has(a));
  }
  return out;
}

/** The other party of a message: who wrote it, or, for what the owner wrote, whom it went to. */
function otherParty(box: Box, m: Pick<MessageRow, "fromAddress" | "to" | "cc">) {
  if (m.fromAddress && m.fromAddress !== box.address) return m.fromAddress;
  return [...m.to, ...m.cc].find((a) => a.address !== box.address)?.address ?? null;
}

async function folderOf(box: Box, folderId: string) {
  const [folder] = typeof folderId === "string" ? await db.select().from(mailFolder).where(and(eq(mailFolder.id, folderId), eq(mailFolder.mailboxId, box.id))) : [];
  if (!folder) throw new RowMailError("gone");
  return folder;
}

/** Folders whose messages count in a thread opened from `from`: not the trash or junk, unless it was opened there. */
async function threadFolders(box: Box, from: FolderRow | null) {
  const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  const hidden = from?.role === "trash" || from?.role === "junk" ? [] : ["trash", "junk"];
  return folders.filter((f) => !f.role || !hidden.includes(f.role));
}

/**
 * A folder's threads, newest first, MAIL_PAGE at a time (`cursor` is the last page's `next`). With a
 * search, all folders but the trash and junk are searched, as kept in the index: senders, recipients,
 * subjects and first lines. The mailbox ALL_INBOXES lists the inboxes of all the person's mailboxes
 * in `workspaceId` as one (its search, all their folders but the trash and junk).
 */
export async function listThreads(
  userId: string,
  input: { mailboxId: string; folderId: string; workspaceId?: string; search?: string; cursor?: string | null },
): Promise<MailThreadPage> {
  const search = typeof input.search === "string" ? input.search.trim().slice(0, 500) : "";
  const cursor = typeof input.cursor === "string" ? input.cursor : null;
  if (input.mailboxId === ALL_INBOXES) {
    const workspaceId = input.workspaceId ?? "";
    await requireMailIn(userId, workspaceId);
    const boxes = await db
      .select()
      .from(mailbox)
      .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)));
    const inboxes = boxes.length
      ? await db
          .select()
          .from(mailFolder)
          .where(
            and(
              inArray(
                mailFolder.mailboxId,
                boxes.map((b) => b.id),
              ),
              eq(mailFolder.role, "inbox"),
            ),
          )
      : [];
    const listed = boxes.flatMap((box) => inboxes.filter((f) => f.mailboxId === box.id).map((folder) => ({ box, folder })));
    return threadPage(userId, workspaceId, listed, search, cursor);
  }
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const folder = await folderOf(box, input.folderId);
  return threadPage(userId, box.workspaceId, [{ box, folder }], search, cursor);
}

/** The threads of these folders (each of its own mailbox), in one list by their newest message. */
async function threadPage(userId: string, workspaceId: string, listed: { box: Box; folder: FolderRow }[], search: string, cursor: string | null): Promise<MailThreadPage> {
  // Per mailbox: the folders listed (all but the trash and junk for a search) and those whose messages count in a thread.
  const each = await Promise.all(
    listed.map(async ({ box, folder }) => {
      const visible = await threadFolders(box, folder);
      return { box, folder, visible, scope: search ? (await threadFolders(box, null)).map((f) => f.id) : [folder.id] };
    }),
  );
  const scope = each.flatMap((e) => e.scope);
  if (!scope.length) return { items: [], next: null };

  let after: SQL | undefined;
  // "<date>|<mailbox>|<thread>": a thread's id may hold a "|" of its own.
  const [at, mailboxId, ...rest] = cursor?.split("|") ?? [];
  const threadId = rest.join("|");
  if (at && mailboxId && threadId && !Number.isNaN(Date.parse(at))) after = sql`(t.last, t.mailbox_id, t.thread_id) < (${at}::timestamptz, ${mailboxId}, ${threadId})`;
  const groupsOf = (where: SQL | undefined) => db.execute<{ mailbox_id: string; thread_id: string; last: string; unread: boolean; held: number; unseen: number; starred: boolean; files: boolean; drafts: boolean; newest: string }>(sql`
    select * from (
      select ${mailMessage.mailboxId} as mailbox_id, ${mailMessage.threadId} as thread_id, max(${mailMessage.sentAt}) as last,
        bool_or(not ${mailMessage.seen}) as unread, count(*)::int as held,
        (count(*) filter (where not ${mailMessage.seen}))::int as unseen, bool_or(${mailMessage.flagged}) as starred,
        bool_or(${mailMessage.hasAttachments}) as files, bool_or(${mailMessage.draft}) as drafts,
        (array_agg(${mailMessage.id} order by ${mailMessage.sentAt} desc, ${mailMessage.uid} desc))[1] as newest
      from ${mailMessage}
      where ${where}
      group by ${mailMessage.mailboxId}, ${mailMessage.threadId}
    ) t
    ${after ? sql`where ${after}` : sql``}
    order by t.last desc, t.mailbox_id desc, t.thread_id desc
    limit ${MAIL_PAGE + 1}
  `);
  let groups = await groupsOf(and(inArray(mailMessage.folderId, scope), search ? searchCondition(search) : undefined));
  // Less than a page in the index: the mail servers look in the messages' text too.
  const words = search ? parseMailQuery(search).words.slice(0, 5) : [];
  if (words.some((w) => [...w].length >= 3) && (cursor || groups.length <= MAIL_PAGE)) {
    const searched = each.map(({ box, scope: ids }) => ({ box, folders: [] as FolderRow[], ids }));
    const folders = await db.select().from(mailFolder).where(inArray(mailFolder.id, scope));
    for (const s of searched) s.folders = folders.filter((f) => s.ids.includes(f.id));
    const key = [userId, search, ...each.map((e) => e.box.id).sort()].join("|");
    const found = await bodyMatches(key, searched, words, !!cursor);
    if (found.length) groups = await groupsOf(and(inArray(mailMessage.folderId, scope), searchCondition(search, found)));
  }
  const page_ = [...groups];
  const more = page_.length > MAIL_PAGE;
  const shown = page_.slice(0, MAIL_PAGE);
  if (!shown.length) return { items: [], next: null };

  const visible = each.flatMap((e) => e.visible.map((f) => f.id));
  // A thread answered in a draft shows it wherever it is listed.
  const drafts = new Set(each.flatMap((e) => e.visible.filter((f) => f.role === "drafts").map((f) => f.id)));
  const [newest, members] = await Promise.all([
    db
      .select()
      .from(mailMessage)
      .where(
        inArray(
          mailMessage.id,
          shown.map((g) => g.newest),
        ),
      ),
    db
      .select({
        mailboxId: mailMessage.mailboxId,
        threadId: mailMessage.threadId,
        messageId: mailMessage.messageId,
        id: mailMessage.id,
        folderId: mailMessage.folderId,
        fromAddress: mailMessage.fromAddress,
        fromName: mailMessage.fromName,
        sentAt: mailMessage.sentAt,
      })
      .from(mailMessage)
      .where(
        and(
          inArray(mailMessage.mailboxId, [...new Set(shown.map((g) => g.mailbox_id))]),
          inArray(mailMessage.threadId, [...new Set(shown.map((g) => g.thread_id))]),
          visible.length ? inArray(mailMessage.folderId, visible) : undefined,
        ),
      )
      .orderBy(desc(mailMessage.sentAt)),
  ]);
  const newestById = new Map(newest.map((m) => [m.id, m]));
  const listedIn = new Map(each.map((e) => [e.box.id, e]));
  const party = (m: MessageRow) => {
    const box = listedIn.get(m.mailboxId)?.box;
    return box ? otherParty(box, m) : null;
  };
  const rows = await rowsForAddresses(
    workspaceId,
    userId,
    newest.map(party).filter((a): a is string => !!a),
  );

  const items = shown.flatMap((g): MailThreadItem[] => {
    const message = newestById.get(g.newest);
    const from = listedIn.get(g.mailbox_id);
    if (!message || !from) return [];
    const inThread = members.filter((m) => m.mailboxId === g.mailbox_id && m.threadId === g.thread_id);
    const distinct = new Set(inThread.map((m) => m.messageId ?? m.id));
    const senders: MailAddress[] = [];
    for (const m of inThread) {
      if (m.fromAddress && !senders.some((s) => s.address === m.fromAddress)) senders.push({ address: m.fromAddress, name: m.fromName });
    }
    const other = party(message);
    return [
      {
        threadId: g.thread_id,
        mailboxId: g.mailbox_id,
        folderId: from.folder.id,
        messageId: message.id,
        senders: senders.length ? senders.slice(0, 4) : [{ address: message.fromAddress, name: message.fromName }],
        subject: message.subject,
        preview: message.preview,
        sentAt: new Date(g.last).toISOString(),
        count: Math.max(1, distinct.size),
        unread: g.unread,
        held: Number(g.held),
        unseen: Number(g.unseen),
        starred: g.starred,
        hasAttachments: g.files,
        hasDraft: g.drafts || inThread.some((m) => drafts.has(m.folderId)),
        row: other ? (rows.get(other) ?? null) : null,
      },
    ];
  });
  const last = shown[shown.length - 1];
  return { items, next: more ? `${new Date(last.last).toISOString()}|${last.mailbox_id}|${last.thread_id}` : null };
}

function messageView(m: MessageRow, folders: Map<string, FolderRow>): MailMessageView {
  return {
    id: m.id,
    folderId: m.folderId,
    folderRole: folders.get(m.folderId)?.role ?? null,
    messageId: m.messageId,
    from: { address: m.fromAddress, name: m.fromName },
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    preview: m.preview,
    sentAt: m.sentAt.toISOString(),
    seen: m.seen,
    flagged: m.flagged,
    draft: m.draft,
    hasAttachments: m.hasAttachments,
    body: null,
  };
}

/**
 * A thread's messages, oldest first: one of each (a message in two folders is shown from the folder
 * it was opened from, else its newest copy), without what is in the trash or junk unless opened
 * there. Bodies are read one by one with readBody.
 */
export async function getThread(userId: string, input: { mailboxId: string; threadId: string; folderId: string }): Promise<MailThreadView> {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const from = await folderOf(box, input.folderId);
  if (typeof input.threadId !== "string" || !input.threadId) throw new RowMailError("invalid");
  const folders = await threadFolders(box, from);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const rows = await db
    .select()
    .from(mailMessage)
    .where(
      and(
        eq(mailMessage.mailboxId, box.id),
        eq(mailMessage.threadId, input.threadId),
        inArray(
          mailMessage.folderId,
          folders.map((f) => f.id),
        ),
      ),
    )
    .orderBy(asc(mailMessage.sentAt));
  if (!rows.length) throw new RowMailError("gone");
  const kept = new Map<string, MessageRow>();
  for (const m of rows) {
    const key = m.messageId ?? m.id;
    const had = kept.get(key);
    if (!had || (had.folderId !== from.id && (m.folderId === from.id || m.sentAt >= had.sentAt))) kept.set(key, m);
  }
  // Dates have whole seconds: two messages of the same second go in the order their folder got them.
  const messages = [...kept.values()].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || (a.folderId === b.folderId ? a.uid - b.uid : 0));
  // Its subject is the newest message's, but a draft answering it isn't what the thread is called.
  const named = [...messages].reverse().find((m) => !(m.draft && byId.get(m.folderId)?.role === "drafts")) ?? messages[messages.length - 1];
  const other = [...messages].reverse().map((m) => otherParty(box, m)).find((a) => !!a);
  const chips = other ? await rowsForAddresses(box.workspaceId, userId, [other]) : new Map();
  // The newest summary made, on whichever copy of its message it was saved, shown on the copy here.
  const summarized = [...rows].reverse().find((m) => m.summary);
  return {
    threadId: input.threadId,
    subject: named.subject || messages[0].subject,
    messages: messages.map((m) => messageView(m, byId)),
    row: other ? (chips.get(other) ?? null) : null,
    summary: summarized?.summary ? { text: summarized.summary, messageId: kept.get(summarized.messageId ?? summarized.id)?.id ?? summarized.id } : null,
  };
}

/** Base64 makes a file about a third larger on the way. */
const travelling = (bytes: number) => Math.ceil(bytes * 1.4) + 1024;

/** The message row and its folder, for its owner. */
export async function ownMessage(userId: string, id: string) {
  const [found] =
    typeof id === "string" && id
      ? await db.select({ message: mailMessage, folder: mailFolder }).from(mailMessage).innerJoin(mailFolder, eq(mailFolder.id, mailMessage.folderId)).where(eq(mailMessage.id, id))
      : [];
  if (!found) throw new RowMailError("gone");
  const box = await requireOwnMailbox(userId, found.message.mailboxId);
  return { box, ...found };
}

const listAddresses = (value: string | undefined): MailAddress[] =>
  (value ?? "")
    .split(",")
    .map((part) => {
      const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
      const address = normalizeAddress(match ? match[2] : part);
      return address ? { address, name: match?.[1]?.trim() || null } : null;
    })
    .filter((a): a is MailAddress => !!a);

/**
 * Reads a message's text, cleaned HTML and list of files from the mail server (or memory, when it
 * was read lately or loaded ahead), and marks it read. Its HTML loads images from other sites when
 * `images` asks for them (remembered for the next time), or as lib/mail-images.ts allows. A message
 * no longer on the server throws `gone`.
 */
export async function readBody(userId: string, input: { id: string; images?: boolean }): Promise<MailBody> {
  const { box, message, folder } = await ownMessage(userId, input.id);
  const body = await openBody(box, message, folder, input.images === true);
  if (!message.seen) {
    await db.update(mailMessage).set({ seen: true }).where(eq(mailMessage.id, message.id));
    await db
      .update(mailFolder)
      .set({ unseen: sql`greatest(0, ${mailFolder.unseen} - 1)` })
      .where(eq(mailFolder.id, folder.id));
    // The server hears of it after the answer has gone.
    void withImap(box, async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        await client.messageFlagsAdd(String(message.uid), ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    }, "open", { within: SHORT_MS }).catch(() => {});
  }
  return body;
}

/**
 * A message's body for someone waiting on it: from memory when it was read lately or loaded ahead
 * (`images` as opening it asks, so both find the same copy), else from the mail server on the
 * mailbox's `open` connection.
 */
async function openBody(box: Box, message: MessageRow, folder: FolderRow, imagesAsked: boolean): Promise<MailBody> {
  const started = performance.now();
  const images = await imagesFor(box, message, imagesAsked);
  const fromServer = () => heldBody(message.id, images, (started) => loadBody(box, message, folder, images, "open", started), { queued: false });
  let held = fromServer();
  let body: MailBody;
  try {
    body = await held.body;
  } catch (error) {
    // The connection (this one's, or the one loading it ahead) dropped or stopped answering, and
    // was closed: a new one is opened for one more try.
    if (!(error instanceof ConnectionLost)) throw error;
    held = fromServer();
    body = await held.body;
  }
  if (held.from !== "server") console.info(`[mail-client] body ${Math.round(performance.now() - started)} ms from ${held.from}`);
  return body;
}

/**
 * A message and its text for the AI (mail-client/ai.ts), read as opening it would but left unread:
 * a summary or an answer written from it is not the person reading it.
 */
export async function messageForAi(userId: string, id: string) {
  const { box, message, folder } = await ownMessage(userId, id);
  const text = (await openBody(box, message, folder, false)).text;
  return { box, message, text };
}

/** The database row the other party of a message is, as its thread's chip finds it (the writer's context, mail-client/ai.ts), or null. */
export async function rowOfMessage(userId: string, id: string): Promise<RowChip | null> {
  const { box, message } = await ownMessage(userId, id);
  const other = otherParty(box, message);
  return other ? ((await rowsForAddresses(box.workspaceId, userId, [other])).get(other) ?? null) : null;
}

/** At most this many messages are loaded ahead at once. */
const AHEAD = 8;

/**
 * Loads messages the person is likely to open next (the top of the list, the neighbours of the open
 * thread) into memory, one after another on the mailbox's background connection, without marking
 * them read.
 */
export async function prefetchBodies(userId: string, input: { ids: string[] }): Promise<null> {
  const ids = Array.isArray(input?.ids) ? input.ids.filter((id): id is string => typeof id === "string" && !!id).slice(0, AHEAD) : [];
  for (const id of ids) {
    const found = await ownMessage(userId, id).catch(() => null);
    if (!found) continue;
    // Loaded the way opening it would load it, or the click would read it again.
    const images = await imagesFor(found.box, found.message, false);
    if (bodyHeld(id, images)) continue;
    await heldBody(id, images, (started) => loadBody(found.box, found.message, found.folder, images, "background", started)).body.catch(() => null);
  }
  return null;
}

/**
 * A message's body from the mail server, unchanged there: its structure, then the text, HTML and
 * images it carries in one more command. Images from other sites load for the reason `images`
 * gives, if its sender passes the provider's check (lib/mail-images.ts). Logs how long each step took.
 */
async function loadBody(box: Box, message: MessageRow, folder: FolderRow, images: MailImagesFrom | null, lane: ImapLane, started: () => void): Promise<MailBody> {
  const time = { wait: 0, select: 0, structure: 0, parts: 0, clean: 0 };
  let mark = performance.now();
  const step = (name: keyof typeof time) => {
    const now = performance.now();
    time[name] = Math.round(now - mark);
    mark = now;
  };
  const result = await withImap(
    box,
    async (client) => {
      step("wait");
      started();
      const lock = await client.getMailboxLock(folder.path);
      step("select");
      try {
        const fetched = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true, headers: ["reply-to", "authentication-results", "list-unsubscribe", "list-unsubscribe-post"] }, { uid: true });
        step("structure");
        if (!fetched || !fetched.bodyStructure) return null;
        const parts = messageParts(fetched.bodyStructure);
        const fields = parseHeaderBlock(fetched.headers);
        // Images the HTML may show, within the limits: which of them it does is known once it is read.
        let room = MAX_INLINE_TOTAL;
        const pictures = parts.html
          ? parts.attachments.filter((file) => {
              if (!file.contentId || !/^image\/(png|gif|jpe?g|webp)$/.test(file.contentType) || file.size > MAX_INLINE_IMAGE * 1.4 || file.size > room * 1.4) return false;
              room -= file.size / 1.4;
              return true;
            })
          : [];
        const wanted = [
          ...[parts.text, parts.html].filter((ref): ref is PartRef => !!ref).map((ref) => ({ part: ref.part, limit: travelling(MAX_BODY_BYTES) })),
          ...pictures.map((file) => ({ part: file.part, limit: travelling(MAX_INLINE_IMAGE) })),
        ];
        const raw = await readParts(client, message.uid, wanted).catch(() => new Map<string, Buffer>());
        step("parts");
        const textOf = (ref: PartRef | null) => {
          const bytes = ref && raw.get(ref.part);
          return bytes ? decodeText(bytes, ref.encoding, ref.charset) : null;
        };
        const rawHtml = textOf(parts.html);
        const inline = new Map<string, string>();
        for (const file of pictures) {
          const bytes = raw.get(file.part);
          if (!bytes || !rawHtml?.includes(`cid:${file.contentId}`)) continue;
          inline.set(file.contentId!, `data:${file.contentType};base64,${decodeTransfer(bytes, file.encoding).toString("base64")}`);
        }
        return { parts, fields, text: textOf(parts.text), rawHtml, inline };
      } finally {
        lock.release();
      }
    },
    lane,
    { within: BODY_MS },
  );
  // Gone from the server, or not found this once: the next pass's check takes it out of the index if it is gone.
  if (!result) throw new RowMailError("gone");
  const unverifiedSender = folder.role !== "sent" && dmarcFailed(result.fields.get("authentication-results"));
  const shown = imagesShown(images, unverifiedSender);
  const cleaned = result.rawHtml ? await cleanMailHtml(result.rawHtml, { images: !!shown, inline: result.inline }) : null;
  const text = result.text ?? (result.rawHtml ? await htmlText(result.rawHtml) : "");
  step("clean");
  const total = Object.values(time).reduce((a, b) => a + b, 0);
  console.info(`[mail-client] body ${total} ms on ${lane} (wait ${time.wait}, select ${time.select}, structure ${time.structure}, parts ${time.parts}, clean ${time.clean})`);
  const shownInline = new Set(result.inline.keys());
  const attachments: MailAttachmentView[] = result.parts.attachments.filter((a) => !(a.inline && a.contentId && shownInline.has(a.contentId))).map(fileView);
  return {
    text,
    html: cleaned?.html ?? null,
    quotedHtml: cleaned?.quotedHtml ?? null,
    blockedImages: cleaned?.blockedImages ?? 0,
    images: shown,
    attachments,
    replyTo: listAddresses(result.fields.get("reply-to")?.[0]),
    unverifiedSender,
    unsubscribe: unsubscribeOffer(unsubscribeTargets(result.fields.get("list-unsubscribe")?.[0], result.fields.get("list-unsubscribe-post")?.[0]), unverifiedSender),
  };
}

/** A file of a message, read from the mail server whole (MAX_ATTACHMENT_BYTES at most). */
export async function readAttachment(userId: string, input: { id: string; part: string }) {
  if (typeof input.part !== "string" || !/^\d+(\.\d+)*$/.test(input.part)) throw new RowMailError("invalid");
  const { box, message, folder } = await ownMessage(userId, input.id);
  const file = await withImap(box, async (client) => {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const fetched = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true }, { uid: true });
      const listed = fetched && fetched.bodyStructure ? messageParts(fetched.bodyStructure).attachments.find((a) => a.part === input.part) : undefined;
      if (!listed) return null;
      if (listed.size > travelling(MAX_ATTACHMENT_BYTES)) throw new RowMailError("tooMany");
      const raw = await readPart(client, message.uid, listed.part, travelling(MAX_ATTACHMENT_BYTES));
      if (!raw) return null;
      return { name: listed.name, contentType: listed.contentType, data: decodeTransfer(raw, listed.encoding) };
    } finally {
      lock.release();
    }
  });
  if (!file) throw new RowMailError("gone");
  return file;
}

/**
 * A message as the mail server keeps it, headers and all (MAX_ATTACHMENT_BYTES of base64 at most),
 * for its owner to read or save as an .eml file; its subject names the file.
 */
export async function readSource(userId: string, input: { id: string }) {
  const { box, message, folder } = await ownMessage(userId, input?.id);
  const limit = travelling(MAX_ATTACHMENT_BYTES);
  const source = await withImap(box, async (client) => {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const sized = await client.fetchOne(String(message.uid), { uid: true, size: true }, { uid: true });
      if (!sized) return null;
      if ((sized.size ?? 0) > limit) throw new RowMailError("tooMany");
      const fetched = await client.fetchOne(String(message.uid), { uid: true, source: { maxLength: limit } }, { uid: true });
      return fetched ? (fetched.source ?? null) : null;
    } finally {
      lock.release();
    }
  });
  if (!source) throw new RowMailError("gone");
  return { subject: message.subject, data: source };
}

/** Whether the sidebar offers the Mail tab: email is on in the workspace and the person has a mailbox there. Never throws. */
export async function mailTabShown(userId: string, workspaceId: string): Promise<boolean> {
  const [one] = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)))
    .limit(1);
  if (!one) return false;
  return requireMailIn(userId, workspaceId).then(
    () => true,
    () => false,
  );
}
