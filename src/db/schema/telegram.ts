import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { aiConversation } from "./ai";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * A Telegram account linked to a Leafdesk account, so its owner can talk to the AI chat from
 * Telegram and get their notifications there (see server/telegram). One per user and one per Telegram account; it stands for its
 * user like an API token, as a connected app (connected-app.ts). Only private chats with the bot
 * count, so `chatId` is the person's own chat with it. `workspaceId` and `conversationId` are where
 * the next question goes; `mode` what the chat may change there (an AI chat mode).
 */
export const telegramLink = pgTable(
  "telegram_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Telegram's id of the person (a number, kept as text: it may outgrow 2^53 one day). */
    telegramUserId: text("telegram_user_id").notNull().unique(),
    chatId: text("chat_id").notNull(),
    /** Their @username and name in Telegram when linked, to show in the settings. */
    username: text("username"),
    displayName: text("display_name").notNull().default(""),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => aiConversation.id, { onDelete: "set null" }),
    mode: text("mode").notNull().default("ask"),
    /** Inbox notifications go to the chat too (which kinds: user_preference's `…Telegram` columns). */
    notifications: boolean("notifications").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Updated at most once an hour. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("telegram_link_workspace_idx").on(t.workspaceId), index("telegram_link_conversation_idx").on(t.conversationId)],
);

/**
 * A one-time code that links a Telegram account to its user: the settings make one and open the
 * bot with it (`/start <code>`). One per user, replaced by a new one; it works for
 * LINK_CODE_TTL_MS. Only a SHA-256 hash of the code is kept.
 */
export const telegramLinkCode = pgTable("telegram_link_code", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Hex SHA-256 of the code. */
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
