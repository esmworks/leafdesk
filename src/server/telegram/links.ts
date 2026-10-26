import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { telegramLink, telegramLinkCode } from "@/db/schema";
import { CHAT_MODES, type ChatMode } from "@/lib/ai-chat";
import { env } from "@/lib/env";
import { memberWorkspaceIds, signInPolicyRefusal } from "@/server/access";
import { callApi, sendMessage, type TelegramUser } from "./api";

/**
 * Telegram accounts linked to Leafdesk accounts (telegram_link). The settings make a one-time code
 * and open the bot with it; the bot links the Telegram account that sends `/start <code>` to the
 * code's user. A Telegram account links to one Leafdesk account at a time, and the other way
 * round: linking again moves it.
 */

/** How long a link code works. */
export const LINK_CODE_TTL_MS = 10 * 60_000;
const LAST_USED_EVERY_MS = 3_600_000;

/** What the settings show: whether the server has a bot, its name, and the person's link. */
export type TelegramStatus = {
  enabled: boolean;
  bot: string | null;
  link: { username: string | null; displayName: string; createdAt: Date; lastUsedAt: Date | null; notifications: boolean } | null;
};

export type TelegramLinkRow = typeof telegramLink.$inferSelect;

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** The bot's @username, asked of Telegram once per process (and again after a failure). */
let botName: Promise<string> | null = null;
export function botUsername(): Promise<string> {
  botName ??= callApi<TelegramUser>("getMe").then(
    (me) => me.username ?? "",
    (error) => {
      botName = null;
      throw error;
    },
  );
  return botName;
}

export async function getTelegramStatus(userId: string): Promise<TelegramStatus> {
  if (!env.telegramBotToken) return { enabled: false, bot: null, link: null };
  const [[link], bot] = await Promise.all([
    db.select().from(telegramLink).where(eq(telegramLink.userId, userId)).limit(1),
    botUsername().catch(() => null),
  ]);
  return {
    enabled: true,
    bot,
    link: link
      ? { username: link.username, displayName: link.displayName, createdAt: link.createdAt, lastUsedAt: link.lastUsedAt, notifications: link.notifications }
      : null,
  };
}

/** Whether the person's notifications go to a Telegram chat they linked (see notify.ts). */
export async function telegramNotificationsOn(userId: string): Promise<boolean> {
  if (!env.telegramBotToken) return false;
  const [link] = await db.select({ on: telegramLink.notifications }).from(telegramLink).where(eq(telegramLink.userId, userId)).limit(1);
  return link?.on ?? false;
}

/** Turns sending the person's notifications to their linked Telegram chat on or off. */
export async function setTelegramNotifications(userId: string, on: boolean) {
  await db.update(telegramLink).set({ notifications: on }).where(eq(telegramLink.userId, userId));
}

/**
 * A new link code for the person (replacing one they had), and the address that opens the bot
 * with it. The linked chat reaches all their workspaces outside the sign-in policies (as a connected
 * app), so a session one of them holds back can't make one: throws its WorkspacePolicyError.
 */
export async function createLinkCode(userId: string): Promise<{ url: string; expiresAt: Date }> {
  if (!env.telegramBotToken) throw new Error("Telegram is not set up on this server");
  const refusal = await signInPolicyRefusal(userId, await memberWorkspaceIds(userId));
  if (refusal) throw refusal;
  const bot = await botUsername();
  // Telegram takes up to 64 of A-Z, a-z, 0-9, _ and - after /start.
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db
    .insert(telegramLinkCode)
    .values({ userId, codeHash: hashCode(code), expiresAt })
    .onConflictDoUpdate({ target: telegramLinkCode.userId, set: { codeHash: hashCode(code), expiresAt } });
  return { url: `https://t.me/${bot}?start=${code}`, expiresAt };
}

/**
 * Links the Telegram account that sent a code to the code's user; the user's id, or null when the
 * code is unknown or has run out. The code works once.
 */
export async function linkWithCode(code: string, from: TelegramUser, chatId: number): Promise<string | null> {
  if (!/^[\w-]{1,64}$/.test(code)) return null;
  return db.transaction(async (tx) => {
    const [found] = await tx
      .delete(telegramLinkCode)
      .where(and(eq(telegramLinkCode.codeHash, hashCode(code)), gt(telegramLinkCode.expiresAt, new Date())))
      .returning();
    if (!found) return null;
    const telegramUserId = String(from.id);
    // Either side's earlier link goes: one account on each side at a time.
    await tx.delete(telegramLink).where(or(eq(telegramLink.userId, found.userId), eq(telegramLink.telegramUserId, telegramUserId)));
    await tx.insert(telegramLink).values({
      userId: found.userId,
      telegramUserId,
      chatId: String(chatId),
      username: from.username ?? null,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    });
    return found.userId;
  });
}

/** Unlinks the person's Telegram account, telling them there; false when none was linked. */
export async function unlinkTelegram(userId: string, notice?: string): Promise<boolean> {
  const [gone] = await db.delete(telegramLink).where(eq(telegramLink.userId, userId)).returning();
  await db.delete(telegramLinkCode).where(eq(telegramLinkCode.userId, userId));
  if (gone && notice) await sendMessage(gone.chatId, notice, { plain: true }).catch(() => {});
  return Boolean(gone);
}

/** The link of a Telegram account, in the chat it was linked from. */
export async function linkOf(telegramUserId: number, chatId: number): Promise<TelegramLinkRow | null> {
  const [found] = await db
    .select()
    .from(telegramLink)
    .where(and(eq(telegramLink.telegramUserId, String(telegramUserId)), eq(telegramLink.chatId, String(chatId))))
    .limit(1);
  return found ?? null;
}

/** Changes where the link's next question goes, or what the chat may change. */
export async function updateLink(
  linkId: string,
  set: Partial<{ workspaceId: string | null; conversationId: string | null; mode: ChatMode }>,
) {
  await db.update(telegramLink).set(set).where(eq(telegramLink.id, linkId));
}

/** Notes that the link was used, at most once an hour. */
export async function touchLink(linkId: string) {
  const now = new Date();
  await db
    .update(telegramLink)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(telegramLink.id, linkId),
        or(isNull(telegramLink.lastUsedAt), lt(telegramLink.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS))),
      ),
    );
}

/** A stored mode as a chat mode: anything unknown is `ask`. */
export const linkMode = (value: string): ChatMode => ((CHAT_MODES as readonly string[]).includes(value) ? (value as ChatMode) : "ask");
