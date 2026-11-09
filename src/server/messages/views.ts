/**
 * Rows read as what a client keeps (lib/message-wire.ts): channels with their counts, a person's
 * memberships with their unread counts, messages with their reactions, files and polls.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  channel,
  channelMember,
  channelMessage,
  channelSection,
  file,
  messageDraft,
  messageFile,
  messagePoll,
  messagePollVote,
  messageReaction,
  messageStatus,
  messageThread,
  savedMessage,
  scheduledMessage,
} from "@/db/schema";
import { fileUrl } from "@/lib/files";
import type {
  ChannelView,
  DraftView,
  FileView,
  MembershipView,
  MessageView,
  PollView,
  SavedView,
  ScheduledView,
  SectionView,
  StatusView,
  ThreadView,
} from "@/lib/message-wire";
import { stillInWorkspace } from "./core";

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** Unread counts stop here: the list shows 99+. */
const UNREAD_CAP = 99;

/** The channels matching `where` (a condition on `channel`), as clients keep them. */
export async function channelViews(where: SQL | undefined): Promise<ChannelView[]> {
  if (!where) return [];
  const rows = await db
    .select({
      row: channel,
      // Columns in select fields are written without their table, which a subquery would read as its own: named in full.
      memberCount: sql<number>`(select count(*)::int from ${channelMember} cm where cm.channel_id = "channel"."id"
        and ${stillInWorkspace(sql`cm.user_id`, sql`"channel"."workspace_id"`)})`,
      people: sql<string[]>`case when ${channel.kind} = 'direct' then string_to_array(${channel.directKey}, ',') else '{}'::text[] end`,
    })
    .from(channel)
    .where(where);
  return rows.map(({ row, memberCount, people }) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    description: row.description,
    posting: row.posting,
    joinNew: row.joinNew,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: iso(row.archivedAt),
    lastSeq: row.lastSeq,
    lastMessageAt: iso(row.lastMessageAt),
    memberCount,
    people: people ?? [],
    rev: row.rev,
  }));
}

/** SQL: a message that counts toward a channel's unread (in its main list, from someone else, not deleted), on alias `m`. */
const countsUnread = (userId: SQL) =>
  sql`(m.thread_id is null or m.also_in_channel) and m.kind = 'message' and m.deleted_at is null and m.author_id is distinct from ${userId}`;

/** The person's memberships of the channels matching `where` (a condition on `channel_member`), with what is unread. */
export async function membershipViews(userId: string, where?: SQL): Promise<MembershipView[]> {
  const rows = await db
    .select({
      row: channelMember,
      unread: sql<number>`(select count(*)::int from (select 1 from ${channelMessage} m where m.channel_id = "channel_member"."channel_id"
        and m.seq > "channel_member"."last_read_seq" and ${countsUnread(sql`"channel_member"."user_id"`)} limit ${UNREAD_CAP + 1}) u)`,
    })
    .from(channelMember)
    .where(and(eq(channelMember.userId, userId), where));
  return rows.map(({ row, unread }) => ({
    channelId: row.channelId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
    lastReadSeq: row.lastReadSeq,
    unread: Math.min(unread, UNREAD_CAP + 1),
    mentions: row.mentions,
    notify: row.notify,
    muted: row.muted,
    starred: row.starred,
    hidden: row.hidden,
    sectionId: row.sectionId,
    rev: row.rev,
  }));
}

/**
 * The messages matching `where` (a condition on `channel_message`), in `seq` order, with reactions,
 * files and polls. `viewer`: whose own choices in polls `mine` holds (none without one).
 */
export async function messageViews(where: SQL | undefined, options: { order?: "asc" | "desc"; limit?: number; viewer?: string | null } = {}): Promise<MessageView[]> {
  if (!where) return [];
  let query = db
    .select()
    .from(channelMessage)
    .where(where)
    .orderBy(options.order === "desc" ? sql`${channelMessage.seq} desc` : asc(channelMessage.seq))
    .$dynamic();
  if (options.limit) query = query.limit(options.limit);
  return withExtras(await query, options.viewer ?? null);
}

type MessageRow = typeof channelMessage.$inferSelect;
type PollRow = typeof messagePoll.$inferSelect;
type PollVotes = { poll: PollRow; votes: { optionId: string; userId: string }[] };

/** The polls among these messages, with every vote on them. */
async function pollsOf(ids: string[]): Promise<Map<string, PollVotes>> {
  const polls = await db.select().from(messagePoll).where(inArray(messagePoll.messageId, ids));
  if (!polls.length) return new Map();
  const votes = await db
    .select({ messageId: messagePollVote.messageId, optionId: messagePollVote.optionId, userId: messagePollVote.userId })
    .from(messagePollVote)
    .where(
      inArray(
        messagePollVote.messageId,
        polls.map((p) => p.messageId),
      ),
    )
    .orderBy(asc(messagePollVote.createdAt));
  return new Map(polls.map((poll) => [poll.messageId, { poll, votes: votes.filter((v) => v.messageId === poll.messageId) }]));
}

/** A poll as `viewer` sees it: who chose what only when it isn't anonymous, and their own choices. */
function pollView({ poll, votes }: PollVotes, viewer: string | null): PollView {
  const options = poll.options.map((o) => {
    const ids = votes.filter((v) => v.optionId === o.id).map((v) => v.userId);
    return { id: o.id, text: o.text, count: ids.length, voters: poll.anonymous ? null : ids };
  });
  const known = new Set(poll.options.map((o) => o.id));
  return {
    question: poll.question,
    options,
    multiple: poll.multiple,
    anonymous: poll.anonymous,
    voters: new Set(votes.filter((v) => known.has(v.optionId)).map((v) => v.userId)).size,
    closesAt: iso(poll.closesAt),
    closedAt: iso(poll.closedAt),
    closedBy: poll.closedBy,
    mine: viewer ? poll.options.filter((o) => votes.some((v) => v.userId === viewer && v.optionId === o.id)).map((o) => o.id) : [],
  };
}

/**
 * The choices these people made in these messages' polls, by person, then message: announce.ts reads
 * a change's messages once for everyone and gives each person their own `mine` from this.
 */
export async function pollChoices(messageIds: string[], userIds: string[]): Promise<Map<string, Map<string, Set<string>>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  if (!messageIds.length || !userIds.length) return out;
  const rows = await db
    .select({ messageId: messagePollVote.messageId, optionId: messagePollVote.optionId, userId: messagePollVote.userId })
    .from(messagePollVote)
    .where(and(inArray(messagePollVote.messageId, messageIds), inArray(messagePollVote.userId, userIds)));
  for (const r of rows) {
    const mine = out.get(r.userId) ?? new Map<string, Set<string>>();
    mine.set(r.messageId, (mine.get(r.messageId) ?? new Set()).add(r.optionId));
    out.set(r.userId, mine);
  }
  return out;
}

/** A message view with its poll's `mine` set to these choices (as `pollChoices` gives them for one person). */
export function withChoices(m: MessageView, choices: Map<string, Set<string>> | undefined): MessageView {
  if (!m.poll) return m;
  const chosen = choices?.get(m.id);
  return { ...m, poll: { ...m.poll, mine: chosen ? m.poll.options.filter((o) => chosen.has(o.id)).map((o) => o.id) : [] } };
}

/** Message rows with their reactions, files and polls, as clients keep them; `viewer`'s own choices in polls in `mine`. */
export async function withExtras(rows: MessageRow[], viewer: string | null): Promise<MessageView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [reactions, files, polls] = await Promise.all([
    db
      .select({ messageId: messageReaction.messageId, emoji: messageReaction.emoji, userId: messageReaction.userId })
      .from(messageReaction)
      .where(inArray(messageReaction.messageId, ids))
      .orderBy(asc(messageReaction.createdAt)),
    db
      .select({
        messageId: messageFile.messageId,
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        width: messageFile.width,
        height: messageFile.height,
      })
      .from(messageFile)
      .innerJoin(file, eq(file.id, messageFile.fileId))
      .where(inArray(messageFile.messageId, ids))
      .orderBy(asc(messageFile.createdAt)),
    pollsOf(ids),
  ]);
  const reactionsOf = new Map<string, Map<string, string[]>>();
  for (const r of reactions) {
    const byEmoji = reactionsOf.get(r.messageId) ?? new Map<string, string[]>();
    byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.userId]);
    reactionsOf.set(r.messageId, byEmoji);
  }
  const filesOf = new Map<string, FileView[]>();
  for (const f of files) {
    if (!f.messageId) continue;
    filesOf.set(f.messageId, [
      ...(filesOf.get(f.messageId) ?? []),
      { id: f.id, url: fileUrl(f.id), name: f.name, contentType: f.contentType, size: f.size, width: f.width, height: f.height },
    ]);
  }
  return rows.map((row) => {
    const poll = polls.get(row.id);
    return messageView(row, reactionsOf.get(row.id), filesOf.get(row.id), poll && !row.deletedAt ? pollView(poll, viewer) : null);
  });
}

function messageView(row: MessageRow, reactions: Map<string, string[]> | undefined, files: FileView[] | undefined, poll: PollView | null): MessageView {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    threadId: row.threadId,
    authorId: row.authorId,
    kind: row.kind,
    body: row.deletedAt ? "" : row.body,
    data: row.deletedAt ? null : (row.data ?? null),
    alsoInChannel: row.alsoInChannel,
    replyCount: row.replyCount,
    lastReplySeq: row.lastReplySeq,
    lastReplyAt: iso(row.lastReplyAt),
    repliers: row.repliers,
    editedAt: iso(row.editedAt),
    deletedAt: iso(row.deletedAt),
    pinnedAt: iso(row.pinnedAt),
    pinnedBy: row.pinnedBy,
    createdAt: row.createdAt.toISOString(),
    reactions: [...(reactions ?? new Map<string, string[]>())].map(([emoji, userIds]) => ({ emoji, userIds })),
    files: row.deletedAt ? [] : (files ?? []),
    poll,
    rev: row.rev,
  };
}

export async function threadViews(userId: string, where?: SQL): Promise<ThreadView[]> {
  const rows = await db
    .select()
    .from(messageThread)
    .where(and(eq(messageThread.userId, userId), where));
  return rows.map((r) => ({
    threadId: r.threadId,
    channelId: r.channelId,
    following: r.following,
    lastReadSeq: r.lastReadSeq,
    mentions: r.mentions,
    lastReplyAt: iso(r.lastReplyAt),
    rev: r.rev,
  }));
}

export async function draftViews(userId: string, where?: SQL): Promise<DraftView[]> {
  const rows = await db
    .select()
    .from(messageDraft)
    .where(and(eq(messageDraft.userId, userId), where));
  return rows.map((r) => ({ channelId: r.channelId, threadId: r.threadId, body: r.body, fileIds: r.fileIds, updatedAt: r.updatedAt.toISOString(), rev: r.rev }));
}

export async function savedViews(userId: string, where?: SQL): Promise<SavedView[]> {
  const rows = await db
    .select({ row: savedMessage, channelId: channelMessage.channelId })
    .from(savedMessage)
    .innerJoin(channelMessage, eq(channelMessage.id, savedMessage.messageId))
    .where(and(eq(savedMessage.userId, userId), where));
  return rows.map(({ row, channelId }) => ({
    messageId: row.messageId,
    channelId,
    createdAt: row.createdAt.toISOString(),
    remindAt: iso(row.remindAt),
    doneAt: iso(row.doneAt),
    rev: row.rev,
  }));
}

export async function sectionViews(userId: string, where?: SQL): Promise<SectionView[]> {
  const rows = await db
    .select()
    .from(channelSection)
    .where(and(eq(channelSection.userId, userId), where))
    .orderBy(asc(channelSection.position));
  return rows.map((r) => ({ id: r.id, name: r.name, position: r.position, collapsed: r.collapsed, rev: r.rev }));
}

export async function statusViews(where: SQL): Promise<StatusView[]> {
  const rows = await db.select().from(messageStatus).where(where);
  return rows.map((r) => ({
    userId: r.userId,
    emoji: r.emoji,
    text: r.text,
    statusUntil: iso(r.statusUntil),
    quietUntil: iso(r.quietUntil),
    previews: r.previews,
    rev: r.rev,
  }));
}

export async function scheduledViews(userId: string, where?: SQL): Promise<ScheduledView[]> {
  const rows = await db
    .select()
    .from(scheduledMessage)
    .where(and(eq(scheduledMessage.userId, userId), where))
    .orderBy(asc(scheduledMessage.sendAt));
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    threadId: r.threadId,
    body: r.body,
    fileIds: r.fileIds,
    sendAt: r.sendAt.toISOString(),
    failure: r.failure,
    rev: r.rev,
  }));
}
