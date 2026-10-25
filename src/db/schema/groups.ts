import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { page, teamspace, workspace, workspaceMember } from "./app";
import { user } from "./auth";
import type { PageLevel } from "./permissions";

/**
 * A named set of a workspace's owners and members ("Design", "Support") that pages can be shared
 * with and teamspaces joined by, all at once. Workspace owners manage them (server/groups.ts).
 * Guests are never in a group: they get single pages shared with them by name.
 */
export const memberGroup = pgTable(
  "member_group",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the (group_id, workspace_id) keys below: nothing points at another workspace's group.
    unique("member_group_id_workspace_key").on(t.id, t.workspaceId),
    // Picked by name in the sharing panel, so two groups of a workspace never share one.
    uniqueIndex("member_group_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

/**
 * Who is in a group. The row points at the person's workspace membership, so leaving or being
 * removed from the workspace takes them out of its groups in the same statement.
 */
export const memberGroupMember = pgTable(
  "member_group_member",
  {
    groupId: text("group_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("member_group_member_user_idx").on(t.userId),
    foreignKey({
      name: "member_group_member_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [memberGroup.id, memberGroup.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "member_group_member_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * A group's level on a page and, until a subpage has its own entry for the group, everything
 * under it: like a person's own entry (`page_permission`), for everyone in the group. Read by
 * `page_access_level`; a person in several groups gets the highest.
 */
export const pageGroupPermission = pgTable(
  "page_group_permission",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    level: text("level").$type<PageLevel>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("page_group_permission_key").on(t.pageId, t.groupId),
    index("page_group_permission_workspace_idx").on(t.workspaceId),
    index("page_group_permission_group_idx").on(t.groupId),
    foreignKey({
      name: "page_group_permission_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [memberGroup.id, memberGroup.workspaceId],
    }).onDelete("cascade"),
    check("page_group_permission_level_check", sql`${t.level} in ('none', 'view', 'comment', 'content', 'edit', 'full')`),
  ],
);

/**
 * A group that joined a teamspace: everyone in the group is in it as a member, as if they had a
 * `teamspace_member` row. Owners of a teamspace are always named people.
 */
export const teamspaceGroup = pgTable(
  "teamspace_group",
  {
    teamspaceId: text("teamspace_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamspaceId, t.groupId] }),
    index("teamspace_group_group_idx").on(t.groupId),
    foreignKey({
      name: "teamspace_group_teamspace_fk",
      columns: [t.teamspaceId, t.workspaceId],
      foreignColumns: [teamspace.id, teamspace.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "teamspace_group_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [memberGroup.id, memberGroup.workspaceId],
    }).onDelete("cascade"),
  ],
);
