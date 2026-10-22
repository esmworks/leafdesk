import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { workspace } from "./app";
import { user } from "./auth";

/** What a personal access token may do: per resource, see lib/api-scopes.ts. */
export { API_TOKEN_SCOPES, type ApiTokenScope } from "@/lib/api-scopes";

/**
 * Personal access tokens for the REST API (/api/v1). A token acts as its user, with the user's own
 * page access, narrowed by its scopes and, optionally, to one workspace. Only a SHA-256 hash of the
 * secret is kept: it is shown once, when it is created. Revoking deletes the row.
 */
export const apiToken = pgTable(
  "api_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The start of the secret ("esi_" and a few characters), to tell tokens apart in lists. */
    prefix: text("prefix").notNull(),
    /** Hex SHA-256 of the whole secret. */
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    /**
     * Made before scopes were per resource: its `pages:read` stands for every read scope and
     * `pages:write` for every scope (lib/api-scopes.ts). Cleared when its scopes are changed.
     */
    legacyScopes: boolean("legacy_scopes").notNull().default(false),
    /** Only pages of this workspace; any of the user's workspaces when null. */
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Updated at most once a minute. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
);

/**
 * What a write to the REST API with an `Idempotency-Key` header answered, so a retry with the same
 * key gets the same answer instead of doing it twice (server/api/idempotency.ts). One per token,
 * operation (method and route, "POST /pages/{page_id}/move") and key; `status` is null while the
 * first request is still running. Kept 24 hours; the daily retention run deletes older ones.
 */
export const apiIdempotencyKey = pgTable(
  "api_idempotency_key",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiToken.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    /** Hex SHA-256 of the request: method, path, query and body. */
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    /** The JSON body it answered, as sent. */
    response: text("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.operation, t.key] }), index("api_idempotency_key_created_idx").on(t.createdAt)],
);
