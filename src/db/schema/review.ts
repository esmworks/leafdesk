import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PendingChangeKind, PendingChangePayload, PendingChangeSource, PendingChangeStatus, RowChangeBefore } from "../../lib/pending-changes";
import { agentRun, workspaceAgent } from "./agents";
import { page, workspace } from "./app";
import { automationRun, databaseAutomation } from "./automations";
import { user } from "./auth";

/**
 * A change waiting for review (lib/pending-changes.ts, server/pending-changes.ts): a row an agent
 * would add or change, or an email it drafted, kept here instead of made until a person approves
 * it (making it as themselves, from `editedPayload` when they changed it) or dismisses it. Waits
 * until `expiresAt`; the daily cleanup expires it then, and deletes answered ones a while later.
 */
export const pendingChange = pgTable(
  "pending_change",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PendingChangeKind>().notNull(),
    /** The database the row is (or would be) in. */
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** The row it changes or emails from; for a new row, the row approving it made. */
    rowId: text("row_id").references(() => page.id, { onDelete: "cascade" }),
    /** What was proposed: a row's values by property id, or an email. */
    payload: jsonb("payload").$type<PendingChangePayload>().notNull(),
    /** A reviewer's edit of `payload`, which approving makes instead. */
    editedPayload: jsonb("edited_payload").$type<PendingChangePayload>(),
    /** What a row change touches, as the row had it when proposed. */
    before: jsonb("before").$type<RowChangeBefore>(),
    /** Why it was proposed, in the agent's words. */
    reason: text("reason").notNull().default(""),
    source: jsonb("source").$type<PendingChangeSource>().notNull(),
    /** The agent that proposed it, and the run (runs are pruned after a while; the proposal stays). */
    agentId: text("agent_id").references(() => workspaceAgent.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRun.id, { onDelete: "set null" }),
    /**
     * An automation's approval step: the automation and the run waiting for the answer. The entry
     * goes with the run (a deleted automation's runs go with it): nothing is left to continue.
     */
    automationId: text("automation_id").references(() => databaseAutomation.id, { onDelete: "cascade" }),
    automationRunId: text("automation_run_id").references(() => automationRun.id, { onDelete: "cascade" }),
    /** The agent's own user, which the row's activity credits with the change. */
    proposedBy: text("proposed_by").references(() => user.id, { onDelete: "set null" }),
    /** Email drafts: whose mailbox it goes out from; only they may send it. */
    senderId: text("sender_id").references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<PendingChangeStatus>().notNull().default("pending"),
    error: text("error"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Approved email drafts: the message queued on the row. */
    resultId: text("result_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("pending_change_queue_idx").on(t.workspaceId, t.status, t.createdAt),
    index("pending_change_row_idx").on(t.rowId, t.status),
    index("pending_change_expiry_idx").on(t.status, t.expiresAt),
    index("pending_change_run_idx").on(t.agentRunId),
    index("pending_change_automation_run_idx").on(t.automationRunId),
    check("pending_change_kind_check", sql`${t.kind} in ('create_row', 'update_row', 'email_draft', 'automation_approval')`),
    check("pending_change_status_check", sql`${t.status} in ('pending', 'approved', 'dismissed', 'expired', 'failed')`),
    // Changes and drafts are about a row (an approval only when its run has one); a draft goes out from someone's mailbox.
    check("pending_change_row_check", sql`${t.kind} in ('create_row', 'automation_approval') or ${t.rowId} is not null`),
    check("pending_change_sender_check", sql`${t.kind} <> 'email_draft' or ${t.senderId} is not null`),
  ],
);
