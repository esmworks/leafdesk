import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { EmailDraftProblem } from "../../lib/email-draft-check";
import type { EnrollmentReason, EnrollmentSource, EnrollmentStatus, SendWindow, SequenceStep } from "../../lib/sequences";
import { page, workspace } from "./app";
import { user } from "./auth";
import { mailbox, rowEmail } from "./mail";
import { pendingChange } from "./review";

/**
 * A follow-up sequence of a mail database (lib/sequences.ts, server/sequences): emails sent one
 * after another from a member's own mailbox to the rows enrolled in it, until the contact answers.
 * Owners of the workspace manage them where its email settings are; they go with the database.
 */
export const emailSequence = pgTable(
  "email_sequence",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    steps: jsonb("steps").$type<SequenceStep[]>().notNull().default([]),
    /** When its emails may go out, in each sender's time zone (their mailbox's). */
    window: jsonb("send_window").$type<SendWindow>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("email_sequence_database_idx").on(t.databaseId)],
);

/**
 * A row going through a sequence, from its sender's mailbox: `step` is the next step to send (the
 * one waiting for review while `waiting`), due at `nextAt`. The background job (server/sequences/
 * run.ts) claims due ones for a while (`claimedUntil`), so two servers never take the same one.
 * A row has at most one open enrollment per sequence.
 */
export const sequenceEnrollment = pgTable(
  "sequence_enrollment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => emailSequence.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Whose mailbox it sends from. */
    senderId: text("sender_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<EnrollmentStatus>().notNull().default("active"),
    step: integer("step").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }),
    /** Paused on an out-of-office reply: until when. */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /** Why it is paused or stopped. */
    reason: text("reason").$type<EnrollmentReason>(),
    /** checkFailed: what the draft check found. */
    problems: jsonb("problems").$type<EmailDraftProblem[]>(),
    /** waiting: the step's draft in the sender's For review queue. */
    pendingChangeId: text("pending_change_id").references(() => pendingChange.id, { onDelete: "set null" }),
    /** The email the last step sent, which the next one answers. */
    lastEmailId: text("last_email_id").references(() => rowEmail.id, { onDelete: "set null" }),
    sent: integer("sent").notNull().default(0),
    source: text("source").$type<EnrollmentSource>().notNull(),
    enrolledBy: text("enrolled_by").references(() => user.id, { onDelete: "set null" }),
    stoppedBy: text("stopped_by").references(() => user.id, { onDelete: "set null" }),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sequence_enrollment_open_idx").on(t.sequenceId, t.rowId).where(sql`${t.status} in ('active', 'waiting', 'paused')`),
    index("sequence_enrollment_due_idx").on(t.nextAt).where(sql`${t.status} = 'active'`),
    index("sequence_enrollment_row_idx").on(t.rowId, t.startedAt),
    index("sequence_enrollment_sender_idx").on(t.senderId, t.workspaceId),
    index("sequence_enrollment_ended_idx").on(t.endedAt).where(sql`${t.endedAt} is not null`),
    check("sequence_enrollment_status_check", sql`${t.status} in ('active', 'waiting', 'paused', 'finished', 'stopped')`),
  ],
);

/**
 * A step an enrollment sent: one row per step, written in the same transaction that queues the
 * email, so no step ever goes out twice. Also what a mailbox's daily limit counts.
 */
export const sequenceSend = pgTable(
  "sequence_send",
  {
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => sequenceEnrollment.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    rowEmailId: text("row_email_id").references(() => rowEmail.id, { onDelete: "set null" }),
    mailboxId: text("mailbox_id").references(() => mailbox.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.enrollmentId, t.step] }), index("sequence_send_mailbox_idx").on(t.mailboxId, t.sentAt)],
);
