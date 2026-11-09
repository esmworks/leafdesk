/**
 * Messages themselves: sending (replies, files, mentions), editing with history, deleting,
 * reactions, pins, what each person has read in a channel or a thread, threads they follow, and
 * the pages of a channel's history a client loads. A poll is sent here too, as a message whose
 * text is its question (polls.ts takes the votes).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { channelMember, channelMessage, file, messageDraft, messageFile, messageMention, messagePoll, messagePollVote, messageReaction, messageThread, messageVersion, savedMessage } from "@/db/schema";
import type { PollSettings } from "@/lib/message-polls";
import { broadcastOf, hasWords, mentionedUserIds, plainText } from "@/lib/message-text";
import { isEmoji, isMessageId, MESSAGE_LIMITS, type MessageData } from "@/lib/messages";
import type { MessageView } from "@/lib/message-wire";
import { heldUserIds } from "@/server/legal-hold";
import type { Tx } from "@/server/workspaces";
import { addPeople, nextSeq, systemMessage } from "./channels";
import { MessageError, requireChannel, stillInWorkspace, write, type Changed, type ChannelAccess } from "./core";
import { isActive } from "./hub";
import { previewMessageLinks, previewSoon } from "./link-previews";
import { messageViews, withExtras } from "./views";

type MessageRow = typeof channelMessage.$inferSelect;

/** At most this many recent repliers are kept on a thread's first message. */
const REPLIERS = 5;

const bodyOf = (value: unknown): string => {
  if (typeof value !== "string") throw new MessageError("invalid");
  const body = value.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (body.length > MESSAGE_LIMITS.body) throw new MessageError("tooLong");
  return body;
};

const fileIdsOf = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new MessageError("invalid");
  const ids = [...new Set(value as string[])];
  if (ids.length > MESSAGE_LIMITS.files) throw new MessageError("tooMany");
  return ids;
};

async function messageFor(userId: string, messageId: unknown, need: "read" | "write" = "read"): Promise<{ message: MessageRow } & ChannelAccess> {
  if (typeof messageId !== "string" || !messageId) throw new MessageError("notFound");
  const [message] = await db.select().from(channelMessage).where(eq(channelMessage.id, messageId)).limit(1);
  if (!message) throw new MessageError("notFound");
  const access = await requireChannel(userId, message.channelId, need);
  return { message, ...access };
}

/** Of the people named, those in the channel (who are told), and the others (whom the writer may add). */
async function namedIn(tx: Tx, channelId: string, userIds: string[]): Promise<{ inside: string[]; outside: string[] }> {
  if (!userIds.length) return { inside: [], outside: [] };
  const rows = await tx
    .select({ userId: channelMember.userId })
    .from(channelMember)
    .where(and(eq(channelMember.channelId, channelId), inArray(channelMember.userId, userIds)));
  const inside = new Set(rows.map((r) => r.userId));
  return { inside: [...inside], outside: userIds.filter((id) => !inside.has(id)) };
}

/** Everyone in the channel but the writer, for @channel; for @here only those with the app in front. */
async function broadcastTargets(tx: Tx, workspaceId: string, channelId: string, userId: string, kind: "everyone" | "here"): Promise<string[]> {
  const rows = await tx
    .select({ userId: channelMember.userId })
    .from(channelMember)
    .where(and(eq(channelMember.channelId, channelId), stillInWorkspace(sql`${channelMember.userId}`, sql`${channelMember.workspaceId}`)));
  const others = rows.map((r) => r.userId).filter((id) => id !== userId);
  return kind === "everyone" ? others : others.filter((id) => isActive(workspaceId, id));
}

/** `poll`: a poll already checked (lib/message-polls.ts `readPollInput`), stored with the message; its question is the body. */
export type SendInput = { id?: unknown; channelId?: unknown; threadId?: unknown; body?: unknown; fileIds?: unknown; alsoInChannel?: unknown; data?: MessageData; poll?: PollSettings };
export type SendResult = { message: MessageView; notInChannel: string[] };

/**
 * Sends a message as `userId`. `id` is the client's (a UUID): sending it again returns the
 * message stored the first time. A reply names its thread's first message; a file must have been
 * uploaded to the channel by the writer and not sent yet.
 */
/** The message stored under the client's id by an earlier send of the same one, or null. */
async function sentBefore(userId: string, id: string): Promise<SendResult | null> {
  const [already] = await db.select().from(channelMessage).where(eq(channelMessage.id, id)).limit(1);
  if (!already) return null;
  if (already.authorId !== userId) throw new MessageError("invalid");
  return { message: (await withExtras([already], userId))[0], notInChannel: [] };
}

export async function sendMessage(userId: string, input: SendInput): Promise<SendResult> {
  const id = isMessageId(input.id) ? input.id.toLowerCase() : crypto.randomUUID();
  const earlier = await sentBefore(userId, id);
  if (earlier) return earlier;
  const access = await requireChannel(userId, String(input.channelId ?? ""), "write");
  const { channel: row, member } = access;
  const body = input.poll ? input.poll.question : bodyOf(input.body ?? "");
  const fileIds = input.poll ? [] : fileIdsOf(input.fileIds);
  if (!hasWords(body) && !fileIds.length && !input.data?.forward) throw new MessageError("invalid", "A message needs words or a file");
  let root: MessageRow | null = null;
  if (input.threadId !== undefined && input.threadId !== null) {
    if (typeof input.threadId !== "string") throw new MessageError("invalid");
    [root] = await db.select().from(channelMessage).where(eq(channelMessage.id, input.threadId)).limit(1);
    if (!root || root.channelId !== row.id || root.threadId || root.kind !== "message") throw new MessageError("notFound");
  }
  const alsoInChannel = Boolean(root && input.alsoInChannel === true);
  const shown = !root || alsoInChannel;
  // Replies stay open to everyone; what shows in the main list is the admins' alone.
  if (shown && row.posting === "admins" && member?.role !== "admin" && access.role !== "owner") throw new MessageError("adminsOnly");
  const named = mentionedUserIds(body).filter((uid) => uid !== userId);
  const broadcast = row.kind === "direct" ? null : broadcastOf(body);
  // Naming an agent outside the channel brings it in, so it answers (agents/channel-mentions.ts).
  const bringIn =
    named.length && row.kind !== "direct"
      ? await import("@/server/agents/channel-mentions").then(({ agentsToBringIn }) => agentsToBringIn(userId, row.workspaceId, access.role, named))
      : [];

  let notInChannel: string[] = [];
  try {
    await stored(row, root, { id, userId, body, fileIds, data: input.data ?? null, poll: input.poll ?? null, alsoInChannel, shown, named, broadcast, bringIn }, (outside) => (notInChannel = outside));
  } catch (error) {
    // The same message sent twice at once (a retry while the first was on its way): the second waited for the first and found its id taken.
    const earlier = await sentBefore(userId, id);
    if (earlier) return earlier;
    throw error;
  }
  // Agents named in the channel answer in its thread (agents/channel-mentions.ts), once the message is stored.
  // Loaded here: the agents' worker sends their answers through this module.
  if (named.length && row.kind !== "direct") {
    void import("@/server/agents/channel-mentions")
      .then(({ startChannelMentionRuns }) => startChannelMentionRuns(id))
      .catch((error) => console.error("[messages] could not ask the agents a message names", error));
  }
  previewSoon(id, body);
  const [message] = await messageViews(eq(channelMessage.id, id), { viewer: userId });
  return { message, notInChannel };
}

type Outgoing = {
  id: string;
  userId: string;
  body: string;
  fileIds: string[];
  data: MessageData | null;
  poll: PollSettings | null;
  alsoInChannel: boolean;
  shown: boolean;
  named: string[];
  broadcast: "everyone" | "here" | null;
  /** Agents named to add to the channel first. */
  bringIn: string[];
};

/** Stores a message being sent, with its files, mentions, thread and read marks, as one write. */
async function stored(row: ChannelAccess["channel"], root: MessageRow | null, out: Outgoing, notInChannel: (outside: string[]) => void) {
  const { id, userId, body, fileIds, alsoInChannel, shown, named, broadcast, bringIn } = out;
  await write(row.workspaceId, async (tx, changed) => {
    // The line saying who brought them in comes before the message.
    const brought = await addPeople(tx, changed, row, bringIn);
    if (brought.length) await systemMessage(tx, changed, row, userId, { event: "added", users: brought });
    const seq = await nextSeq(tx, row.id, changed.rev, shown);
    const now = new Date();
    await tx.insert(channelMessage).values({
      id,
      channelId: row.id,
      workspaceId: row.workspaceId,
      seq,
      threadId: root?.id ?? null,
      authorId: userId,
      body,
      plain: plainText(body),
      data: out.data,
      alsoInChannel,
      createdAt: now,
      rev: changed.rev,
    });
    if (out.poll) {
      const { question, options, multiple, anonymous, closesAt } = out.poll;
      await tx.insert(messagePoll).values({ messageId: id, question, options, multiple, anonymous, closesAt });
    }
    changed.message(id);
    changed.channel(row.id);
    changed.sent(id);

    if (fileIds.length) {
      const attached = await tx
        .update(messageFile)
        .set({ messageId: id })
        .where(and(inArray(messageFile.fileId, fileIds), eq(messageFile.channelId, row.id), eq(messageFile.userId, userId), isNull(messageFile.messageId)))
        .returning({ fileId: messageFile.fileId });
      if (attached.length !== fileIds.length) throw new MessageError("invalid", "A file wasn't uploaded here");
      await tx
        .update(file)
        .set({ referencedAt: now })
        .where(inArray(file.id, fileIds));
    }

    const { inside, outside } = await namedIn(tx, row.id, named);
    notInChannel(outside);
    const everyone = broadcast ? await broadcastTargets(tx, row.workspaceId, row.id, userId, broadcast) : [];
    const told = [...new Set([...inside, ...everyone])];
    if (told.length) {
      await tx
        .insert(messageMention)
        .values(told.map((uid) => ({ messageId: id, userId: uid, workspaceId: row.workspaceId, broadcast: !inside.includes(uid), createdAt: now })))
        .onConflictDoNothing();
    }

    if (root) {
      await replied(tx, changed, root, { id, seq, userId, now, told, named: inside });
    }
    if (shown) {
      if (told.length) {
        await tx
          .update(channelMember)
          .set({ mentions: sql`${channelMember.mentions} + 1`, rev: changed.rev })
          .where(and(eq(channelMember.channelId, row.id), inArray(channelMember.userId, told)));
        for (const uid of told) changed.member(row.id, uid);
      }
      // A direct conversation hidden by someone comes back to their list.
      if (row.kind === "direct") {
        const shownAgain = await tx
          .update(channelMember)
          .set({ hidden: false, rev: changed.rev })
          .where(and(eq(channelMember.channelId, row.id), eq(channelMember.hidden, true)))
          .returning({ userId: channelMember.userId });
        for (const { userId: uid } of shownAgain) changed.member(row.id, uid);
      }
      // Writing reads everything up to one's own message.
      await tx
        .update(channelMember)
        .set({ lastReadSeq: seq, mentions: 0, rev: changed.rev })
        .where(and(eq(channelMember.channelId, row.id), eq(channelMember.userId, userId)));
      changed.member(row.id, userId);
      changed.read(row.id, userId, seq);
    }

    // What they were writing here is sent.
    const threadKey = root?.id ?? "";
    const drafts = await tx
      .delete(messageDraft)
      .where(and(eq(messageDraft.userId, userId), eq(messageDraft.channelId, row.id), eq(messageDraft.threadId, threadKey)))
      .returning({ userId: messageDraft.userId });
    if (drafts.length) changed.draftGone(userId, row.id, threadKey);
  });
}

/** A reply's effects on its thread: counts on the first message, who follows it, what they have read. */
async function replied(tx: Tx, changed: Changed, root: MessageRow, reply: { id: string; seq: number; userId: string; now: Date; told: string[]; named: string[] }) {
  await tx
    .update(channelMessage)
    .set({
      replyCount: sql`${channelMessage.replyCount} + 1`,
      lastReplySeq: reply.seq,
      lastReplyAt: reply.now,
      repliers: sql`(array[${reply.userId}::text] || array_remove(${channelMessage.repliers}, ${reply.userId}::text))[1:${REPLIERS}]`,
      rev: changed.rev,
    })
    .where(eq(channelMessage.id, root.id));
  changed.message(root.id);
  // The writer, whoever started the thread and those named by name follow it (unless they chose
  // not to); @channel and @here tell the channel without making everyone in it follow the thread.
  const joining = [...new Set([reply.userId, ...(root.authorId ? [root.authorId] : []), ...reply.named])];
  await tx
    .insert(messageThread)
    .values(joining.map((uid) => ({ threadId: root.id, userId: uid, channelId: root.channelId, workspaceId: root.workspaceId, following: true, lastReplyAt: reply.now, rev: changed.rev })))
    .onConflictDoNothing();
  const followers = await tx
    .update(messageThread)
    .set({
      lastReplyAt: reply.now,
      rev: changed.rev,
      mentions: sql`${messageThread.mentions} + case when ${messageThread.userId} in ${reply.told.length ? reply.told : [""]} then 1 else 0 end`,
      lastReadSeq: sql`case when ${messageThread.userId} = ${reply.userId} then ${reply.seq} else ${messageThread.lastReadSeq} end`,
    })
    .where(eq(messageThread.threadId, root.id))
    .returning({ userId: messageThread.userId });
  for (const { userId } of followers) changed.thread(root.id, userId);
}

/** Changes the words of one's own message, keeping what it said before. */
export async function editMessage(userId: string, messageId: unknown, input: { body?: unknown }): Promise<void> {
  const { message, channel: row } = await messageFor(userId, messageId, "write");
  if (message.authorId !== userId || message.kind !== "message") throw new MessageError("notAllowed");
  if (message.deletedAt) throw new MessageError("notFound");
  // A poll's words are its question, which stays as people voted on it.
  const [poll] = await db.select({ id: messagePoll.messageId }).from(messagePoll).where(eq(messagePoll.messageId, message.id)).limit(1);
  if (poll) throw new MessageError("notAllowed");
  const body = bodyOf(input.body ?? "");
  if (body === message.body) return;
  const [{ files }] = await db
    .select({ files: sql<number>`count(*)::int` })
    .from(messageFile)
    .where(eq(messageFile.messageId, message.id));
  if (!hasWords(body) && !files && !message.data?.forward) throw new MessageError("invalid");
  const before = new Set(mentionedUserIds(message.body));
  const added = mentionedUserIds(body).filter((uid) => uid !== userId && !before.has(uid));
  const dropped = [...before].filter((uid) => !mentionedUserIds(body).includes(uid));
  await write(row.workspaceId, async (tx, changed) => {
    await tx.insert(messageVersion).values({ messageId: message.id, body: message.body });
    await tx
      .update(channelMessage)
      .set({ body, plain: plainText(body), editedAt: new Date(), rev: changed.rev })
      .where(eq(channelMessage.id, message.id));
    changed.message(message.id);
    const unnamed = dropped.length
      ? await tx
          .delete(messageMention)
          .where(and(eq(messageMention.messageId, message.id), inArray(messageMention.userId, dropped), eq(messageMention.broadcast, false)))
          .returning({ userId: messageMention.userId })
      : [];
    const { inside } = await namedIn(tx, row.id, added);
    const named = inside.length
      ? await tx
          .insert(messageMention)
          .values(inside.map((uid) => ({ messageId: message.id, userId: uid, workspaceId: row.workspaceId })))
          .onConflictDoNothing()
          .returning({ userId: messageMention.userId })
      : [];
    // Their counts of unread mentions follow: one named now has it to read, one no longer named doesn't.
    const recount = [...unnamed, ...named].map((r) => r.userId);
    if (recount.length) await recountMentions(tx, changed, row.id, recount, message.threadId, message.alsoInChannel);
  });
  // The cards follow the words: new links get theirs, and links taken out take theirs along.
  if (message.data?.previews?.length) void previewMessageLinks(message.id);
  else previewSoon(message.id, body);
}

/** Earlier words of a message, oldest first, for anyone who may read it. */
export async function messageHistory(userId: string, messageId: unknown) {
  const { message } = await messageFor(userId, messageId);
  const versions = await db
    .select({ body: messageVersion.body, replacedAt: messageVersion.replacedAt })
    .from(messageVersion)
    .where(eq(messageVersion.messageId, message.id))
    .orderBy(asc(messageVersion.replacedAt));
  return versions.map((v) => ({ body: v.body, replacedAt: v.replacedAt.toISOString() }));
}

/**
 * Deletes a message: its writer, an admin of the channel or a workspace owner. The row stays,
 * emptied (a thread under it stays too); its words, files, reactions and history go, unless a legal
 * hold keeps its writer's words.
 */
export async function deleteMessage(userId: string, messageId: unknown): Promise<void> {
  const { message, channel: row, member, role } = await messageFor(userId, messageId);
  if (message.deletedAt) return;
  const own = message.authorId === userId;
  if (!own && member?.role !== "admin" && role !== "owner") throw new MessageError("notAllowed");
  if (message.authorId && (await heldUserIds(row.workspaceId)).includes(message.authorId)) throw new MessageError("held");
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .update(channelMessage)
      .set({ body: "", plain: "", data: null, deletedAt: new Date(), pinnedAt: null, pinnedBy: null, rev: changed.rev })
      .where(eq(channelMessage.id, message.id));
    changed.message(message.id);
    changed.channel(row.id);
    await tx.delete(messageReaction).where(eq(messageReaction.messageId, message.id));
    await tx.delete(messageVersion).where(eq(messageVersion.messageId, message.id));
    // A poll goes with its votes.
    await tx.delete(messagePollVote).where(eq(messagePollVote.messageId, message.id));
    await tx.delete(messagePoll).where(eq(messagePoll.messageId, message.id));
    // Its files lose their message; the cleanup deletes them (files.ts purgeOrphanFiles).
    await tx.delete(messageFile).where(eq(messageFile.messageId, message.id));
    // Those it named no longer have it to read.
    const named = await tx.delete(messageMention).where(eq(messageMention.messageId, message.id)).returning({ userId: messageMention.userId });
    if (named.length) await recountMentions(tx, changed, row.id, named.map((n) => n.userId), message.threadId, message.alsoInChannel);
    if (message.threadId) {
      await tx
        .update(channelMessage)
        .set({ replyCount: sql`greatest(${channelMessage.replyCount} - 1, 0)`, rev: changed.rev })
        .where(eq(channelMessage.id, message.threadId));
      changed.message(message.threadId);
    }
  });
}

/** Recounts the unread mentions of these people in the channel's main list (or a thread). */
async function recountMentions(tx: Tx, changed: Changed, channelId: string, userIds: string[], threadId: string | null, alsoInChannel: boolean) {
  if (!userIds.length) return;
  if (threadId) {
    const rows = await tx
      .update(messageThread)
      .set({
        mentions: sql`(select count(*)::int from ${messageMention} mm join ${channelMessage} m on m.id = mm.message_id
          where mm.user_id = ${messageThread.userId} and m.thread_id = ${threadId} and m.seq > ${messageThread.lastReadSeq} and m.deleted_at is null)`,
        rev: changed.rev,
      })
      .where(and(eq(messageThread.threadId, threadId), inArray(messageThread.userId, userIds)))
      .returning({ userId: messageThread.userId });
    for (const r of rows) changed.thread(threadId, r.userId);
    // A reply only in its thread leaves the channel's own counts as they were.
    if (!alsoInChannel) return;
  }
  const rows = await tx
    .update(channelMember)
    .set({ mentions: unreadMentions(channelId), rev: changed.rev })
    .where(and(eq(channelMember.channelId, channelId), inArray(channelMember.userId, userIds)))
    .returning({ userId: channelMember.userId });
  for (const r of rows) changed.member(channelId, r.userId);
}

/** SQL: the member's unread mentions in the channel's main list, after their `last_read_seq` (on a `channel_member` update). */
const unreadMentions = (channelId: string) => sql`(select count(*)::int from ${messageMention} mm join ${channelMessage} m on m.id = mm.message_id
  where mm.user_id = ${channelMember.userId} and m.channel_id = ${channelId} and m.seq > ${channelMember.lastReadSeq}
  and (m.thread_id is null or m.also_in_channel) and m.deleted_at is null)`;

/** Adds or takes back the person's emoji on a message. */
export async function react(userId: string, messageId: unknown, emoji: unknown, on: unknown): Promise<void> {
  if (!isEmoji(emoji)) throw new MessageError("invalid");
  const { message, channel: row, member } = await messageFor(userId, messageId);
  if (!member) throw new MessageError("notMember");
  if (row.archivedAt) throw new MessageError("archived");
  if (message.deletedAt || message.kind !== "message") throw new MessageError("notFound");
  await write(row.workspaceId, async (tx, changed) => {
    if (on === false) {
      const gone = await tx
        .delete(messageReaction)
        .where(and(eq(messageReaction.messageId, message.id), eq(messageReaction.userId, userId), eq(messageReaction.emoji, emoji)))
        .returning({ emoji: messageReaction.emoji });
      if (!gone.length) return;
    } else {
      const [{ kinds }] = await tx
        .select({ kinds: sql<number>`count(distinct ${messageReaction.emoji})::int` })
        .from(messageReaction)
        .where(and(eq(messageReaction.messageId, message.id), sql`${messageReaction.emoji} <> ${emoji}`));
      if (kinds >= MESSAGE_LIMITS.reactions) throw new MessageError("tooMany");
      const added = await tx.insert(messageReaction).values({ messageId: message.id, userId, emoji }).onConflictDoNothing().returning({ emoji: messageReaction.emoji });
      if (!added.length) return;
    }
    await tx.update(channelMessage).set({ rev: changed.rev }).where(eq(channelMessage.id, message.id));
    changed.message(message.id);
  });
}

/** Pins a message to its channel, or unpins it: anyone in the channel. */
export async function pin(userId: string, messageId: unknown, on: boolean): Promise<void> {
  const { message, channel: row, member } = await messageFor(userId, messageId, "write");
  if (!member) throw new MessageError("notMember");
  if (message.deletedAt || message.kind !== "message") throw new MessageError("notFound");
  if (Boolean(message.pinnedAt) === on) return;
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .update(channelMessage)
      .set({ pinnedAt: on ? new Date() : null, pinnedBy: on ? userId : null, rev: changed.rev })
      .where(eq(channelMessage.id, message.id));
    changed.message(message.id);
  });
}

/** The channel's pinned messages, newest pin first. */
export async function pinnedMessages(userId: string, channelId: unknown): Promise<MessageView[]> {
  const { channel: row } = await requireChannel(userId, String(channelId ?? ""));
  const views = await messageViews(and(eq(channelMessage.channelId, row.id), sql`${channelMessage.pinnedAt} is not null`), { viewer: userId });
  return views.sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
}

/** Marks the channel read up to `seq` (never back: `markUnread` does that). */
export async function markRead(userId: string, channelId: unknown, seq: unknown): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, String(channelId ?? ""));
  if (!member) return;
  const upTo = Math.min(Number.isInteger(seq) ? (seq as number) : row.lastSeq, row.lastSeq);
  if (upTo <= member.lastReadSeq && !member.mentions) return;
  await setRead(row.workspaceId, row.id, userId, Math.max(upTo, member.lastReadSeq));
}

/** Marks the channel unread from the message with `seq` on. */
export async function markUnread(userId: string, channelId: unknown, seq: unknown): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, String(channelId ?? ""));
  if (!member) throw new MessageError("notMember");
  if (!Number.isInteger(seq) || (seq as number) < 1) throw new MessageError("invalid");
  await setRead(row.workspaceId, row.id, userId, (seq as number) - 1);
}

async function setRead(workspaceId: string, channelId: string, userId: string, seq: number) {
  await write(workspaceId, async (tx, changed) => {
    await tx
      .update(channelMember)
      .set({ lastReadSeq: seq, rev: changed.rev })
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)));
    await tx
      .update(channelMember)
      .set({ mentions: unreadMentions(channelId) })
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)));
    changed.member(channelId, userId);
    changed.read(channelId, userId, seq);
  });
}

/** Marks every channel and thread the person is in read. */
export async function markAllRead(userId: string, workspaceId: string): Promise<void> {
  await write(workspaceId, async (tx, changed) => {
    const members = await tx
      .update(channelMember)
      .set({ lastReadSeq: sql`(select c.last_seq from channel c where c.id = ${channelMember.channelId})`, mentions: 0, rev: changed.rev })
      .where(and(eq(channelMember.userId, userId), eq(channelMember.workspaceId, workspaceId), sql`${channelMember.lastReadSeq} < (select c.last_seq from channel c where c.id = ${channelMember.channelId})`))
      .returning({ channelId: channelMember.channelId });
    for (const m of members) changed.member(m.channelId, userId);
    const threads = await tx
      .update(messageThread)
      .set({ lastReadSeq: sql`(select m.last_reply_seq from channel_message m where m.id = ${messageThread.threadId})`, mentions: 0, rev: changed.rev })
      .where(and(eq(messageThread.userId, userId), eq(messageThread.workspaceId, workspaceId), sql`${messageThread.lastReadSeq} < (select m.last_reply_seq from channel_message m where m.id = ${messageThread.threadId})`))
      .returning({ threadId: messageThread.threadId });
    for (const t of threads) changed.thread(t.threadId, userId);
  });
}

/** Marks a thread read up to `seq`, keeping whether the person follows it. */
export async function readThread(userId: string, threadId: unknown, seq: unknown): Promise<void> {
  const { message: root, channel: row } = await messageFor(userId, threadId);
  if (root.threadId) throw new MessageError("invalid");
  const upTo = Math.min(Number.isInteger(seq) ? (seq as number) : root.lastReplySeq, root.lastReplySeq);
  const [mine] = await db
    .select()
    .from(messageThread)
    .where(and(eq(messageThread.threadId, root.id), eq(messageThread.userId, userId)));
  if (!mine || (upTo <= mine.lastReadSeq && !mine.mentions)) return;
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .update(messageThread)
      .set({ lastReadSeq: Math.max(upTo, mine.lastReadSeq), rev: changed.rev })
      .where(and(eq(messageThread.threadId, root.id), eq(messageThread.userId, userId)));
    await tx
      .update(messageThread)
      .set({
        mentions: sql`(select count(*)::int from ${messageMention} mm join ${channelMessage} m on m.id = mm.message_id
          where mm.user_id = ${userId} and m.thread_id = ${root.id} and m.seq > ${messageThread.lastReadSeq} and m.deleted_at is null)`,
      })
      .where(and(eq(messageThread.threadId, root.id), eq(messageThread.userId, userId)));
    changed.thread(root.id, userId);
  });
}

/** Follows a thread (its replies come to the person's Threads and notify them) or stops. */
export async function followThread(userId: string, threadId: unknown, following: unknown): Promise<void> {
  const { message: root, channel: row, member } = await messageFor(userId, threadId);
  if (root.threadId || root.kind !== "message") throw new MessageError("invalid");
  if (!member) throw new MessageError("notMember");
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .insert(messageThread)
      .values({ threadId: root.id, userId, channelId: row.id, workspaceId: row.workspaceId, following: following !== false, lastReadSeq: root.lastReplySeq, lastReplyAt: root.lastReplyAt, rev: changed.rev })
      .onConflictDoUpdate({ target: [messageThread.threadId, messageThread.userId], set: { following: following !== false, rev: changed.rev } });
    changed.thread(root.id, userId);
  });
}

/**
 * A page of the channel's main list: the `limit` messages before `before` (a seq), after `after`,
 * around the message `around` (or the first unread with "unread"), or the latest.
 */
export async function channelHistory(
  userId: string,
  input: { channelId?: unknown; before?: unknown; after?: unknown; around?: unknown; limit?: unknown },
): Promise<{ messages: MessageView[]; hasBefore: boolean; hasAfter: boolean }> {
  const { channel: row, member } = await requireChannel(userId, String(input.channelId ?? ""));
  const limit = Math.min(Math.max(Number(input.limit) || MESSAGE_LIMITS.page, 1), 100);
  const main = and(eq(channelMessage.channelId, row.id), or(isNull(channelMessage.threadId), eq(channelMessage.alsoInChannel, true)));
  const page = async (where: SQL | undefined, order: "asc" | "desc", n: number) => messageViews(and(main, where), { order, limit: n, viewer: userId });

  let anchor: number | null = null;
  if (input.around === "unread") anchor = member && member.lastReadSeq < row.lastSeq ? member.lastReadSeq + 1 : null;
  else if (typeof input.around === "string") {
    const [m] = await db
      .select({ seq: channelMessage.seq, threadId: channelMessage.threadId, also: channelMessage.alsoInChannel })
      .from(channelMessage)
      .where(and(eq(channelMessage.id, input.around), eq(channelMessage.channelId, row.id)));
    if (!m) throw new MessageError("notFound");
    // A reply shows in the main list through its thread's first message.
    if (m.threadId && !m.also) {
      const [r] = await db.select({ seq: channelMessage.seq }).from(channelMessage).where(eq(channelMessage.id, m.threadId));
      anchor = r?.seq ?? m.seq;
    } else anchor = m.seq;
  }

  if (anchor !== null) {
    const half = Math.floor(limit / 2);
    const before = await page(lt(channelMessage.seq, anchor), "desc", half + 1);
    const after = await page(sql`${channelMessage.seq} >= ${anchor}`, "asc", limit - half + 1);
    return {
      messages: [...before.slice(0, half).reverse(), ...after.slice(0, limit - half)],
      hasBefore: before.length > half,
      hasAfter: after.length > limit - half,
    };
  }
  if (Number.isInteger(input.after)) {
    const rows = await page(gt(channelMessage.seq, input.after as number), "asc", limit + 1);
    return { messages: rows.slice(0, limit), hasBefore: true, hasAfter: rows.length > limit };
  }
  const before = Number.isInteger(input.before) ? lt(channelMessage.seq, input.before as number) : undefined;
  const rows = await page(before, "desc", limit + 1);
  return { messages: rows.slice(0, limit).reverse(), hasBefore: rows.length > limit, hasAfter: before !== undefined };
}

/** A thread: its first message and its replies, oldest first. */
export async function threadMessages(userId: string, threadId: unknown): Promise<{ root: MessageView; replies: MessageView[] }> {
  const { message } = await messageFor(userId, threadId);
  if (message.threadId) throw new MessageError("invalid");
  const [root] = await withExtras([message], userId);
  const replies = await messageViews(eq(channelMessage.threadId, message.id), { limit: 2000, viewer: userId });
  return { root, replies };
}

/** Messages by id that the person may read (a saved list, an Activity list), in any order. */
export async function messagesById(userId: string, ids: unknown): Promise<MessageView[]> {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== "string")) throw new MessageError("invalid");
  if (!ids.length) return [];
  const views = await messageViews(inArray(channelMessage.id, ids as string[]), { viewer: userId });
  const allowed = new Set<string>();
  for (const channelId of new Set(views.map((v) => v.channelId))) {
    try {
      await requireChannel(userId, channelId);
      allowed.add(channelId);
    } catch {
      // Not theirs to read.
    }
  }
  return views.filter((v) => allowed.has(v.channelId));
}

/** Keeps a message for later (with an optional reminder), marks it done or lets it go. */
export async function saveForLater(userId: string, messageId: unknown, input: { saved?: unknown; remindAt?: unknown; done?: unknown }): Promise<void> {
  const { message, channel: row } = await messageFor(userId, messageId);
  await write(row.workspaceId, async (tx, changed) => {
    if (input.saved === false) {
      const gone = await tx
        .delete(savedMessage)
        .where(and(eq(savedMessage.userId, userId), eq(savedMessage.messageId, message.id)))
        .returning({ id: savedMessage.messageId });
      if (gone.length) changed.savedGone(userId, message.id);
      return;
    }
    let remindAt: Date | null | undefined;
    if (input.remindAt === null) remindAt = null;
    else if (typeof input.remindAt === "string") {
      remindAt = new Date(input.remindAt);
      if (Number.isNaN(remindAt.getTime())) throw new MessageError("invalid");
    }
    const doneAt = input.done === true ? new Date() : input.done === false ? null : undefined;
    const set = { rev: changed.rev, ...(remindAt !== undefined && { remindAt, remindedAt: null }), ...(doneAt !== undefined && { doneAt }) };
    await tx
      .insert(savedMessage)
      .values({ userId, messageId: message.id, workspaceId: row.workspaceId, remindAt: remindAt ?? null, doneAt: doneAt ?? null, rev: changed.rev })
      .onConflictDoUpdate({ target: [savedMessage.userId, savedMessage.messageId], set });
    changed.saved(userId, message.id);
  });
}

/** Keeps (or with no words and files, drops) what the person is writing in a channel or thread. */
export async function saveDraft(userId: string, input: { channelId?: unknown; threadId?: unknown; body?: unknown; fileIds?: unknown }): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, String(input.channelId ?? ""));
  if (!member) return;
  const threadId = typeof input.threadId === "string" ? input.threadId : "";
  const body = bodyOf(input.body ?? "");
  const fileIds = fileIdsOf(input.fileIds);
  await write(row.workspaceId, async (tx, changed) => {
    if (!hasWords(body) && !fileIds.length) {
      const gone = await tx
        .delete(messageDraft)
        .where(and(eq(messageDraft.userId, userId), eq(messageDraft.channelId, row.id), eq(messageDraft.threadId, threadId)))
        .returning({ userId: messageDraft.userId });
      if (gone.length) changed.draftGone(userId, row.id, threadId);
      return;
    }
    const now = new Date();
    await tx
      .insert(messageDraft)
      .values({ userId, channelId: row.id, threadId, workspaceId: row.workspaceId, body, fileIds, updatedAt: now, rev: changed.rev })
      .onConflictDoUpdate({ target: [messageDraft.userId, messageDraft.channelId, messageDraft.threadId], set: { body, fileIds, updatedAt: now, rev: changed.rev } });
    changed.draft(userId, row.id, threadId);
  });
}

/** The person's mentions in the workspace, newest first: the Activity list. */
export async function mentionsOf(userId: string, workspaceId: string, before?: unknown): Promise<MessageView[]> {
  const rows = await db
    .select({ id: messageMention.messageId })
    .from(messageMention)
    .where(and(eq(messageMention.userId, userId), eq(messageMention.workspaceId, workspaceId), typeof before === "string" ? lt(messageMention.createdAt, new Date(before)) : undefined))
    .orderBy(desc(messageMention.createdAt))
    .limit(50);
  const views = await messagesById(
    userId,
    rows.map((r) => r.id),
  );
  return views.filter((v) => !v.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Reactions others left on the person's messages lately, newest first. */
export async function reactionsTo(userId: string, workspaceId: string) {
  const rows = await db
    .select({ messageId: messageReaction.messageId, userId: messageReaction.userId, emoji: messageReaction.emoji, createdAt: messageReaction.createdAt })
    .from(messageReaction)
    .innerJoin(channelMessage, eq(channelMessage.id, messageReaction.messageId))
    .where(and(eq(channelMessage.authorId, userId), eq(channelMessage.workspaceId, workspaceId), sql`${messageReaction.userId} <> ${userId}`))
    .orderBy(desc(messageReaction.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Forwards a message the person may read into another channel they may write in, with their own words above it. */
export async function forwardMessage(userId: string, input: { messageId?: unknown; channelId?: unknown; body?: unknown; id?: unknown }): Promise<SendResult> {
  const { message } = await messageFor(userId, input.messageId);
  if (message.deletedAt || message.kind !== "message") throw new MessageError("notFound");
  return sendMessage(userId, {
    id: input.id,
    channelId: input.channelId,
    body: input.body ?? "",
    data: { forward: { messageId: message.id, channelId: message.channelId, authorId: message.authorId, body: message.data?.forward ? message.data.forward.body : message.body, createdAt: message.createdAt.toISOString() } },
  });
}
