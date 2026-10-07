import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ConnectionAuthType, ConnectionEventStatus, ConnectionStatus, ConnectionTool, EventPreset, ToolKind } from "@/lib/connections";
import { workspaceAgent } from "./agents";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * A service outside Leafdesk that a workspace's agents use: a remote MCP server (see
 * lib/connections.ts and server/connections). Its credentials (`secrets`: a token, or OAuth
 * client details and tokens) and its event signing secret are sealed (server/secret-box) and never
 * leave the server.
 */
export const connection = pgTable(
  "connection",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    /** Short and unique in the workspace: its tools reach the model as `<slug>__<tool>`. */
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    authType: text("auth_type").$type<ConnectionAuthType>().notNull(),
    /** Sealed JSON (ConnectionSecrets in server/connections). */
    secrets: text("secrets"),
    status: text("status").$type<ConnectionStatus>().notNull().default("needsAuth"),
    statusError: text("status_error"),
    /** The server's tools, as last listed, with their class. */
    tools: jsonb("tools").$type<ConnectionTool[]>().notNull().default([]),
    /** Owners' overrides of a tool's class, by tool name, kept when the tools are listed again. */
    kinds: jsonb("kinds").$type<Record<string, ToolKind>>().notNull().default({}),
    toolsAt: timestamp("tools_at", { withTimezone: true }),
    eventPreset: text("event_preset").$type<EventPreset>().notNull().default("hmac"),
    /** Sealed: the secret events are signed with (ours for `hmac`, the service's for the others). */
    eventSecret: text("event_secret").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("connection_slug_idx").on(t.workspaceId, t.slug)],
);

/**
 * A sign-in to a connection's service under way: the browser went to the service and comes back
 * with `state`. Holds (sealed) what the return needs: the PKCE verifier and what discovery found.
 * Gone once used, or after 15 minutes.
 */
export const connectionOauth = pgTable("connection_oauth", {
  state: text("state").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connection.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The tools of a connection an agent may use. */
export const agentGrant = pgTable(
  "agent_grant",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId] })],
);

/** Runs an agent, with a task, on a connection's events of one type (null: any). */
export const connectionTrigger = pgTable(
  "connection_trigger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    eventType: text("event_type"),
    prompt: text("prompt").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connection_trigger_connection_idx").on(t.connectionId)],
);

/**
 * An event a connection received, kept CONNECTION_EVENT_DAYS: the settings list it, and its
 * delivery id (the service sending it again) and its signature (the same request sent again, its
 * unsigned delivery id changed) each refuse it a second time. `received` until its runs are queued:
 * one the server failed on is taken again when the service retries it.
 */
export const connectionEvent = pgTable(
  "connection_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    signature: text("signature"),
    eventType: text("event_type").notNull(),
    status: text("status").$type<ConnectionEventStatus>().notNull(),
    note: text("note").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connection_event_delivery_idx").on(t.connectionId, t.deliveryId),
    uniqueIndex("connection_event_signature_idx").on(t.connectionId, t.signature),
    index("connection_event_received_idx").on(t.connectionId, t.receivedAt),
  ],
);
