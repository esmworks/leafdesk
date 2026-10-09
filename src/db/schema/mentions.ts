import { index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { page } from "./app";
import { user } from "./auth";

/**
 * What page bodies point at, kept by the collab server each time it saves a page (see
 * server/mentions.ts). The page's document stays the source of truth; these tables are indexes
 * of it, plus what the server already did about it.
 */

/** `sourceId`'s body mentions or links to `targetId`: the target's "Linked from" list. */
export const pageLink = pgTable(
  "page_link",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /**
     * The text of the block where the source first links to the target, around the link, with the
     * link itself as LINK_PLACEHOLDER (lib/link-context). Null for a "Link to page" block, and for
     * links indexed before contexts were kept, until the source is saved again.
     */
    context: text("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.targetId] }), index("page_link_target_idx").on(t.targetId)],
);

/**
 * Person mentions the server has seen on a page, by the mention's id: each is notified about once.
 * Rows stay when the mention is removed, so undoing a deletion or restoring a version doesn't
 * notify again.
 */
export const pageMention = pgTable(
  "page_mention",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    mentionId: text("mention_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.mentionId] })],
);

/**
 * A reminder on a date mention: at `remindAt` the person who set it gets an inbox notification (and
 * an email). `notifiedAt` is set once that happened. An unsent reminder goes when its mention does.
 */
export const pageReminder = pgTable(
  "page_reminder",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    mentionId: text("mention_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The mentioned date, YYYY-MM-DD, for the notification. */
    date: text("date").notNull(),
    remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_reminder_mention_idx").on(t.pageId, t.mentionId),
    index("page_reminder_due_idx").on(t.remindAt).where(sql`${t.notifiedAt} is null`),
  ],
);
