import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Attendee } from "@/lib/meetings";
import type { SiteHeaderLink, SiteTheme } from "@/lib/site";
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

/**
 * A `#tag` written in a page's text (lib/tags), for search: derived from the body on every save
 * (server/page-tags.ts syncPageTags). `key` is the tag folded for comparing, `label` its first
 * spelling on the page, `count` how often it appears there. Who may see one is its page's matter.
 */
export const pageTag = pgTable(
  "page_tag",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.key] }), index("page_tag_key_idx").on(t.key.op("text_pattern_ops"))],
);

/**
 * Pages whose tags are still to be read from their body (server/page-tags.ts): those written before
 * tags were indexed (filled by the migration) and those of a restored workspace. Each is read once.
 */
export const pageTagQueue = pgTable("page_tag_queue", {
  pageId: text("page_id")
    .primaryKey()
    .references(() => page.id, { onDelete: "cascade" }),
});

/**
 * Someone opened a page, database or row in the app (server/page-views.ts): one row per page,
 * person and UTC day, with how many times (a reopening within VIEW_REPEAT_MS doesn't count again)
 * and when last. For analytics only, never content; kept a year (PAGE_VIEW_RETENTION_DAYS).
 */
export const pageView = pgTable(
  "page_view",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    count: integer("count").notNull().default(1),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId, t.day] }), index("page_view_user_idx").on(t.userId), index("page_view_day_idx").on(t.day)],
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
 * A page someone with full access marked as verified (server/verification.ts): checked and right,
 * until `expiresAt` (null: with no end). Editing the page leaves it; verifying again replaces it.
 * Once `expiresAt` passes the page shows "Verification expired" and counts as unverified. The
 * reminder sweep sets `remindedAt` when it told the verifier the end is near and `expiredAt` when
 * it told them it came, so each goes out once.
 */
export const pageVerification = pgTable(
  "page_verification",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    verifiedBy: text("verified_by").references(() => user.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (t) => [
    index("page_verification_workspace_idx").on(t.workspaceId),
    index("page_verification_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
  ],
);

/**
 * Emoji reactions to a page itself, as a feed view shows them under each database row (see
 * server/reactions.ts): one row per person and emoji. Reactions to comments live with the comments,
 * in the page's document.
 */
export const pageReaction = pgTable(
  "page_reaction",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId, t.emoji] }), index("page_reaction_user_idx").on(t.userId)],
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
  /** What search results and link previews say about the page; empty: the site's default. */
  description: text("description").notNull().default(""),
  /**
   * Databases outside the page that its body shows (dashboard widgets, linked views) and the
   * publisher chose to show there anyway. Only through those blocks: they get no address of their
   * own, and every request checks again that the publisher can still see them (see publication.ts
   * outsideShown). Ids the body no longer shows are ignored.
   */
  outsideDatabaseIds: text("outside_database_ids").array().notNull().default([]),
  /**
   * When the link stops working; null: it doesn't. Checked whenever the publication is read
   * (publication.ts `livePublication`): once past, it is served nowhere (its link, the site, its
   * files) as if it were unpublished, but the row stays so the publisher can extend or clear it.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
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
  /**
   * A host name of the site's own (`docs.example.com`, lowercase; see lib/site.ts): requests for it
   * are served the site at its root and nothing else (server/site-hosts.ts). Unique across the
   * server. DNS and certificates are the operator's.
   */
  domain: text("domain").unique(),
  /** Light, dark, or the visitor's system setting, for every page of the site. */
  theme: text("theme").$type<SiteTheme>().notNull().default("system"),
  /** Search description of the pages without one of their own. */
  description: text("description").notNull().default(""),
  /** Links in the site's header, to pages it serves or web addresses (lib/site.ts). */
  headerLinks: jsonb("header_links").$type<SiteHeaderLink[]>().notNull().default([]),
  /** A Google Analytics 4 measurement ID (`G-…`): the site's pages then load Google's tag. */
  analyticsId: text("analytics_id"),
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
