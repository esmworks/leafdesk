import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { workspace } from "./app";
import { oauthClient, user } from "./auth";

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

/**
 * A person's app or token an owner disconnected from one workspace (server/workspace-apps.ts
 * `disconnectWorkspaceApp`) when it reaches their other workspaces too: there it keeps working,
 * here it finds the workspace hidden (server/access.ts). An app is cut off only as connected then:
 * the person connecting it again (a newer consent) brings it back, as after a revocation.
 */
export const connectedAppCutOff = pgTable(
  "connected_app_cut_off",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appKind: text("app_kind").$type<"connected_app" | "api_token">().notNull(),
    appId: text("app_id").notNull(),
    cutAt: timestamp("cut_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId, t.appKind, t.appId] }),
    index("connected_app_cut_off_app_idx").on(t.userId, t.appKind, t.appId),
    check("connected_app_cut_off_kind_check", sql`${t.appKind} in ('connected_app', 'api_token')`),
  ],
);

/**
 * Whether a person's MCP app lists every Leafdesk tool or the core ones and the gates to the rest
 * (server/mcp/tool-lists.ts, chosen under Settings > Connected apps). No row: as the app's name
 * says (tool-lists.ts `listsAllByDefault`). Kept when the app is disconnected, for when it comes back.
 */
export const connectedAppTools = pgTable(
  "connected_app_tools",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    allTools: boolean("all_tools").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clientId] })],
);
