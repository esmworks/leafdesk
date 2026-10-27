import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { RepeatRule, ScheduleKind, ScheduleSettings } from "@/lib/schedule";
import { workspaceAgent } from "./agents";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * Something that happens on a repeat rule (see lib/schedule, server/schedules): `kind` says what.
 * A "row_template" schedule adds a row from a database's row template; it goes with the template.
 * An "agent" schedule starts a run of `agentId` with the task in `settings`, on `databaseId` when it
 * names one; it goes with the agent. A "dashboard_email" schedule emails the figures of a dashboard
 * on `pageId` (a dashboard block of the page, or a dashboard view of the database) to the people in
 * `settings`; it goes with the page.
 * It runs as the person who set it last, with their access at the time, and pauses (`enabled`
 * off, with `lastError`) when they can no longer do it.
 */
export const schedule = pgTable(
  "schedule",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ScheduleKind>().notNull(),
    /** "row_template": the template rows are made from, and its database. "agent": the database it looks after, if any. */
    templateId: text("template_id").references(() => page.id, { onDelete: "cascade" }),
    databaseId: text("database_id").references(() => page.id, { onDelete: "cascade" }),
    /** "agent": the agent it runs. */
    agentId: text("agent_id").references(() => workspaceAgent.id, { onDelete: "cascade" }),
    /** "dashboard_email": the page holding the dashboard (a page, or a database for a dashboard view). */
    pageId: text("page_id").references(() => page.id, { onDelete: "cascade" }),
    rule: jsonb("rule").$type<RepeatRule>().notNull(),
    /** The IANA time zone the rule's days and time are in. */
    timeZone: text("time_zone").notNull(),
    /** What a run does beyond its kind (for "row_template", whether the title gets the day; for "agent", the task). */
    settings: jsonb("settings").$type<ScheduleSettings>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    /** When it runs next; moved on before each run, so a run happens at most once. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Why the last run didn't happen (see ScheduleError); null after one that did. */
    lastError: text("last_error"),
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
    index("schedule_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
    uniqueIndex("schedule_template_idx").on(t.templateId),
    index("schedule_database_idx").on(t.databaseId),
    index("schedule_agent_idx").on(t.agentId),
    index("schedule_page_idx").on(t.pageId),
  ],
);
