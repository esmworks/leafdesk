import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Attendee } from "@/lib/meetings";
import { databaseView, page, workspace } from "./app";
import { user } from "./auth";

/**
 * A meeting block of a page (lib/meetings), for the Meetings page: derived from the page's body on
 * every save (server/meetings.ts syncMeetingNotes), so the block stays the source of truth. Who may
 * see one, and whether its page is in the trash, is worked out from its page when it is listed.
 */
export const meetingNote = pgTable(
  "meeting_note",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    meetingId: text("meeting_id").notNull(),
    title: text("title").notNull().default(""),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    seconds: integer("seconds").notNull().default(0),
    attendees: jsonb("attendees").$type<Attendee[]>().notNull().default([]),
    status: text("status").notNull().default(""),
    /** The summary's first point. */
    preview: text("preview").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.meetingId] })],
);

/** Pages a user starred; listed under Favorites in their sidebar. Private to that user. */
export const pageFavorite = pgTable(
  "page_favorite",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.pageId] }), index("page_favorite_page_idx").on(t.pageId)],
);

/**
 * A page published to the web: anyone with the link can read it without signing in. The token is
 * the only way in, so unpublishing (deleting the row) or publishing again with a new token cuts off
 * old links.
 */
export const pagePublication = pgTable("page_publication", {
  pageId: text("page_id")
    .primaryKey()
    .references(() => page.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
  /** Search engines may index the page and its subpages; off unless the publisher allows it. */
  indexable: boolean("indexable").notNull().default(false),
  /**
   * Listed in the workspace's site (`workspace_site`): its navigation shows the page and its
   * subpages, and site addresses serve them. Off by default, so a page shared by link only is
   * never listed without someone choosing to.
   */
  inSite: boolean("in_site").notNull().default(false),
  /** Signed-in visitors may copy the page (as published) into a workspace of theirs. Off by default. */
  allowDuplicate: boolean("allow_duplicate").notNull().default(false),
  /**
   * Databases outside the page that its body shows (dashboard widgets, linked views) and the
   * publisher chose to show there anyway. Only through those blocks: they get no address of their
   * own, and every request checks again that the publisher can still see them (see publication.ts
   * outsideShown). Ids the body no longer shows are ignored.
   */
  outsideDatabaseIds: text("outside_database_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A workspace's public site (see server/site.ts): a readable address (`/s/<slug>`) that opens the
 * home page, with navigation between the workspace's published pages listed in it (`inSite`).
 * Owners set it up; without a row the workspace has no site, and its pages only have their links.
 */
export const workspaceSite = pgTable("workspace_site", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  /** Lowercase letters, digits and hyphens (see lib/site.ts); unique across the server. */
  slug: text("slug").notNull().unique(),
  /** Shown at the top of every page of the site. */
  title: text("title").notNull().default(""),
  /** A published page of the workspace; while it isn't served, the site opens its first listed page. */
  homePageId: text("home_page_id").references(() => page.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * A form view open to people outside the workspace (`/f/<token>`): anyone with the link can add a
 * row through it, signed in or, with `anonymous`, without an account. Like a published page, the
 * token is the only way in, and the form stops taking answers once the person who opened it loses
 * edit access to the database. Copies of the database never carry the row along.
 */
export const formPublication = pgTable("form_publication", {
  viewId: text("view_id")
    .primaryKey()
    .references(() => databaseView.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  /** Answers without signing in, and without recording who answered even when signed in. */
  anonymous: boolean("anonymous").notNull().default(false),
  publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A row someone signed in added through a form, in the app or by its public link: what lets them
 * see their own answers later (server/forms ownSubmissions) without any access to the database.
 * Anonymous answers have none. Goes with the row when it is deleted for good, and with the view.
 */
export const formSubmission = pgTable(
  "form_submission",
  {
    rowId: text("row_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    viewId: text("view_id")
      .notNull()
      .references(() => databaseView.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("form_submission_view_user_idx").on(t.viewId, t.userId, t.createdAt.desc())],
);
