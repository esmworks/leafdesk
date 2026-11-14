import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentChainRunStatus, AgentChainTrigger } from "@/lib/agent-chains";
import type { RowRepeatError, RowRepeatRule } from "@/lib/row-repeat";
import type { RepeatRule, ScheduleKind, ScheduleSettings } from "@/lib/schedule";
import { agentRun, workspaceAgent } from "./agents";
import { databaseProperty, page, workspace } from "./app";
import { user } from "./auth";

/**
 * Something that happens on a repeat rule (see lib/schedule, server/schedules): `kind` says what.
 * A "row_template" schedule adds a row from a database's row template; it goes with the template.
 * An "agent" schedule starts a run of `agentId` with the task in `settings`, on `databaseId` when it
 * names one; it goes with the agent. A "dashboard_email" schedule emails the figures of a dashboard
 * on `pageId` (a dashboard block of the page, or a dashboard view of the database) to the people in
 * `settings`; it goes with the page. An "own_request" schedule asks the AI chat the task in `settings`
 * as the person who set it, in a conversation of theirs kept for the schedule (server/own-requests.ts).
 * An "agent_chain" schedule is a chain of agents (server/agents/chains.ts), its steps in `settings`;
 * it runs on its rule only when `settings.repeats`, and whenever someone clicks Run now.
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
    /**
     * Runs that failed in a row (the run itself, for an agent's or an own request's: its worker
     * tells, server/schedules.ts `noteScheduleOutcome`); one that went well sets it back to 0. At
     * SCHEDULE_FAILURE_LIMIT the schedule turns itself off and tells whoever set it.
     */
    failures: integer("failures").notNull().default(0),
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

/**
 * One run of a chain of agents (server/agents/chains.ts): its steps' runs (`agent_run`, source
 * `schedule` with `chain`) start one after another, each when the one before ends done. `step` is the
 * step under way, or the one it ended at, and `runId` that step's run. A chain has one run going at
 * a time (`agent_chain_run_going_idx`). Ended runs are kept as the chain's history, as long as their
 * chain; only the latest is shown.
 */
export const agentChainRun = pgTable(
  "agent_chain_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedule.id, { onDelete: "cascade" }),
    /** Who clicked Run now, or set the schedule: every step runs held to their access, and they get the report. */
    startedBy: text("started_by").references(() => user.id, { onDelete: "set null" }),
    trigger: text("trigger").$type<AgentChainTrigger>().notNull(),
    status: text("status").$type<AgentChainRunStatus>().notNull().default("running"),
    step: integer("step").notNull().default(0),
    runId: text("run_id").references(() => agentRun.id, { onDelete: "set null" }),
    /** Why it ended before its last step was done (lib/agent-chains AgentChainStopCode). */
    code: text("code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_chain_run_schedule_idx").on(t.scheduleId, t.createdAt),
    uniqueIndex("agent_chain_run_going_idx").on(t.scheduleId).where(sql`${t.status} = 'running'`),
  ],
);

/**
 * A row that comes round again (see lib/row-repeat, server/row-repeat): when it is marked done, a
 * copy opens with `propertyId`'s date moved to the next time, and the rule moves to the copy. So a
 * chain of repeats has one rule at a time, on its latest row; the day's count travels with it.
 */
export const rowRepeat = pgTable(
  "row_repeat",
  {
    rowId: text("row_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** The date property the rule moves. */
    propertyId: text("property_id")
      .notNull()
      .references(() => databaseProperty.id, { onDelete: "cascade" }),
    rule: jsonb("rule").$type<RowRepeatRule>().notNull(),
    /** The zone of whoever set it: "today" and the day a row was done are counted there. */
    timeZone: text("time_zone").notNull(),
    /** Who set it last: a copy the person who did the row may not add is added as them. */
    setBy: text("set_by").references(() => user.id, { onDelete: "set null" }),
    /** The same for every row of one chain of repeats. */
    chainId: text("chain_id").notNull(),
    /** The row whose being done opened this one, while it may still take it back (see server/row-repeat `takeBack`). */
    previousRowId: text("previous_row_id").references(() => page.id, { onDelete: "set null" }),
    /** What this row's body and values were when it was opened: untouched while they still are. */
    madeHash: text("made_hash"),
    /** The day (YYYY-MM-DD, in `timeZone`) `spawnCount` counts copies of. */
    spawnDay: text("spawn_day"),
    spawnCount: integer("spawn_count").notNull().default(0),
    /** Why the last copy couldn't be opened (RowRepeatError); null after one that was. */
    lastError: text("last_error").$type<RowRepeatError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("row_repeat_database_idx").on(t.databaseId), index("row_repeat_previous_idx").on(t.previousRowId)],
);
