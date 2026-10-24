import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { JiraMapping, JiraQuery, JiraSyncError } from "@/lib/jira-sync";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * A database kept in step with a service outside Leafdesk, one way: for now the issues of a Jira
 * Cloud project or JQL query (lib/jira-sync, server/jira-sync). Its sign-in (`secrets`: the email
 * address and API token) is sealed (server/secret-box) and never leaves the server.
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
    source: text("source").$type<"jira">().notNull(),
    /** The Jira site's origin, "https://acme.atlassian.net". */
    siteUrl: text("site_url").notNull(),
    query: jsonb("query").$type<JiraQuery>().notNull(),
    /** The properties it writes, by what each holds. */
    mapping: jsonb("mapping").$type<JiraMapping>().notNull(),
    /** Sealed JSON: `{ email, token }`. */
    secrets: text("secrets").notNull(),
    /** How often it runs on its own, in minutes; 0 for only when asked. */
    intervalMinutes: integer("interval_minutes").notNull(),
    /** Off once a run couldn't happen for a reason that won't pass (see JiraSyncError). */
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Held while a run is going (a crash lets it go after a while), so two never run at once. */
    runningUntil: timestamp("running_until", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Issues the last run that went through found. */
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
