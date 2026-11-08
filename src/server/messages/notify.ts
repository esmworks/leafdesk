/**
 * Push notifications for new messages (server/push.ts `pushToPerson`; no inbox item: the Messages
 * place keeps its own unread counts and Activity). Who is told follows each person's setting of
 * the channel (lib/messages.ts `notifyLevel`): every message of a direct conversation, mentions of
 * a channel, replies of threads they follow. Nobody is told of their own message, of a channel they
 * have open in front of them, while their quiet hours last, or as an agent.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, channelMessage, messageMention, messageStatus, messageThread, user, workspaceAgent } from "@/db/schema";
import { snippet } from "@/lib/message-text";
import { messagesPath, notifyLevel } from "@/lib/messages";
import { pushToPerson } from "@/server/push";
import { stillInWorkspace } from "./core";
import { isWatching } from "./hub";

/** Tells the people of each new message, without waiting. */
export function notifyMessages(workspaceId: string, messageIds: string[]) {
  void tell(workspaceId, messageIds).catch((error) => console.error("[messages] could not send notifications", error));
}

async function tell(workspaceId: string, messageIds: string[]) {
  for (const id of messageIds) {
    const [row] = await db
      .select({ message: channelMessage, channel, authorName: user.name })
      .from(channelMessage)
      .innerJoin(channel, eq(channel.id, channelMessage.channelId))
      .leftJoin(user, eq(user.id, channelMessage.authorId))
      .where(eq(channelMessage.id, id));
    if (!row || row.message.kind !== "message" || row.message.deletedAt) continue;
    const { message, channel: place } = row;
    // Only those still in the workspace: leaving it keeps one's channel rows (and direct
    // conversations, for when they come back), never their notifications.
    const members = await db
      .select()
      .from(channelMember)
      .where(and(eq(channelMember.channelId, place.id), stillInWorkspace(sql`${channelMember.userId}`, sql`${channelMember.workspaceId}`)));
    const named = new Map(
      (await db.select({ userId: messageMention.userId, broadcast: messageMention.broadcast }).from(messageMention).where(eq(messageMention.messageId, id))).map((m) => [m.userId, m.broadcast]),
    );
    const followers = message.threadId
      ? new Set(
          (
            await db
              .select({ userId: messageThread.userId })
              .from(messageThread)
              .where(and(eq(messageThread.threadId, message.threadId), eq(messageThread.following, true)))
          ).map((f) => f.userId),
        )
      : new Set<string>();
    const shown = !message.threadId || message.alsoInChannel;
    const wanted = members.filter((m) => {
      if (m.userId === message.authorId) return false;
      const level = notifyLevel(m.notify, place.kind);
      if (level === "none") return false;
      const mention = named.get(m.userId);
      // Muted: only being named by name gets through.
      if (m.muted) return mention === false;
      if (mention !== undefined) return true;
      if (message.threadId && followers.has(m.userId)) return true;
      return shown && level === "all";
    });
    if (!wanted.length) continue;
    const ids = wanted.map((m) => m.userId);
    const [quiet, agents] = await Promise.all([
      db
        .select({ userId: messageStatus.userId, quietUntil: messageStatus.quietUntil, previews: messageStatus.previews })
        .from(messageStatus)
        .where(and(eq(messageStatus.workspaceId, workspaceId), inArray(messageStatus.userId, ids))),
      db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.userId, ids)),
    ]);
    const statusOf = new Map(quiet.map((q) => [q.userId, q]));
    const isAgent = new Set(agents.map((a) => a.userId));
    const now = Date.now();
    const author = row.authorName?.trim() || null;
    const words = snippet(message.body, 180);
    const files = message.body.trim() ? "" : "file";
    for (const userId of ids) {
      if (isAgent.has(userId)) continue;
      const status = statusOf.get(userId);
      if (status?.quietUntil && status.quietUntil.getTime() > now) continue;
      if (isWatching(workspaceId, userId, place.id) && !message.threadId) continue;
      const previews = status?.previews ?? true;
      pushToPerson(userId, workspaceId, (t) => {
        const who = author ?? t("someone");
        const title = place.kind === "direct" && place.directKey?.split(",").length === 2 ? who : t("messageIn", { actor: who, place: place.name ? `#${place.name}` : t("groupConversation") });
        const body = previews && words ? words : files ? t("messageFile") : t("newMessage");
        return {
          title,
          body: message.threadId ? `${t("inThread")} · ${body}` : body,
          url: messagesPath(workspaceId, { channelId: place.id, messageId: id, threadId: message.threadId ?? undefined }),
          tag: `message:${place.id}`,
          read: "",
          snooze: "",
        };
      });
    }
  }
}
