import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { RowAccessRule } from "@/lib/row-access";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * Stored access levels, weakest first. `none` on a page takes away what an ancestor gave;
 * `comment` reads the page and comments on it without editing it; `content` edits what the page
 * and its rows hold (body, title, icon, cover, rows and their values, new pages under it) but not
 * their structure (a database's properties, views and settings, sharing, moving or trashing the
 * page itself), which takes `edit`.
 */
export const PAGE_LEVELS = ["none", "view", "comment", "content", "edit", "full"] as const;
export type PageLevel = (typeof PAGE_LEVELS)[number];

/**
 * Who may do what on a page and, unless a descendant says otherwise, everything under it.
 * `userId` null means everyone with a member role in the workspace. The rules live in the SQL
 * function `page_access_level` (see the migration), which the app calls for every check.
 */
export const pagePermission = pgTable(
  "page_permission",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Copied from the page so the "no permissions in this workspace" fast path is one index lookup. */
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    level: text("level").$type<PageLevel>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("page_permission_principal_key").on(t.pageId, t.userId).nullsNotDistinct(),
    index("page_permission_workspace_idx").on(t.workspaceId),
    index("page_permission_user_idx").on(t.userId),
    check("page_permission_level_check", sql`${t.level} in ('none', 'view', 'comment', 'content', 'edit', 'full')`),
  ],
);

/**
 * A page shared by email with someone who has no account yet. It waits beside their workspace
 * invitation and turns into a page permission when they accept it or join by link.
 */
export const pageInvitation = pgTable(
  "page_invitation",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** Stored lowercased, like workspace invitations. */
    email: text("email").notNull(),
    level: text("level").$type<PageLevel>().notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("page_invitation_email_key").on(t.pageId, t.email),
    index("page_invitation_workspace_email_idx").on(t.workspaceId, t.email),
    check("page_invitation_level_check", sql`${t.level} in ('view', 'comment', 'content', 'edit', 'full')`),
  ],
);

/**
 * Someone asked for access to a page they can't open, from the "You don't have access" screen.
 * Only pending requests are kept: answering one deletes it, and with it the notifications of
 * everyone who could have answered. One per person and page, so asking again adds nothing. The
 * requester may be outside the workspace; approving then brings them in as a guest.
 */
export const accessRequest = pgTable(
  "access_request",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    requesterId: text("requester_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The access they ask for: "view" from the "You don't have access" screen (any access, the
     * approver picks), "comment" or "edit" from someone who can already view or comment on it.
     */
    level: text("level").$type<"view" | "comment" | "edit">().notNull().default("view"),
    /** What they wrote along with the request, if anything. */
    message: text("message"),
    /** The requester's interface language, for the email that tells them the answer. */
    locale: text("locale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("access_request_requester_key").on(t.pageId, t.requesterId),
    check("access_request_level_check", sql`${t.level} in ('view', 'comment', 'edit')`),
    index("access_request_workspace_idx").on(t.workspaceId),
    index("access_request_requester_idx").on(t.requesterId),
  ],
);

/**
 * What a database's rows give the people they name (lib/row-access.ts): rules giving the people in
 * a person property, or a row's creator, access to the row, and whether rows are `restricted` to
 * those people (and people with full access to the database). One row per database that uses it;
 * `workspaceId` is copied so page_access_level's "no row access in this workspace" fast path is
 * one index lookup.
 */
export const databaseRowAccess = pgTable(
  "database_row_access",
  {
    databaseId: text("database_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    restricted: boolean("restricted").notNull().default(false),
    rules: jsonb("rules").$type<RowAccessRule[]>().notNull().default([]),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("database_row_access_workspace_idx").on(t.workspaceId)],
);
