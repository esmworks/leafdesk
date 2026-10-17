import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { databaseView, workspace } from "./app";
import { user } from "./auth";

/**
 * A feed calendar apps subscribe to (see server/calendar-feeds): a calendar view's rows, or (with
 * `workspaceId` instead of `viewId`) the rows assigned to the user across a workspace. A secret
 * address, read as its user, with the user's own access at the time of each read. One per user and
 * view, and one per user and workspace for assigned rows; making a new one replaces it. Only a
 * SHA-256 hash of the secret is kept: it is shown once.
 */
export const calendarFeed = pgTable(
  "calendar_feed",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The calendar view of the feed; null for a feed of assigned rows. */
    viewId: text("view_id").references(() => databaseView.id, { onDelete: "cascade" }),
    /** The workspace of a feed of assigned rows; null for a view's feed. */
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    /**
     * The zone the feed's days are its user's in: "today" in the view's filters counts from their
     * day there. Theirs when they made the feed, or when they last opened it if it had none.
     */
    timeZone: text("time_zone"),
    /** Hex SHA-256 of the secret. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Updated at most once an hour. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("calendar_feed_user_view_idx").on(t.userId, t.viewId),
    index("calendar_feed_view_idx").on(t.viewId),
    uniqueIndex("calendar_feed_user_assigned_idx").on(t.userId, t.workspaceId).where(sql`${t.viewId} is null`),
    index("calendar_feed_workspace_idx").on(t.workspaceId),
    check("calendar_feed_target_check", sql`(${t.viewId} is null) <> (${t.workspaceId} is null)`),
  ],
);
