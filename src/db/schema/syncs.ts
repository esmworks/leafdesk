import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { GithubPullsMapping, GithubPullsQuery } from "@/lib/github-pulls-sync";
import type { GithubDeliveryError, GithubDeliveryRow, GithubDeliveryStatus, GithubMapping } from "@/lib/github-sync";
import type { IcalMapping } from "@/lib/ical-sync";
import type { JiraMapping, JiraQuery, JiraSyncError } from "@/lib/jira-sync";
import type { PostgresMapping, PostgresQuery } from "@/lib/postgres-sync";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * A database kept in step with a service outside Leafdesk, one way: the issues of a Jira Cloud
 * project or JQL query (`source` "jira": lib/jira-sync, server/jira-sync), a GitHub repository's
 * pull requests ("github": lib/github-pulls-sync, server/github-pulls), a calendar's events ("ical":
 * lib/ical-sync, server/ical-sync) or a PostgreSQL table's rows ("postgres": lib/postgres-sync,
 * server/postgres-sync). Its sign-in (`secrets`) is sealed (server/secret-box) and never leaves the
 * server.
 */
export const databaseSync = pgTable(
  "database_sync",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    source: text("source").$type<"jira" | "github" | "ical" | "postgres">().notNull(),
    /**
     * The Jira site's origin, "https://acme.atlassian.net"; for GitHub its API's address; for a
     * calendar its address's origin (the rest can be its key); for PostgreSQL where it reads,
     * without user or password (lib/postgres-sync postgresSite).
     */
    siteUrl: text("site_url").notNull(),
    /** What it reads; a calendar's is `{}` (its address is in `secrets`). */
    query: jsonb("query").$type<JiraQuery | GithubPullsQuery | PostgresQuery | Record<string, never>>().notNull(),
    /** The properties it writes, by what each holds. */
    mapping: jsonb("mapping").$type<JiraMapping | GithubPullsMapping | IcalMapping | PostgresMapping>().notNull(),
    /**
     * Sealed JSON: Jira's `{ email, token }`, GitHub's `{ token }` (null without one), a calendar's
     * `{ url }`, PostgreSQL's `{ url }` (the connection address with its password).
     */
    secrets: text("secrets").notNull(),
    /** How often it runs on its own, in minutes; 0 for only when asked. */
    intervalMinutes: integer("interval_minutes").notNull(),
    /** Off once a run couldn't happen for a reason that won't pass (see JiraSyncError). */
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Held while a run is going (a crash lets it go after a while), so two never run at once. */
    runningUntil: timestamp("running_until", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Issues (pull requests) the last run that went through found. */
    lastCount: integer("last_count"),
    lastError: text("last_error").$type<JiraSyncError>(),
    /** Jira's own words about a refused query, for "badQuery". */
    lastErrorDetail: text("last_error_detail"),
    /** Who set it last: it runs as them. Null once their account is gone (it pauses). */
    runAs: text("run_as").references(() => user.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("database_sync_database_idx").on(t.databaseId),
    index("database_sync_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
    index("database_sync_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * A database whose rows GitHub pull requests move (lib/github-sync, server/github-sync): GitHub
 * sends pull request events to `/api/github/<id>`, signed with `secret` (sealed, see
 * server/secret-box). Its writes are made as `runAs`, whoever saved it last, with their access when
 * each delivery comes.
 */
export const githubSync = pgTable(
  "github_sync",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Sealed: the secret GitHub signs deliveries with. */
    secret: text("secret").notNull(),
    mapping: jsonb("mapping").$type<GithubMapping>().notNull(),
    /** Who saved it last: deliveries write as them. Null once their account is gone (deliveries then fail). */
    runAs: text("run_as").references(() => user.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("github_sync_database_idx").on(t.databaseId), index("github_sync_workspace_idx").on(t.workspaceId)],
);

/**
 * Deliveries a GitHub setup took, the latest GITHUB_DELIVERIES_KEPT: to show how each went, and to
 * take each delivery (by GitHub's delivery id, or its signature for a replay under another id) once.
 */
export const githubDelivery = pgTable(
  "github_delivery",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    syncId: text("sync_id")
      .notNull()
      .references(() => githubSync.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    signature: text("signature").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    status: text("status").$type<GithubDeliveryStatus>().notNull(),
    pullRequest: jsonb("pull_request").$type<{ repo: string; number: number; title: string; url: string }>(),
    rows: jsonb("rows").$type<GithubDeliveryRow[]>().notNull().default([]),
    error: text("error").$type<GithubDeliveryError>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("github_delivery_delivery_idx").on(t.syncId, t.deliveryId),
    uniqueIndex("github_delivery_signature_idx").on(t.syncId, t.signature),
    index("github_delivery_received_idx").on(t.syncId, t.receivedAt),
  ],
);
