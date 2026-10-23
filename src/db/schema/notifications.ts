import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { RowUpdate } from "../../lib/row-updates";
import { agentRun } from "./agents";
import { databaseProperty, page, teamspace, workspace, workspaceJoinRequest } from "./app";
import { session, user } from "./auth";
import { databaseAutomation } from "./automations";
import { rowEmail } from "./mail";
import { sequenceEnrollment } from "./sequences";
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
  /** Email me when someone changes a database row I follow. */
  rowUpdateEmails: boolean("row_update_emails").notNull().default(true),
  /** Show changes to the database rows I follow in my inbox. */
  rowUpdateInbox: boolean("row_update_inbox").notNull().default(true),
  /** Email me when someone edits a page I watch (throttled, see server/page-watch.ts). */
  pageUpdateEmails: boolean("page_update_emails").notNull().default(true),
  /** Show edits to the pages I watch in my inbox. */
  pageUpdateInbox: boolean("page_update_inbox").notNull().default(true),
  /**
   * Email on database rows (server/row-mail): show mail that lands on my rows in my inbox. No email
   * goes out about it: the mail itself is in a mailbox already (`rowEmailEmails` is kept for the
   * shape every kind has, and unused).
   */
  rowEmailInbox: boolean("row_email_inbox").notNull().default(true),
  rowEmailEmails: boolean("row_email_emails").notNull().default(false),
  /**
   * Changes waiting for my review (pending_change): show them in my inbox. No email goes out about
   * them (`reviewEmails` is kept for the shape every kind has, and unused).
   */
  reviewInbox: boolean("review_inbox").notNull().default(true),
  reviewEmails: boolean("review_emails").notNull().default(false),
  /**
   * Follow-up sequences (server/sequences): show a follow-up of mine that stopped short of sending
   * in my inbox. No email goes out about it (`followUpEmails` is kept for the shape every kind has,
   * and unused).
   */
  followUpInbox: boolean("follow_up_inbox").notNull().default(true),
  followUpEmails: boolean("follow_up_emails").notNull().default(false),
  /** Show reminders that a page I verified is about to stop being verified, or did, in my inbox. */
  verificationInbox: boolean("verification_inbox").notNull().default(true),
  /** Email me those reminders. */
  verificationEmails: boolean("verification_emails").notNull().default(true),
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
  rowUpdatePush: boolean("row_update_push").notNull().default(true),
  pageUpdatePush: boolean("page_update_push").notNull().default(true),
  rowEmailPush: boolean("row_email_push").notNull().default(true),
  reviewPush: boolean("review_push").notNull().default(true),
  followUpPush: boolean("follow_up_push").notNull().default(true),
  verificationPush: boolean("verification_push").notNull().default(true),
  /**
   * Telegram messages per kind, to the Telegram account the person linked (see telegram_link,
   * server/telegram/notify.ts). They follow the inbox as push does.
   */
  assignmentTelegram: boolean("assignment_telegram").notNull().default(true),
  shareTelegram: boolean("share_telegram").notNull().default(true),
  commentTelegram: boolean("comment_telegram").notNull().default(true),
  mentionTelegram: boolean("mention_telegram").notNull().default(true),
  reminderTelegram: boolean("reminder_telegram").notNull().default(true),
  accessRequestTelegram: boolean("access_request_telegram").notNull().default(true),
  joinRequestTelegram: boolean("join_request_telegram").notNull().default(true),
  automationTelegram: boolean("automation_telegram").notNull().default(true),
  rowUpdateTelegram: boolean("row_update_telegram").notNull().default(true),
  pageUpdateTelegram: boolean("page_update_telegram").notNull().default(true),
  rowEmailTelegram: boolean("row_email_telegram").notNull().default(true),
  reviewTelegram: boolean("review_telegram").notNull().default(true),
  followUpTelegram: boolean("follow_up_telegram").notNull().default(true),
  verificationTelegram: boolean("verification_telegram").notNull().default(true),
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

/**
 * Who follows a database row besides those who do by being part of it (see server/row-follow.ts):
 * people who commented or were mentioned on it, or chose to follow it (`following`), and people who
 * chose not to (`following` false), which wins over everything else, its creator and the people
 * its person properties name included.
 */
export const rowFollower = pgTable(
  "row_follower",
  {
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    following: boolean("following").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.userId] }), index("row_follower_user_idx").on(t.userId)],
);

/**
 * Changes to a database row waiting out their delay before its followers hear about them (see
 * server/row-follow.ts): one per row and person who changed it, so a burst of edits becomes one
 * notification. Kept in the database so a restart doesn't lose them.
 */
export const pendingRowUpdate = pgTable(
  "row_update_pending",
  {
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** What they changed so far, values masked like the row's activity. */
    changes: jsonb("changes").$type<RowUpdate>().notNull(),
    /** The actor's interface language when they made the first change, for the emails. */
    locale: text("locale"),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.actorId] }), index("row_update_pending_due_idx").on(t.dueAt)],
);

/**
 * Who watches a page besides its creator and the people watching its teamspace (see
 * server/page-watch.ts): people who chose to watch it or edited it (`watching`), and people who
 * muted it (`watching` false), which wins over everything else, being its creator included.
 * Database rows aren't watched: they are followed (row_follower).
 */
export const pageWatch = pgTable(
  "page_watch",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    watching: boolean("watching").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId] }), index("page_watch_user_idx").on(t.userId)],
);

/**
 * People who muted the replies in one comment thread of a page (see server/thread-mute.ts). Threads
 * live in the page's document, so `thread_id` refers to nothing here; the rows go with the thread,
 * the page or the person.
 */
export const threadMute = pgTable(
  "thread_mute",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.threadId, t.userId] }), index("thread_mute_user_idx").on(t.userId)],
);

/** People who watch every page of a teamspace, unless they muted the page (see server/page-watch.ts). */
export const teamspaceWatch = pgTable(
  "teamspace_watch",
  {
    teamspaceId: text("teamspace_id")
      .notNull()
      .references(() => teamspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamspaceId, t.userId] }), index("teamspace_watch_user_idx").on(t.userId)],
);

/**
 * Edits to a page waiting out their delay before its watchers hear about them (see
 * server/page-watch.ts): one per page and person who edited it, so a session of writing becomes one
 * notification. Kept in the database so a restart doesn't lose them.
 */
export const pendingPageUpdate = pgTable(
  "page_update_pending",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The actor's interface language when they made the first change, for the emails. */
    locale: text("locale"),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.actorId] }), index("page_update_pending_due_idx").on(t.dueAt)],
);

/**
 * Page-update emails that went out (see server/share-emails.ts), for their cooldown per page and
 * their daily cap per person: one per page an email was about, those of one digest sharing `sentAt`.
 * Kept for a day or two.
 */
export const pageUpdateEmail = pgTable(
  "page_update_email",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_update_email_user_idx").on(t.userId, t.sentAt)],
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
  "row_update",
  "page_updated",
  "row_email",
  "review",
  "follow_up",
  "verification",
  "agent_approval",
  "agent_memory",
  "agent_report",
  "ai_account_detached",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/**
 * Kinds that always show to the workspace's owners: an agent's call or notes waiting for them, a
 * scheduled run's report, or the AI account the workspace ran on gone.
 */
export const OWNER_KINDS = ["agent_approval", "agent_memory", "agent_report", "ai_account_detached"] as const satisfies readonly NotificationKind[];
export type OwnerKind = (typeof OWNER_KINDS)[number];
export const isOwnerKind = (kind: string): kind is OwnerKind => (OWNER_KINDS as readonly string[]).includes(kind);
/** Kinds people choose to hear about (not OWNER_KINDS). */
export type PreferenceKind = Exclude<NotificationKind, OwnerKind>;

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
 * user about row `pageId`, which `actorId` added or changed. "row_update": `actorId` changed row
 * `pageId`, which the user follows; `changes` says what. "page_updated": `actorId` (the latest of
 * them) edited page `pageId`, which the user watches. "agent_approval": agent `actorId`'s run
 * `agentRunId` waits for an owner to approve a call to a connection's tool; it has no page, and goes
 * away once anyone answers or the call runs out of time. "agent_memory": agent `actorId`'s run
 * `agentRunId` proposed notes for its memory (server/agents/memory.ts); one per owner and run, with
 * no page, gone once no proposal of the run waits any more. "agent_report": agent `actorId`'s run
 * `agentRunId`, which one of its schedules started, finished; it tells the owner who set the
 * schedule what the run did or why it failed, and has no page. "row_email": message `rowEmailId`
 * landed on row `pageId`, through the mailbox of `actorId` (null when it is the user's own).
 * "review": changes wait for the user's review (pending_change) in the workspace, the latest
 * proposed by agent `actorId`; one unread at a time per person and workspace, which newer
 * proposals bring back to the top rather than adding more; it has no page. "follow_up": the
 * user's enrollment `sequenceEnrollmentId` of row `pageId` in a follow-up sequence paused because
 * its next email didn't pass the draft check (see server/sequences). "verification": the user's
 * verification of page `pageId` ends at `date` (an ISO time) in a few days, or ended then (created
 * at or after it); see server/verification.ts.
 * "ai_account_detached": the workspace's AI no longer runs on `actorId`'s own AI account (they left
 * the workspace, deleted the account or their whole account); it has no page. Unread ones are dropped when the change is
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
    /** "automation": the message its notify step wrote, templates resolved; null without one. */
    message: text("message"),
    /** Agent approval, memory and report notifications: the run whose call or notes wait, or that finished. */
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
     * else the mentioned date the user set a reminder on. Automations: a "date passed" run's date
     * of the row (see automation_run.basis); null for runs a row write started.
     */
    date: text("date"),
    /**
     * Snoozed: hidden from the inbox until then, when it comes back unread at the top (with a new
     * `createdAt`) and is pushed again. Null otherwise.
     */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /**
     * Row updates: what `actorId` changed, only the values the user could see when it was told
     * (the inbox checks again), masked like the row's activity.
     */
    changes: jsonb("changes").$type<RowUpdate>(),
    /** Row email: the message that landed on row `pageId` (received into `actorId`'s mailbox, when not the user's own). */
    rowEmailId: text("row_email_id").references(() => rowEmail.id, { onDelete: "cascade" }),
    /** Follow-ups: the enrollment that paused. */
    sequenceEnrollmentId: text("sequence_enrollment_id").references(() => sequenceEnrollment.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("notification_inbox_idx").on(t.userId, t.workspaceId, t.createdAt),
    index("notification_email_due_idx").on(t.emailDueAt),
    // Answering a request deletes its notifications through the foreign key.
    index("notification_access_request_idx").on(t.accessRequestId),
    index("notification_agent_run_idx").on(t.agentRunId),
    index("notification_row_email_idx").on(t.rowEmailId).where(sql`${t.rowEmailId} is not null`),
    index("notification_snoozed_idx").on(t.snoozedUntil).where(sql`${t.snoozedUntil} is not null`),
    // A run that proposes notes tells each owner once.
    uniqueIndex("notification_agent_memory_idx").on(t.agentRunId, t.userId).where(sql`${t.kind} = 'agent_memory'`),
    // Only join requests, changes waiting for review, agents' approvals, notes and reports, and a detached AI account are about no page (access requests are about the page asked for).
    check(
      "notification_subject_check",
      sql`${t.kind} in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached') or ${t.pageId} is not null`,
    ),
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
