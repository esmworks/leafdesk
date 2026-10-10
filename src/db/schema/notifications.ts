import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agentRun } from "./agents";
import { databaseProperty, page, workspace, workspaceJoinRequest } from "./app";
import { session, user } from "./auth";
import { databaseAutomation } from "./automations";
import { accessRequest } from "./permissions";

/** Account-wide choices that follow the user across browsers (the interface language doesn't). */
export const userPreference = pgTable("user_preference", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /**
   * The interface language they last used: the one they picked, else their browser's, as of their
   * last sign-in or change in the language picker (see server/mail/locale.ts). The interface itself
   * still goes by the browser's cookie; this is the language of emails to them. Null until then.
   */
  locale: text("locale"),
  /** Email me when someone assigns me to a database row. */
  assignmentEmails: boolean("assignment_emails").notNull().default(true),
  /** Show assignments in my inbox. */
  assignmentInbox: boolean("assignment_inbox").notNull().default(true),
  /** Email me when someone shares a page with me. */
  shareEmails: boolean("share_emails").notNull().default(true),
  /** Show pages shared with me in my inbox. */
  shareInbox: boolean("share_inbox").notNull().default(true),
  /** Email me when someone replies in a comment thread I'm part of. */
  commentEmails: boolean("comment_emails").notNull().default(true),
  /** Show replies to my comment threads in my inbox. */
  commentInbox: boolean("comment_inbox").notNull().default(true),
  /** Email me when someone mentions me on a page. */
  mentionEmails: boolean("mention_emails").notNull().default(true),
  /** Show mentions of me in my inbox. */
  mentionInbox: boolean("mention_inbox").notNull().default(true),
  /** Email me the reminders I set on dates. */
  reminderEmails: boolean("reminder_emails").notNull().default(true),
  /** Show the reminders I set on dates in my inbox. */
  reminderInbox: boolean("reminder_inbox").notNull().default(true),
  /** Email me when someone asks for access to a page I have full access to. */
  accessRequestEmails: boolean("access_request_emails").notNull().default(true),
  /** Show requests for access to pages I have full access to in my inbox. */
  accessRequestInbox: boolean("access_request_inbox").notNull().default(true),
  /** Email me when someone asks to join a workspace I own. */
  joinRequestEmails: boolean("join_request_emails").notNull().default(true),
  /** Show requests to join the workspaces I own in my inbox. */
  joinRequestInbox: boolean("join_request_inbox").notNull().default(true),
  /** Email me what database automations tell me. */
  automationEmails: boolean("automation_emails").notNull().default(true),
  /** Show what database automations tell me in my inbox. */
  automationInbox: boolean("automation_inbox").notNull().default(true),
  /**
   * Push notifications per kind, to the devices that turned them on (see push_subscription). They
   * follow the inbox: a kind turned off there sends no push either, whatever these say, so by
   * default push is on exactly for what shows in the inbox, and each kind can be silenced on its own.
   */
  assignmentPush: boolean("assignment_push").notNull().default(true),
  sharePush: boolean("share_push").notNull().default(true),
  commentPush: boolean("comment_push").notNull().default(true),
  mentionPush: boolean("mention_push").notNull().default(true),
  reminderPush: boolean("reminder_push").notNull().default(true),
  accessRequestPush: boolean("access_request_push").notNull().default(true),
  joinRequestPush: boolean("join_request_push").notNull().default(true),
  automationPush: boolean("automation_push").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Assignment emails waiting out their delay (see server/assignments). Kept in the database so a
 * restart doesn't lose them; one row per person per cell, so quick edits send a single email.
 */
export const pendingAssignmentEmail = pgTable(
  "assignment_email",
  {
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    propertyId: text("property_id")
      .notNull()
      .references(() => databaseProperty.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** The assigner's interface language when they made the change. */
    locale: text("locale").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.propertyId, t.userId] }), index("assignment_email_due_idx").on(t.dueAt)],
);

/**
 * Reminders a date property sent (see server/date-reminders): one per row, property and date, so
 * each date reminds once however often the sweep runs or how many servers run it. Changing the
 * row's date to another day arms it again.
 */
export const rowReminder = pgTable(
  "row_reminder",
  {
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    propertyId: text("property_id")
      .notNull()
      .references(() => databaseProperty.id, { onDelete: "cascade" }),
    /** The start of the row's date it reminded about: YYYY-MM-DD, or a time's UTC timestamp. */
    date: text("date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.propertyId, t.date] })],
);

export const NOTIFICATION_KINDS = [
  "assignment",
  "page_shared",
  "comment",
  "mention",
  "reminder",
  "access_request",
  "join_request",
  "automation",
  "agent_approval",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** Kinds people choose to hear about; an agent's call waiting for approval always shows to owners. */
export type PreferenceKind = Exclude<NotificationKind, "agent_approval">;

/**
 * A user's inbox, per workspace. "assignment": `actorId` added the user to the person property
 * `propertyId` of row `pageId`. "page_shared": `actorId` gave the user their own access to page
 * `pageId`. "comment": `actorId` replied in comment thread `threadId` on page `pageId`, where the
 * user had commented before. "mention": `actorId` mentioned the user on page `pageId` (mention
 * `mentionId`). "reminder": the reminder the user set on date mention `mentionId` of page `pageId`
 * fell due, or the reminder of date property `propertyId` of row `pageId` for the day in `date`. "access_request": `actorId` asked for access to page `pageId`, which the user has full
 * access to (request `accessRequestId`); answered by anyone, it goes away, read or not.
 * "join_request": `actorId` asked to join (or to invite someone), request `joinRequestId`, which
 * waits for the workspace's owners; it has no page. "automation": automation `automationId` told the
 * user about row `pageId`, which `actorId` added or changed. "agent_approval": agent `actorId`'s run
 * `agentRunId` waits for an owner to approve a call to a connection's tool; it has no page, and goes
 * away once anyone answers or the call runs out of time. Unread ones are dropped when the change is
 * undone (or the request decided). Rows are recorded
 * whatever the user's preferences; the inbox leaves out the kinds they turned off.
 */
export const notification = pgTable(
  "notification",
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
    kind: text("kind").$type<NotificationKind>().notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** Every kind but join_request. */
    pageId: text("page_id").references(() => page.id, { onDelete: "cascade" }),
    propertyId: text("property_id").references(() => databaseProperty.id, { onDelete: "cascade" }),
    /** Comment notifications: the thread (in the page's document) they are about. */
    threadId: text("thread_id"),
    /** Mention and reminder notifications: the mention (in the page's document) they are about. */
    mentionId: text("mention_id"),
    /** Access request notifications: the request, so answering it takes all of them away. */
    accessRequestId: text("access_request_id").references(() => accessRequest.id, { onDelete: "cascade" }),
    /** Join request notifications: the request. */
    joinRequestId: text("join_request_id").references(() => workspaceJoinRequest.id, { onDelete: "cascade" }),
    /** Automation notifications: the automation that sent it. */
    automationId: text("automation_id").references(() => databaseAutomation.id, { onDelete: "cascade" }),
    /** Agent approval notifications: the run whose call waits. */
    agentRunId: text("agent_run_id").references(() => agentRun.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** When to email the user about it (all but assignment); cleared once the email is handled. */
    emailDueAt: timestamp("email_due_at", { withTimezone: true }),
    /** The actor's interface language, for that email. */
    emailLocale: text("email_locale"),
    /**
     * Reminders: the date that fell due (YYYY-MM-DD), the start of the row's date for a date
     * property's reminder (`propertyId` of row `pageId`; a time's UTC timestamp when it has a time),
     * else the mentioned date the user set a reminder on.
     */
    date: text("date"),
    /**
     * Snoozed: hidden from the inbox until then, when it comes back unread at the top (with a new
     * `createdAt`) and is pushed again. Null otherwise.
     */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  },
  (t) => [
    index("notification_inbox_idx").on(t.userId, t.workspaceId, t.createdAt),
    index("notification_email_due_idx").on(t.emailDueAt),
    // Answering a request deletes its notifications through the foreign key.
    index("notification_access_request_idx").on(t.accessRequestId),
    index("notification_agent_run_idx").on(t.agentRunId),
    index("notification_snoozed_idx").on(t.snoozedUntil).where(sql`${t.snoozedUntil} is not null`),
    // Only join requests and agents' approvals are about no page (access requests are about the page asked for).
    check("notification_subject_check", sql`${t.kind} in ('join_request', 'agent_approval') or ${t.pageId} is not null`),
  ],
);

/**
 * A browser that receives the user's notifications as push messages (see server/push.ts). The
 * endpoint is the push service's address for that browser, given by the browser itself; p256dh and
 * auth are its keys, which encrypt each message so only that browser can read it. A subscription
 * belongs to the sign-in it was made in: signing out (or the session being revoked) deletes it, so
 * a shared browser stops getting the previous user's notifications.
 */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** The browser's User-Agent when it subscribed, to tell devices apart. */
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last time the push service took a message for it. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Failed sends since the last one that went through; too many and it is dropped. */
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [index("push_subscription_user_idx").on(t.userId), index("push_subscription_session_idx").on(t.sessionId)],
);
