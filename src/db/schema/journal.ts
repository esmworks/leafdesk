import { sql } from "drizzle-orm";
import { check, date, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * Someone's journal in a workspace (see server/journal.ts): the private page their daily notes go
 * under, and how new ones start. Made with their first daily note; a journal page that went to the
 * trash or was deleted is replaced by a new one the next time a note is made.
 */
export const journal = pgTable(
  "journal",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The page daily notes are added under; null once it was deleted. */
    pageId: text("page_id").references(() => page.id, { onDelete: "set null" }),
    /**
     * How a new daily note starts: "default" (a few headings in the user's language), "blank", or
     * "template" (a copy of `templateId`, a workspace template; the default when it is gone).
     */
    start: text("start").$type<JournalStart>().notNull().default("default"),
    templateId: text("template_id").references(() => page.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("journal_user_idx").on(t.userId),
    check("journal_start_check", sql`${t.start} in ('default', 'blank', 'template')`),
  ],
);

export type JournalStart = "default" | "blank" | "template";

/** Someone's note for one day (their calendar day, `YYYY-MM-DD`), one per day and workspace. */
export const dailyNote = pgTable(
  "daily_note",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.day] }), uniqueIndex("daily_note_page_idx").on(t.pageId)],
);

/**
 * Someone's own task list in a workspace (see server/own-tasks.ts): the private database that
 * tasks added from My tasks' New task row go into. Made with their first such task; one that went
 * to the trash or was deleted is replaced by a new one the next time.
 */
export const taskList = pgTable(
  "task_list",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The database; null once it was deleted. */
    pageId: text("page_id").references(() => page.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("task_list_user_idx").on(t.userId)],
);

/**
 * A page made by "New meeting note" (see server/meetings.ts createMeetingNote): listed in the
 * Meetings tab, so the sidebar leaves it out of the page tree while it stays where it was made,
 * among its maker's private pages at the top level. Moved elsewhere, it shows there as any page.
 */
export const meetingPage = pgTable(
  "meeting_page",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("meeting_page_owner_idx").on(t.workspaceId, t.userId)],
);
