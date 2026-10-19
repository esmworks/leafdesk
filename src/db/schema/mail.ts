import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { MailboxFolders, MailboxStatus, RowEmailDirection, RowEmailStatus } from "../../lib/mail";
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
 * A member's own mailbox in a workspace, read over IMAP and sent from over SMTP. Only mail that
 * matches a row is ever fetched whole; the rest is passed over on its headers. The password is
 * sealed (server/secret-box) and never leaves the server.
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
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecure: boolean("imap_secure").notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecure: boolean("smtp_secure").notNull(),
    username: text("username").notNull(),
    /** Sealed: the app password. */
    secret: text("secret").notNull(),
    /** Where reading stopped in each watched folder. */
    folders: jsonb("folders").$type<MailboxFolders>().notNull().default({}),
    status: text("status").$type<MailboxStatus>().notNull().default("connecting"),
    statusError: text("status_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** When its owner agreed that mail matched to rows shows to everyone who sees those rows. */
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("mailbox_member_idx").on(t.workspaceId, t.userId),
    check("mailbox_status_check", sql`${t.status} in ('connecting', 'ok', 'error')`),
  ],
);

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
    /** Cleaned HTML (server/row-mail/html.ts); null for plain-text mail. */
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
