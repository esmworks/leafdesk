import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ChannelKind, ChannelNotify, MessageData, PostingPolicy } from "../../lib/messages";
import type { PollOption } from "../../lib/message-polls";
import { file } from "./files";
import { tsvector, workspace } from "./app";
import { user } from "./auth";

/**
 * Messages (server/messages/): a workspace's channels and direct conversations, their messages,
 * threads, reactions and what each person has read. Everything a client keeps a copy of carries a
 * `rev` from the workspace's clock (`message_clock`), so a client back from a lost connection asks
 * for what changed since the last `rev` it saw (`sync`) instead of loading everything again. Each
 * write takes the next `rev` by updating the clock row first, which holds the row until it commits:
 * the writes of a workspace commit in the order of their revs, so a reader never sees rev 12 while
 * rev 11 is still on its way.
 */
export const messageClock = pgTable("message_clock", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  rev: bigint("rev", { mode: "number" }).notNull().default(0),
});

/**
 * A channel (`public`: every member of the workspace may find, read and join it; `private`: only
 * its members know it) or a direct conversation (`direct`: one to eight people, the person alone
 * for notes to themselves). A direct conversation has no name and a fixed set of people, its
 * `directKey` (their ids sorted, joined by commas), so the same people always meet in the same one.
 * `lastSeq` is the number of the channel's last message, replies included (`channel_message.seq`).
 */
export const channel = pgTable(
  "channel",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChannelKind>().notNull(),
    /** A channel's name, lowercase words joined by `-` (lib/messages.ts `channelNameError`); null for direct conversations. */
    name: text("name"),
    /** One line shown in the channel's head. */
    topic: text("topic").notNull().default(""),
    /** What the channel is for, shown in its details. */
    description: text("description").notNull().default(""),
    directKey: text("direct_key"),
    /** Who may write at the top level: everyone, or its admins only (announcements; anyone may still reply in threads). */
    posting: text("posting").$type<PostingPolicy>().notNull().default("everyone"),
    /** New members of the workspace join it (one or more; the first channel made is one). */
    joinNew: boolean("join_new").notNull().default(false),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by").references(() => user.id, { onDelete: "set null" }),
    lastSeq: integer("last_seq").notNull().default(0),
    /** When its last message shown in the channel came (a reply only when also sent there): the list's order. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("channel_workspace_idx").on(t.workspaceId, t.kind),
    index("channel_rev_idx").on(t.workspaceId, t.rev),
    uniqueIndex("channel_name_idx").on(t.workspaceId, t.name).where(sql`${t.kind} <> 'direct'`),
    uniqueIndex("channel_direct_key_idx").on(t.workspaceId, t.directKey).where(sql`${t.kind} = 'direct'`),
    check("channel_kind_check", sql`${t.kind} in ('public', 'private', 'direct')`),
    check("channel_posting_check", sql`${t.posting} in ('everyone', 'admins')`),
    check("channel_name_check", sql`(${t.kind} = 'direct') = (${t.name} is null) and (${t.kind} = 'direct') = (${t.directKey} is not null)`),
  ],
);

/**
 * A person in a channel, and what they have read there. `lastReadSeq` is the number of the last
 * message they have seen in the channel's main list: what comes after it is unread. `mentions`
 * counts the unread messages there that name them (or everyone in it), cleared as they read on.
 * `hidden` takes a direct conversation off their list until a new message comes.
 */
export const channelMember = pgTable(
  "channel_member",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** `admin`: renames, archives and decides who is in a private channel; whoever made it is one. */
    role: text("role").$type<"admin" | "member">().notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    mentions: integer("mentions").notNull().default(0),
    notify: text("notify").$type<ChannelNotify>().notNull().default("default"),
    muted: boolean("muted").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    /** The person's own section of their channel list it sits in (`channel_section`); null for the usual places. */
    sectionId: text("section_id"),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index("channel_member_user_idx").on(t.userId, t.workspaceId),
    index("channel_member_rev_idx").on(t.workspaceId, t.rev),
    check("channel_member_role_check", sql`${t.role} in ('admin', 'member')`),
    check("channel_member_notify_check", sql`${t.notify} in ('default', 'all', 'mentions', 'none')`),
  ],
);

/** A person's own sections of their channel list ("Clients", "Projects"), in their order. */
export const channelSection = pgTable(
  "channel_section",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    collapsed: boolean("collapsed").notNull().default(false),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("channel_section_user_idx").on(t.userId, t.workspaceId)],
);

/**
 * A message. Its `id` is the sender's (a UUID their client made), so a message sent twice over a
 * shaky connection is stored once. `seq` numbers it within its channel. A reply has `threadId`, its
 * thread's first message, and shows in the channel's main list too only with `alsoInChannel`.
 * `body` is Markdown in which people, channels and everyone are links (lib/message-text.ts);
 * `plain` is its text as people read it, for search and notifications. A deleted message keeps
 * its row, emptied, so clients learn of it and a thread under it stays.
 */
export const channelMessage = pgTable(
  "channel_message",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    threadId: text("thread_id"),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    /** `message` from a person (or an agent); `system`: what happened in the channel (joined, renamed …), its words in `data`. */
    kind: text("kind").$type<"message" | "system">().notNull().default("message"),
    body: text("body").notNull().default(""),
    plain: text("plain").notNull().default(""),
    data: jsonb("data").$type<MessageData>(),
    alsoInChannel: boolean("also_in_channel").notNull().default(false),
    replyCount: integer("reply_count").notNull().default(0),
    /** The `seq` of the thread's latest reply: a follower whose `message_thread.last_read_seq` is lower has replies to read. */
    lastReplySeq: integer("last_reply_seq").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    /** The latest people to reply, newest first, at most a few. */
    repliers: text("repliers").array().notNull().default(sql`'{}'::text[]`),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: text("pinned_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', search_fold(left(plain, 20000))) || to_tsvector('simple', cjk_bigrams(left(plain, 20000)))`,
    ),
  },
  (t) => [
    uniqueIndex("channel_message_seq_idx").on(t.channelId, t.seq),
    index("channel_message_thread_idx").on(t.threadId, t.seq).where(sql`${t.threadId} is not null`),
    index("channel_message_rev_idx").on(t.workspaceId, t.rev),
    index("channel_message_author_idx").on(t.authorId),
    index("channel_message_pinned_idx").on(t.channelId).where(sql`${t.pinnedAt} is not null`),
    index("channel_message_search_idx").using("gin", t.searchVector),
    check("channel_message_kind_check", sql`${t.kind} in ('message', 'system')`),
  ],
);

/**
 * A person a message named, by name or as everyone in the channel (`broadcast`): the Activity
 * list's mentions, newest first. Rows go with an edit that drops the name.
 */
export const messageMention = pgTable(
  "message_mention",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => channelMessage.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    broadcast: boolean("broadcast").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] }), index("message_mention_user_idx").on(t.userId, t.workspaceId, t.createdAt)],
);

/** What a message said before each edit, newest last: its history, which its channel's people may read. */
export const messageVersion = pgTable(
  "message_version",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    messageId: text("message_id")
      .notNull()
      .references(() => channelMessage.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** When these words were replaced. */
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_version_message_idx").on(t.messageId, t.replacedAt)],
);

/** A reaction: one person's emoji on a message, once per emoji. */
export const messageReaction = pgTable(
  "message_reaction",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => channelMessage.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] }), index("message_reaction_user_idx").on(t.userId)],
);

/**
 * A poll (server/messages/polls.ts): a message whose text is its question, with the options people
 * vote on. Made with its message and never changed but to close it (`closedAt`, or `closesAt`
 * passing). Deleting the message deletes the poll and its votes.
 */
export const messagePoll = pgTable("message_poll", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => channelMessage.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  /** The choices, in order, each with an id the server gave it. */
  options: jsonb("options").$type<PollOption[]>().notNull(),
  /** Each person may choose several options (else one, which a new choice replaces). */
  multiple: boolean("multiple").notNull().default(false),
  /** Others see how many chose each option, never who. */
  anonymous: boolean("anonymous").notNull().default(false),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: text("closed_by").references(() => user.id, { onDelete: "set null" }),
});

/** One person's choice of one option of a poll. */
export const messagePollVote = pgTable(
  "message_poll_vote",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messagePoll.messageId, { onDelete: "cascade" }),
    optionId: text("option_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.optionId] }), index("message_poll_vote_user_idx").on(t.userId)],
);

/**
 * A person and a thread: they follow it (they wrote in it, were named in it or chose to), and
 * `lastReadSeq` is the last reply they saw. `mentions` counts unread replies naming them.
 */
export const messageThread = pgTable(
  "message_thread",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => channelMessage.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    following: boolean("following").notNull().default(true),
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    mentions: integer("mentions").notNull().default(0),
    /** When the thread last had a reply: the threads list's order. */
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index("message_thread_user_idx").on(t.userId, t.workspaceId, t.lastReplyAt),
    index("message_thread_rev_idx").on(t.workspaceId, t.rev),
  ],
);

/**
 * A file sent in a message, or waiting in someone's message box (`messageId` null until sent; the
 * cleanup takes those a day later). Its channel's people may read it (files.ts `fileForViewer`).
 */
export const messageFile = pgTable(
  "message_file",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => file.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => channelMessage.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** An image's size in pixels, read in the browser before upload: the message keeps its room before it loads. */
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_file_message_idx").on(t.messageId), index("message_file_channel_idx").on(t.channelId)],
);

/**
 * What someone was writing in a channel or a thread (`threadId` "" for the channel), kept on the
 * server so it follows them to their other devices.
 */
export const messageDraft = pgTable(
  "message_draft",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().default(""),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    fileIds: text("file_ids").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId, t.threadId] }), index("message_draft_rev_idx").on(t.workspaceId, t.rev)],
);

/**
 * A message someone kept for later, with an optional reminder (`remindAt`, pushed to them once when
 * it comes, `remindedAt`) and done once they mark it so.
 */
export const savedMessage = pgTable(
  "saved_message",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => channelMessage.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index("saved_message_rev_idx").on(t.workspaceId, t.rev),
    index("saved_message_remind_idx").on(t.remindAt).where(sql`${t.remindedAt} is null and ${t.doneAt} is null`),
  ],
);

/** A message someone wrote to go out later, sent by a sweep (server/messages/scheduled.ts) as them when `sendAt` comes. */
export const scheduledMessage = pgTable(
  "scheduled_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    body: text("body").notNull(),
    fileIds: text("file_ids").array().notNull().default(sql`'{}'::text[]`),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    /** Why it couldn't go (they left the channel, it was archived); it waits for them then. */
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("scheduled_message_due_idx").on(t.sendAt).where(sql`${t.failure} is null`), index("scheduled_message_user_idx").on(t.userId, t.workspaceId)],
);

/**
 * A webhook that posts into a channel (server/messages/webhooks.ts): tools that send to a chat's
 * incoming webhooks (alerts, builds) send here instead. Its address carries a secret shown once,
 * kept only as its SHA-256; its messages have no author and carry its name in `data.webhook`.
 */
export const channelWebhook = pgTable(
  "channel_webhook",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    /** The secret's last characters, to tell addresses apart in the list. */
    hint: text("hint").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("channel_webhook_channel_idx").on(t.channelId)],
);

/**
 * A person's status in a workspace's messages: a few words and an emoji others see beside their
 * name, until `statusUntil`, and quiet hours of their own (`quietUntil`: no notifications till then).
 */
export const messageStatus = pgTable(
  "message_status",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    emoji: text("emoji"),
    text: text("text").notNull().default(""),
    statusUntil: timestamp("status_until", { withTimezone: true }),
    quietUntil: timestamp("quiet_until", { withTimezone: true }),
    /** Show what a message says in its notification; off shows only who wrote and where. */
    previews: boolean("previews").notNull().default(true),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] }), index("message_status_rev_idx").on(t.workspaceId, t.rev)],
);
