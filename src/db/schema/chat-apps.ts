import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { conversation } from "./ai";
import { workspaceAgent } from "./agents";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * A chat-app account (`channel`: "telegram" or "slack") linked to a Leafdesk account, so its owner
 * can talk to the AI chat from there and get their notifications there (see server/chat-apps). One
 * per user and chat app, and one per account of a chat app; it stands for its user like an API
 * token, as a connected app (connected-app.ts). Only the person's own chat with the bot counts, so
 * `chatId` is that chat (Telegram's private chat, Slack's direct message). `workspaceId` and
 * `conversationId` are where the next question goes; `mode` what the chat may change there (an AI
 * chat mode). With `agentId`, messages go to that agent of the workspace instead (its own chat
 * with the person, joining `agentConversationId`, a new conversation when null), and
 * `conversationId` waits for the person's return to the AI chat.
 */
export const channelLink = pgTable(
  "channel_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channel: text("channel").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The chat app's id of the person (Telegram's number, Slack's user id), as text. */
    externalUserId: text("external_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    /** Their username and name in the chat app when linked, to show in the settings. */
    username: text("username"),
    displayName: text("display_name").notNull().default(""),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    mode: text("mode").notNull().default("ask"),
    agentId: text("agent_id").references(() => workspaceAgent.id, { onDelete: "set null" }),
    agentConversationId: text("agent_conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    /**
     * Inbox notifications go to the chat too (which kinds: user_preference's `…Telegram` columns,
     * which hold for every chat app).
     */
    notifications: boolean("notifications").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Updated at most once an hour. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("channel_link_user_channel_idx").on(t.userId, t.channel),
    uniqueIndex("channel_link_external_user_idx").on(t.channel, t.externalUserId),
    index("channel_link_workspace_idx").on(t.workspaceId),
    index("channel_link_conversation_idx").on(t.conversationId),
    index("channel_link_agent_idx").on(t.agentId),
    index("channel_link_agent_conversation_idx").on(t.agentConversationId),
  ],
);

/**
 * A one-time code that links a chat-app account to its user: the settings make one, and the bot
 * links the account that sends it (Telegram's `/start <code>`, Slack's `/leafdesk link <code>`).
 * One per user and chat app, replaced by a new one; it works for LINK_CODE_TTL_MS. Only a SHA-256
 * hash of the code is kept.
 */
export const channelLinkCode = pgTable(
  "channel_link_code",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** Hex SHA-256 of the code. */
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);
