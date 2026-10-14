import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * When a connected app last reached a workspace for its user (see server/connected-app-use.ts): an
 * MCP client (`connected_app`, its OAuth client id) or a REST API token (`api_token`, its id). Shown
 * to the workspace's owners next to the apps that can reach it. Written at most once a minute per
 * row; a row goes when its app is disconnected or its token revoked.
 */
export const connectedAppUse = pgTable(
  "connected_app_use",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appKind: text("app_kind").$type<"connected_app" | "api_token">().notNull(),
    appId: text("app_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId, t.appKind, t.appId] }),
    index("connected_app_use_app_idx").on(t.appKind, t.appId),
    check("connected_app_use_kind_check", sql`${t.appKind} in ('connected_app', 'api_token')`),
  ],
);
