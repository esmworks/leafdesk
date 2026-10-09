import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { databaseView } from "./app";
import { user } from "./auth";

/**
 * A calendar view's rows as a feed calendar apps subscribe to (see server/calendar-feeds): a secret
 * address, read as its user, with the user's own access at the time of each read. One per user and
 * view; making a new one replaces it. Only a SHA-256 hash of the secret is kept: it is shown once.
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
    viewId: text("view_id")
      .notNull()
      .references(() => databaseView.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the secret. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Updated at most once an hour. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("calendar_feed_user_view_idx").on(t.userId, t.viewId), index("calendar_feed_view_idx").on(t.viewId)],
);
