import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { LinkPlace } from "@/lib/link-context";
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
    /**
     * Every block of the source that links to the target, in document order (MAX_LINK_PLACES at
     * most), with the text around each link: the "Linked from" list shows each and opens the source
     * at that block. Null for links indexed before blocks were kept, until the source is indexed
     * again (on its next save, or by the backfill in server/mentions.ts).
     */
    places: jsonb("places").$type<LinkPlace[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.targetId] }), index("page_link_target_idx").on(t.targetId)],
);

/**
 * `pageId`'s body holds a reference to synced block `syncId` of page `sourceId` (lib/synced-blocks):
 * the synced block's list of the pages it shows on. Kept like page links, on every save of `pageId`.
 */
export const syncedBlockReference = pgTable(
  "synced_block_reference",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    syncId: text("sync_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.sourceId, t.syncId] }), index("synced_block_reference_source_idx").on(t.sourceId, t.syncId)],
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
