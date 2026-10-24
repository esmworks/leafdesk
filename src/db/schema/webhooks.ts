import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { DeliveryCode, DeliveryDetails, DeliveryStatus, PageWebhookEvent, PageWebhookPause, PageWebhookScope } from "../../lib/page-webhooks";
import { page, teamspace, workspace } from "./app";
import { user } from "./auth";

/**
 * A workspace's page webhook (server/page-webhooks): what happens to the pages in its scope goes
 * to `url` as a signed POST. Owners manage them; deliveries go out as `ownerId` (whoever last saved
 * it), with what they may see when each is sent, and stop while they aren't an owner.
 */
export const pageWebhook = pgTable(
  "page_webhook",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: jsonb("events").$type<PageWebhookEvent[]>().notNull(),
    scope: text("scope").$type<PageWebhookScope>().notNull().default("workspace"),
    /** Scope "teamspace": its teamspace. */
    teamspaceId: text("teamspace_id").references(() => teamspace.id, { onDelete: "cascade" }),
    /** Scope "page": the page whose own events, and those of the pages under it, are sent. */
    pageId: text("page_id").references(() => page.id, { onDelete: "cascade" }),
    /**
     * Random, never shown: the signing secret is derived from it and the server's secret (see
     * server/page-webhooks/manage.ts), so it isn't stored. A new salt replaces the secret.
     */
    secretSalt: text("secret_salt").notNull(),
    /** Who saved it last: deliveries go out as them. Null once their account is gone (it stops). */
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    /** Set when it stopped sending on its own (see PageWebhookPause); saving it again clears it. */
    paused: text("paused").$type<PageWebhookPause>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("page_webhook_workspace_idx").on(t.workspaceId),
    check("page_webhook_scope_check", sql`${t.scope} in ('workspace', 'teamspace', 'page')`),
    check("page_webhook_scope_target_check", sql`(${t.scope} <> 'teamspace' or ${t.teamspaceId} is not null) and (${t.scope} <> 'page' or ${t.pageId} is not null)`),
  ],
);

/**
 * Edits of a page waiting out their delay before page webhooks hear about them, like page
 * watching's (server/page-watch.ts): one per page, so a session of writing is one `page.updated`.
 */
export const pageWebhookPending = pgTable(
  "page_webhook_pending",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Who edited it last. */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    title: boolean("title").notNull().default(false),
    body: boolean("body").notNull().default(false),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("page_webhook_pending_due_idx").on(t.dueAt)],
);

/**
 * One event on its way to one page webhook, and how it went: the delivery log (kept
 * DELIVERY_LOG_DAYS) and the queue the sender works through. `pageId` is no reference: a deleted
 * page's delivery outlives it. The body is made when it is first sent and every retry sends it
 * again; its id is the `X-Leafdesk-Delivery` header.
 */
export const pageWebhookDelivery = pgTable(
  "page_webhook_delivery",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => pageWebhook.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** A PageWebhookEvent, or "ping" for *Send test*. */
    event: text("event").notNull(),
    pageId: text("page_id"),
    details: jsonb("details").$type<DeliveryDetails>().notNull().default({}),
    payload: text("payload"),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** Pending ones: when to send it (again); null once it is done. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    code: text("code").$type<DeliveryCode>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("page_webhook_delivery_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index("page_webhook_delivery_log_idx").on(t.webhookId, t.createdAt),
    index("page_webhook_delivery_created_idx").on(t.createdAt),
    check("page_webhook_delivery_status_check", sql`${t.status} in ('pending', 'delivered', 'failed', 'skipped')`),
  ],
);
