import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { channelLink, channelLinkCode } from "@/db/schema";
import { CHAT_MODES, type ChatMode } from "@/lib/ai-chat";
import { memberWorkspaceIds, signInPolicyRefusal } from "@/server/access";
import type { ChatChannel, Sender } from "./transport";
import { transportOf } from "./transports";

/**
 * Chat-app accounts linked to Leafdesk accounts. The settings make a one-time code; the bot links
 * the chat-app account that sends it (Telegram's `/start <code>`, Slack's `/leafdesk link <code>`)
 * to the code's user. An account links to one Leafdesk account at a time in each chat app, and the
 * other way round: linking again moves it.
 */

/** How long a link code works. */
export const LINK_CODE_TTL_MS = 10 * 60_000;
const LAST_USED_EVERY_MS = 3_600_000;

/** A link: where its person's next question goes, and what the chat may change. */
export type ChatLinkRow = {
  id: string;
  channel: ChatChannel;
  userId: string;
  /** The chat app's id of the person. */
  externalUserId: string;
  /** Their own chat with the bot, where answers and notifications go. */
  chatId: string;
  username: string | null;
  displayName: string;
  workspaceId: string | null;
  conversationId: string | null;
  mode: string;
  agentId: string | null;
  agentConversationId: string | null;
  notifications: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** What the settings show of a person's link. */
export type ChatLinkView = { username: string | null; displayName: string; createdAt: Date; lastUsedAt: Date | null; notifications: boolean };

const rowOf = (row: typeof channelLink.$inferSelect): ChatLinkRow => ({ ...row, channel: row.channel as ChatChannel });
const theirs = (channel: ChatChannel, userId: string) => and(eq(channelLink.channel, channel), eq(channelLink.userId, userId));

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** The person's link in a chat app, as the settings show it. */
export async function linkView(channel: ChatChannel, userId: string): Promise<ChatLinkView | null> {
  const [link] = await db.select().from(channelLink).where(theirs(channel, userId)).limit(1);
  return link ? { username: link.username, displayName: link.displayName, createdAt: link.createdAt, lastUsedAt: link.lastUsedAt, notifications: link.notifications } : null;
}

/** Whether the person's notifications go to their chat in a chat app set up here. */
export async function chatNotificationsOn(channel: ChatChannel, userId: string): Promise<boolean> {
  if (!transportOf(channel)) return false;
  const [link] = await db.select({ on: channelLink.notifications }).from(channelLink).where(theirs(channel, userId)).limit(1);
  return link?.on ?? false;
}

/** Turns sending the person's notifications to their linked chat on or off. */
export async function setChatNotifications(channel: ChatChannel, userId: string, on: boolean) {
  await db.update(channelLink).set({ notifications: on }).where(theirs(channel, userId));
}

/**
 * A new link code for the person (replacing one they had in that chat app). The linked chat
 * reaches all their workspaces outside the sign-in policies (as a connected app), so a session one
 * of them holds back can't make one: throws its WorkspacePolicyError. Telegram takes up to 64 of
 * A-Z, a-z, 0-9, _ and - after /start; the code is 32 of them.
 */
export async function createChatLinkCode(channel: ChatChannel, userId: string): Promise<{ code: string; expiresAt: Date }> {
  const refusal = await signInPolicyRefusal(userId, await memberWorkspaceIds(userId));
  if (refusal) throw refusal;
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db
    .insert(channelLinkCode)
    .values({ userId, channel, codeHash: hashCode(code), expiresAt })
    .onConflictDoUpdate({ target: [channelLinkCode.userId, channelLinkCode.channel], set: { codeHash: hashCode(code), expiresAt } });
  return { code, expiresAt };
}

/**
 * Links the chat-app account that sent a code to the code's user, its answers going to `chatId`;
 * the user's id, or null when the code is unknown or has run out. The code works once.
 */
export async function linkWithCode(channel: ChatChannel, code: string, from: Sender, chatId: string): Promise<string | null> {
  if (!/^[\w-]{1,64}$/.test(code)) return null;
  return db.transaction(async (tx) => {
    const [found] = await tx
      .delete(channelLinkCode)
      .where(and(eq(channelLinkCode.channel, channel), eq(channelLinkCode.codeHash, hashCode(code)), gt(channelLinkCode.expiresAt, new Date())))
      .returning();
    if (!found) return null;
    // Either side's earlier link in this chat app goes: one account on each side at a time.
    await tx.delete(channelLink).where(and(eq(channelLink.channel, channel), or(eq(channelLink.userId, found.userId), eq(channelLink.externalUserId, from.id))));
    await tx.insert(channelLink).values({ channel, userId: found.userId, externalUserId: from.id, chatId, username: from.username, displayName: from.name });
    return found.userId;
  });
}

/** Unlinks the person's account in a chat app, telling them there (plain text); false when none was linked. */
export async function unlinkChat(channel: ChatChannel, userId: string, notice?: string): Promise<boolean> {
  const [gone] = await db.delete(channelLink).where(theirs(channel, userId)).returning();
  await db.delete(channelLinkCode).where(and(eq(channelLinkCode.channel, channel), eq(channelLinkCode.userId, userId)));
  const transport = transportOf(channel);
  if (gone && notice && transport) await transport.send(gone.chatId, notice, { plain: true }).catch(() => {});
  return Boolean(gone);
}

/** The link of a chat-app account, in the chat it was linked from. */
export async function linkOf(channel: ChatChannel, externalUserId: string, chatId: string): Promise<ChatLinkRow | null> {
  const [found] = await db
    .select()
    .from(channelLink)
    .where(and(eq(channelLink.channel, channel), eq(channelLink.externalUserId, externalUserId), eq(channelLink.chatId, chatId)))
    .limit(1);
  return found ? rowOf(found) : null;
}

/** A link again as stored now (its notifications may have been turned off meanwhile). */
export async function linkById(linkId: string): Promise<ChatLinkRow | null> {
  const [found] = await db.select().from(channelLink).where(eq(channelLink.id, linkId)).limit(1);
  return found ? rowOf(found) : null;
}

/** The links of these people that take their notifications. */
export async function notifiedLinks(userIds: string[]): Promise<ChatLinkRow[]> {
  if (!userIds.length) return [];
  const rows = await db
    .select()
    .from(channelLink)
    .where(and(inArray(channelLink.userId, userIds), eq(channelLink.notifications, true)));
  return rows.map(rowOf);
}

/** The person's links pointed at an agent of a workspace (/agent). */
export async function linksToAgent(userId: string, workspaceId: string, agentId: string): Promise<ChatLinkRow[]> {
  const rows = await db
    .select()
    .from(channelLink)
    .where(and(eq(channelLink.userId, userId), eq(channelLink.agentId, agentId), eq(channelLink.workspaceId, workspaceId)));
  return rows.map(rowOf);
}

/** Changes where the link's next question goes (the AI chat, or an agent), or what the chat may change. */
export async function updateLink(
  linkId: string,
  set: Partial<{ workspaceId: string | null; conversationId: string | null; mode: ChatMode; agentId: string | null; agentConversationId: string | null }>,
) {
  await db.update(channelLink).set(set).where(eq(channelLink.id, linkId));
}

/** Notes that the link was used, at most once an hour. */
export async function touchLink(linkId: string) {
  const now = new Date();
  await db
    .update(channelLink)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(channelLink.id, linkId),
        or(isNull(channelLink.lastUsedAt), lt(channelLink.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS))),
      ),
    );
}

/** A stored mode as a chat mode: anything unknown is `ask`. */
export const linkMode = (value: string): ChatMode => ((CHAT_MODES as readonly string[]).includes(value) ? (value as ChatMode) : "ask");
