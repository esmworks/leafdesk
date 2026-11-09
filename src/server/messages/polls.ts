/**
 * Polls in channels, direct conversations and threads: sent as a message (posts.ts `sendMessage`
 * with `poll`), voted on and closed here. Each change is one `write`, which moves the message's
 * `rev` so announce.ts sends it live and sync.ts catches a reconnect up; the counts and voters
 * ride on the message's view (views.ts), each person's own choices in its `mine`.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { channelMessage, messagePoll, messagePollVote } from "@/db/schema";
import { pollClosed, readPollInput } from "@/lib/message-polls";
import { MessageError, requireChannel, write, type ChannelAccess } from "./core";
import { sendMessage, type SendResult } from "./posts";

type PollRow = typeof messagePoll.$inferSelect;
type MessageRow = typeof channelMessage.$inferSelect;

/** Sends a poll as the person, where they may write: its question is the message's text. */
export async function sendPoll(
  userId: string,
  input: { id?: unknown; channelId?: unknown; threadId?: unknown; alsoInChannel?: unknown; poll?: unknown },
): Promise<SendResult> {
  const poll = readPollInput(input.poll);
  if (typeof poll === "string") throw new MessageError("invalid", poll);
  return sendMessage(userId, { id: input.id, channelId: input.channelId, threadId: input.threadId, alsoInChannel: input.alsoInChannel, poll });
}

/** The poll on a message the person may read, with the message and their place in its channel. */
async function pollFor(userId: string, messageId: unknown): Promise<{ poll: PollRow; message: MessageRow } & ChannelAccess> {
  if (typeof messageId !== "string" || !messageId) throw new MessageError("notFound");
  const [found] = await db
    .select({ poll: messagePoll, message: channelMessage })
    .from(messagePoll)
    .innerJoin(channelMessage, eq(channelMessage.id, messagePoll.messageId))
    .where(eq(messagePoll.messageId, messageId))
    .limit(1);
  if (!found || found.message.deletedAt) throw new MessageError("notFound");
  const access = await requireChannel(userId, found.message.channelId);
  return { ...found, ...access };
}

const closedNow = (poll: PollRow) => pollClosed({ closesAt: poll.closesAt?.toISOString() ?? null, closedAt: poll.closedAt?.toISOString() ?? null });

/**
 * Chooses an option of a poll (`on`), or takes the choice back: anyone in the channel, guests
 * too, even where only admins post. One choice replaces the person's other unless the poll takes
 * several. A closed poll, or one past its time, takes none.
 */
export async function votePoll(userId: string, messageId: unknown, optionId: unknown, on: unknown): Promise<void> {
  if (typeof optionId !== "string" || !optionId) throw new MessageError("invalid");
  const { poll, message, channel: row, member } = await pollFor(userId, messageId);
  if (!member) throw new MessageError("notMember");
  if (row.archivedAt) throw new MessageError("archived");
  if (!poll.options.some((o) => o.id === optionId)) throw new MessageError("invalid");
  await write(row.workspaceId, async (tx, changed) => {
    // Read again in the write: the workspace's writes run one at a time, so a close can't slip in between.
    const [now] = await tx.select().from(messagePoll).where(eq(messagePoll.messageId, message.id)).limit(1);
    if (!now) throw new MessageError("notFound");
    if (closedNow(now)) throw new MessageError("pollClosed");
    if (on === false) {
      const gone = await tx
        .delete(messagePollVote)
        .where(and(eq(messagePollVote.messageId, message.id), eq(messagePollVote.userId, userId), eq(messagePollVote.optionId, optionId)))
        .returning({ optionId: messagePollVote.optionId });
      if (!gone.length) return;
    } else {
      const replaced = now.multiple
        ? []
        : await tx
            .delete(messagePollVote)
            .where(and(eq(messagePollVote.messageId, message.id), eq(messagePollVote.userId, userId), ne(messagePollVote.optionId, optionId)))
            .returning({ optionId: messagePollVote.optionId });
      const added = await tx.insert(messagePollVote).values({ messageId: message.id, optionId, userId }).onConflictDoNothing().returning({ optionId: messagePollVote.optionId });
      if (!added.length && !replaced.length) return;
    }
    await tx.update(channelMessage).set({ rev: changed.rev }).where(eq(channelMessage.id, message.id));
    changed.message(message.id);
  });
}

/**
 * Closes a poll for good: its writer, or whoever may delete others' messages in the channel (its
 * admins, the workspace's owners), as for deleting it. A closed poll keeps its votes and shows them.
 */
export async function closePoll(userId: string, messageId: unknown): Promise<void> {
  const { poll, message, channel: row, member, role } = await pollFor(userId, messageId);
  if (message.authorId !== userId && member?.role !== "admin" && role !== "owner") throw new MessageError("notAllowed");
  if (row.archivedAt) throw new MessageError("archived");
  if (poll.closedAt) return;
  await write(row.workspaceId, async (tx, changed) => {
    const closed = await tx
      .update(messagePoll)
      .set({ closedAt: new Date(), closedBy: userId })
      .where(and(eq(messagePoll.messageId, message.id), isNull(messagePoll.closedAt)))
      .returning({ id: messagePoll.messageId });
    if (!closed.length) return;
    await tx.update(channelMessage).set({ rev: changed.rev }).where(eq(channelMessage.id, message.id));
    changed.message(message.id);
  });
}
