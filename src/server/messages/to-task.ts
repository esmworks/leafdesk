/**
 * A message as a task on the person's own list (server/own-tasks.ts): its first words name the
 * row, and the row's page quotes the whole message under a link back to it, so My tasks lists it
 * and the task leads to the conversation it came from.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channelMessage, user } from "@/db/schema";
import { env } from "@/lib/env";
import { messagesPath } from "@/lib/messages";
import { taskTitle } from "@/lib/message-task";
import { MAX_OWN_TASK } from "@/lib/own-tasks";
import { getCollab } from "@/server/collab/bridge";
import { addOwnTask } from "@/server/own-tasks";
import { MessageError, requireChannel } from "./core";

/** Markdown's own characters taken as text, so a message reads in the page as it was written. */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>#|~]/g, "\\$&");

export async function messageToTask(userId: string, messageId: unknown): Promise<{ rowId: string; databaseId: string }> {
  if (typeof messageId !== "string" || !messageId) throw new MessageError("notFound");
  const [message] = await db.select().from(channelMessage).where(eq(channelMessage.id, messageId)).limit(1);
  if (!message) throw new MessageError("notFound");
  const { channel } = await requireChannel(userId, message.channelId, "read");
  const text = message.deletedAt || message.kind !== "message" ? "" : message.plain.trim();
  if (!text) throw new MessageError("invalid");

  const { rowId, databaseId } = await addOwnTask(userId, channel.workspaceId, { title: taskTitle(text, Math.min(120, MAX_OWN_TASK)), date: null, priority: null, people: [] });
  const [author] = message.authorId ? await db.select({ name: user.name }).from(user).where(eq(user.id, message.authorId)) : [];
  const link = `${env.appUrl}${messagesPath(channel.workspaceId, { channelId: channel.id, threadId: message.threadId, messageId: message.id })}`;
  const where = [channel.kind === "direct" ? null : `#${channel.name}`, author?.name].filter(Boolean).join(" · ");
  const quote = text
    .split("\n")
    .map((line) => `> ${escapeMarkdown(line)}`)
    .join("\n");
  await getCollab().replaceContent(rowId, `${quote}\n\n[${escapeMarkdown(where || link)}](${link})\n`, { userId });
  return { rowId, databaseId };
}
