import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AuditActorKind } from "../../lib/audit";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * The workspace audit log (issue #61): one row per change an owner may want to trace, written by
 * server/audit.ts (`recordAudit`) and listed in Settings > Audit log. Names are copied in when the
 * event is recorded (`actor_name`, `target_label`, …), so the log still reads after the person,
 * page or group is gone; `actor_user_id` is cleared when the account is deleted. `details` holds
 * small before/after values, never page content. Kept for AUDIT_RETENTION_DAYS (server/retention.ts).
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The person who acted, or for whom an API token or connected app acted; null for SCIM and the server. */
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
    actorName: text("actor_name").notNull().default(""),
    actorEmail: text("actor_email"),
    /** The API token's, connected app's or SCIM token's name. */
    actorVia: text("actor_via"),
    /** One of AUDIT_ACTIONS (lib/audit.ts). */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label").notNull().default(""),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    /** The visitor's address as server.ts worked it out; null outside a request (the daily cleanup). */
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The list, newest first, unfiltered or by action (category) or by who acted.
    index("audit_event_workspace_time_idx").on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    index("audit_event_workspace_action_idx").on(t.workspaceId, t.action, t.createdAt.desc()),
    index("audit_event_workspace_actor_idx").on(t.workspaceId, t.actorUserId, t.createdAt.desc()),
    // The daily cleanup, across workspaces.
    index("audit_event_created_idx").on(t.createdAt),
    check("audit_event_actor_kind_check", sql`${t.actorKind} in ('user', 'agent', 'api_token', 'connected_app', 'scim', 'system')`),
  ],
);
