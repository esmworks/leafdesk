import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AuditStreamErrorCode } from "../../lib/audit-stream";
import type { SensitiveKind, SensitiveStatus } from "../../lib/sensitive-content";
import { page, workspace } from "./app";
import { auditEvent } from "./audit";
import { user } from "./auth";

/**
 * Where a workspace's audit log is streamed (server/audit-stream.ts): new events go to `url` as
 * signed JSON batches, in order, at least once. One per workspace, set up by its owners in
 * Settings > Audit log. It belongs to the workspace, not to whoever saved it: it keeps sending
 * whoever of the owners comes and goes. The rest of the row is how sending goes, for the settings.
 */
export const auditStream = pgTable("audit_stream", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  /** The signing secret, sealed (server/secret-box.ts); shown once, when it is made. */
  secret: text("secret").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** Who saved it last, for the settings. */
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  /** The batch being sent, kept while it is tried again: its id is the X-Leafdesk-Delivery header. */
  batchId: text("batch_id"),
  /** When to send next while it fails (backing off), or while a server holds the claim; null when free. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code").$type<AuditStreamErrorCode>(),
  lastError: text("last_error"),
  lastHttpStatus: integer("last_http_status"),
  /** Since when every try failed; null once one goes through. */
  failingSince: timestamp("failing_since", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  sentEvents: integer("sent_events").notNull().default(0),
  /** Events that waited longer than STREAM_KEEP_DAYS and were given up on. */
  droppedEvents: integer("dropped_events").notNull().default(0),
  lastDroppedAt: timestamp("last_dropped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Audit events waiting to be streamed. A trigger on audit_event adds each new event of a workspace
 * whose stream is on (see the migration), in the transaction that records it, so an event that
 * commits late is still sent; the sender deletes the rows a receiver took.
 */
export const auditStreamOutbox = pgTable(
  "audit_stream_outbox",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => auditEvent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The event's own time, the order batches go in. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("audit_stream_outbox_order_idx").on(t.workspaceId, t.createdAt, t.eventId)],
);

/**
 * Sensitive content found in a page or row (server/sensitive-content.ts): one per page, kind and
 * value. The value itself is never kept: `fingerprint` is a keyed hash of it, to know it again,
 * and `excerpt` a masked form (`**** **** **** 4242`). Open until the page no longer holds it
 * (resolved) or an owner dismisses it; a resolved one found again opens again.
 */
export const sensitiveFinding = pgTable(
  "sensitive_finding",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SensitiveKind>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    excerpt: text("excerpt").notNull(),
    status: text("status").$type<SensitiveStatus>().notNull().default("open"),
    /** When it was found, or found again after it was resolved. */
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: text("dismissed_by").references(() => user.id, { onDelete: "set null" }),
    /** When owners were told about it; they hear about a page and kind at most once a day. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sensitive_finding_value_idx").on(t.pageId, t.kind, t.fingerprint),
    index("sensitive_finding_workspace_idx").on(t.workspaceId, t.status, t.foundAt),
    check("sensitive_finding_status_check", sql`${t.status} in ('open', 'resolved', 'dismissed')`),
  ],
);

/** Which version of each page the scanner last read (`page.updated_at` then), so it reads only what changed. */
export const sensitiveScan = pgTable(
  "sensitive_scan",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sensitive_scan_workspace_idx").on(t.workspaceId)],
);
