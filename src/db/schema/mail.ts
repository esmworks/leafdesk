import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { MailboxAuth, MailboxFolders, MailboxStatus, RowEmailDirection, RowEmailStatus } from "../../lib/mail";
import type { MailAddress, MailFolderRole } from "../../lib/mail-client";
import { page, workspace } from "./app";
import { user } from "./auth";
import { file } from "./files";

/**
 * A database whose rows mail is matched to (see server/row-mail): a message lands on the row whose
 * email property, one of `propertyIds`, holds the other party's address. Workspaces with email
 * turned on (`settings.email`) try their databases in `position` order.
 */
export const mailDatabase = pgTable(
  "mail_database",
  {
    databaseId: text("database_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    propertyIds: jsonb("property_ids").$type<string[]>().notNull().default([]),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mail_database_workspace_idx").on(t.workspaceId, t.position)],
);

/**
 * One of a member's own mailboxes in a workspace, read over IMAP and sent from over SMTP. Only mail
 * that matches a row is ever fetched whole; the rest is passed over on its headers. The password, or
 * the Google sign-in, is sealed (server/secret-box) and never leaves the server. A member may connect
 * a few (MAX_MAILBOXES), one address each; exactly one of them is their default, which follow-ups,
 * agents and email drafts send from.
 */
export const mailbox = pgTable(
  "mailbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    displayName: text("display_name"),
    /** The one of the member's mailboxes in the workspace that mail goes out from unless they pick another. */
    isDefault: boolean("is_default").notNull().default(false),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecure: boolean("imap_secure").notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecure: boolean("smtp_secure").notNull(),
    username: text("username").notNull(),
    /** How it signs in: with a password, or with a Google sign-in (XOAUTH2, server/row-mail/google.ts). */
    auth: text("auth").$type<MailboxAuth>().notNull().default("password"),
    /** Sealed: the app password, or for Google the JSON of its tokens (GoogleMailTokens). */
    secret: text("secret").notNull(),
    /** Where reading stopped in each watched folder. */
    folders: jsonb("folders").$type<MailboxFolders>().notNull().default({}),
    status: text("status").$type<MailboxStatus>().notNull().default("connecting"),
    statusError: text("status_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** Follow-up sequences (server/sequences): how many of their emails it sends at most a day, all sequences together. */
    followUpDailyLimit: integer("follow_up_daily_limit").notNull().default(50),
    /** The owner's IANA time zone, which sequences' send windows and the daily limit go by. */
    timeZone: text("time_zone").notNull().default("UTC"),
    /** The next sequence email waits until then, so a batch of them is spread out. */
    followUpAfter: timestamp("follow_up_after", { withTimezone: true }),
    /** When its owner agreed that mail matched to rows shows to everyone who sees those rows. */
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("mailbox_address_idx").on(t.workspaceId, t.userId, t.address),
    uniqueIndex("mailbox_default_idx").on(t.workspaceId, t.userId).where(sql`${t.isDefault}`),
    check("mailbox_status_check", sql`${t.status} in ('connecting', 'ok', 'error')`),
    check("mailbox_auth_check", sql`${t.auth} in ('password', 'google')`),
  ],
);

/**
 * A Google sign-in a member began to connect their mailbox in a workspace, until the browser comes
 * back with its `state` (server/row-mail/google.ts). Used once; ones older than fifteen minutes are
 * void. `data` is sealed: the PKCE verifier, the consent given and the member's time zone.
 */
export const mailboxOauth = pgTable("mailbox_oauth", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A message on a database row: received into a member's mailbox, or written from the row and sent
 * (or waiting to be) from one. `messageId` is unique in the workspace, so mail that reaches two
 * people's mailboxes shows once.
 */
export const rowEmail = pgTable(
  "row_email",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The mailbox it came through or goes out of; null once that mailbox is gone. */
    mailboxId: text("mailbox_id").references(() => mailbox.id, { onDelete: "set null" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    direction: text("direction").$type<RowEmailDirection>().notNull(),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    to: text("to").array().notNull().default(sql`'{}'::text[]`),
    cc: text("cc").array().notNull().default(sql`'{}'::text[]`),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    /** HTML of the message; rows show its text, so nothing writes it yet. */
    html: text("html"),
    /** The provider's check said the sender's domain did not vouch for it (DMARC failed). */
    unverifiedSender: boolean("unverified_sender").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    status: text("status").$type<RowEmailStatus>().notNull(),
    /** Outgoing: tries so far, when to try again and the last error. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    error: text("error"),
    sentBy: text("sent_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("row_email_message_idx").on(t.workspaceId, t.messageId),
    index("row_email_row_idx").on(t.rowId, t.sentAt),
    index("row_email_queue_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'queued'`),
    check("row_email_direction_check", sql`${t.direction} in ('in', 'out')`),
    check("row_email_status_check", sql`${t.status} in ('received', 'hidden', 'queued', 'sent', 'failed')`),
  ],
);

/** A file attached to a row's email, kept as long as the email is (server/files.ts cleanup). */
export const rowEmailAttachment = pgTable(
  "row_email_attachment",
  {
    rowEmailId: text("row_email_id")
      .notNull()
      .references(() => rowEmail.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Inline images: the `cid:` the HTML points at. */
    contentId: text("content_id"),
  },
  (t) => [primaryKey({ columns: [t.rowEmailId, t.fileId] }), index("row_email_attachment_file_idx").on(t.fileId)],
);

/**
 * A folder of a member's mailbox as the Mail tab lists it (server/mail-client): where reading its
 * messages' headers has got to, newest and oldest, so the list opens without asking the mail
 * server. Made the first time the mailbox's owner opens Mail; nothing is kept before that.
 */
export const mailFolder = pgTable(
  "mail_folder",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    /** What the folder is for, from the server's marks or its name (lib/mail-client.ts); null for the owner's own. */
    role: text("role").$type<MailFolderRole>(),
    delimiter: text("delimiter"),
    uidValidity: text("uid_validity").notNull().default(""),
    /** The newest message read; later ones are new. */
    lastUid: integer("last_uid").notNull().default(0),
    /** Reading back in time has got down to here; 1 or less once nothing older is wanted. */
    oldestUid: integer("oldest_uid").notNull().default(0),
    /** CONDSTORE's mark of the last flag change seen, where the server keeps one. */
    modseq: text("modseq"),
    unseen: integer("unseen").notNull().default(0),
    total: integer("total").notNull().default(0),
    position: integer("position").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("mail_folder_path_idx").on(t.mailboxId, t.path)],
);

/**
 * A message's headers in a folder of a member's mailbox: who, to whom, the subject, the first line,
 * the flags, the thread it belongs to. Its body and attachments stay on the mail server and are
 * read from there when the owner opens it. Only the mailbox's owner reads these.
 */
export const mailMessage = pgTable(
  "mail_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => mailFolder.id, { onDelete: "cascade" }),
    uid: integer("uid").notNull(),
    /** The Message-ID without brackets; the same message in two folders shares it. */
    messageId: text("message_id"),
    /** The thread it is in, worked out when it is read (server/mail-client/threads.ts). */
    threadId: text("thread_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    fromAddress: text("from_address").notNull().default(""),
    fromName: text("from_name"),
    to: jsonb("to").$type<MailAddress[]>().notNull().default([]),
    cc: jsonb("cc").$type<MailAddress[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    /** The subject without Re:/Fwd: and case, which replies without references are threaded by. */
    subjectKey: text("subject_key").notNull().default(""),
    /** The start of its text, for the list. */
    preview: text("preview").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answered: boolean("answered").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    size: integer("size").notNull().default(0),
  },
  (t) => [
    uniqueIndex("mail_message_uid_idx").on(t.folderId, t.uid),
    index("mail_message_folder_idx").on(t.folderId, t.sentAt),
    index("mail_message_thread_idx").on(t.mailboxId, t.threadId),
    index("mail_message_id_idx").on(t.mailboxId, t.messageId),
    index("mail_message_subject_idx").on(t.mailboxId, t.subjectKey, t.sentAt),
    // Read back in time, replies come before what they answer: these find them when it arrives.
    index("mail_message_reply_idx").on(t.mailboxId, t.inReplyTo),
    index("mail_message_references_idx").using("gin", t.references),
  ],
);
