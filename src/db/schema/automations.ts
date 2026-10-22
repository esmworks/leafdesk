import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AutomationAction,
  AutomationCheckError,
  AutomationRunStatus,
  AutomationStep,
  AutomationTrigger,
  RunOrigin,
} from "@/lib/automations";
import { page, workspace } from "./app";
import { user } from "./auth";

/** An automation's trigger and steps as they were saved, unpublished or as a version. */
export type AutomationDefinition = { trigger: AutomationTrigger; actions: AutomationAction[]; timeZone: string };

/** Unpublished changes to an automation: what a test run runs, and what publishing makes live. */
export type AutomationDraft = AutomationDefinition & { savedBy: string | null; savedAt: string };

/**
 * A database automation (see server/automations): when its trigger matches a row write (or its
 * schedule comes, or a request arrives at its address), its steps run once, in order, as the
 * person who last published it, with their access at the time. People with full access to the
 * database manage them; they go with the database.
 *
 * `trigger`, `actions` and `timeZone` are the published version (`version`; 0 for one never
 * published, which doesn't run); changes wait in `draft` until they are published.
 */
export const databaseAutomation = pgTable(
  "database_automation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull().default([]),
    /**
     * Random, never shown: the webhook signing secret is derived from it and the server's secret
     * (see server/automations/webhook.ts), so it isn't stored. A new salt replaces the secret.
     */
    secretSalt: text("secret_salt").notNull(),
    /** Who saved it last: its actions run as them. Null once their account is gone (it stops). */
    runAs: text("run_as").references(() => user.id, { onDelete: "set null" }),
    /**
     * The IANA time zone of whoever saved it last (UTC when they didn't say): a "date passed"
     * trigger counts days of dates without a time in it.
     */
    timeZone: text("time_zone").notNull().default("UTC"),
    /** "Date passed" and scheduled automations: why the last check couldn't run; null when it could. */
    checkError: text("check_error").$type<AutomationCheckError>(),
    /** The published version's number, 1 and up; 0 while only a draft was saved. */
    version: integer("version").notNull().default(1),
    draft: jsonb("draft").$type<AutomationDraft>(),
    /** Scheduled automations that are on: when the schedule next comes round. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * Random, never shown: an incoming webhook's secret address is derived from it and the
     * server's secret (server/automations/incoming.ts). A new salt replaces the address.
     */
    hookSalt: text("hook_salt"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("database_automation_database_idx").on(t.databaseId), index("database_automation_next_run_idx").on(t.nextRunAt)],
);

/**
 * Every published version of an automation, as it was published: a run carries on with the
 * version it started with, so publishing doesn't change runs under way (a wait, a retry).
 */
export const automationVersion = pgTable(
  "automation_version",
  {
    automationId: text("automation_id")
      .notNull()
      .references(() => databaseAutomation.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.version] })],
);

/**
 * One time an automation started: the row and the change, and how each action went. Kept in the
 * database so a restart doesn't lose work: runs wait here (`pending`, from `nextAt`) until the
 * worker takes them, and webhooks that failed wait here to be tried again. Finished runs are kept
 * for 30 days, as the automation's history.
 */
export const automationRun = pgTable(
  "automation_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    automationId: text("automation_id")
      .notNull()
      .references(() => databaseAutomation.id, { onDelete: "cascade" }),
    /** The row it runs on; null for runs a schedule or an incoming webhook started. */
    rowId: text("row_id").references(() => page.id, { onDelete: "cascade" }),
    /**
     * Who made the change that started it; null for anonymous form answers and lost accounts. A
     * test run: who started it, whom it runs as.
     */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * An answer to a public form: who published the form. An agent the run starts is held to what
     * they may open when no member stands behind the answer (see server/agents/run). No foreign
     * key on purpose: a publisher whose account is gone bounds the run to nothing rather than
     * leaving it unbounded.
     */
    boundTo: text("bound_to"),
    /** The row was added (rather than changed). */
    created: boolean("created").notNull().default(false),
    /** Ids of the properties the change touched. */
    changed: jsonb("changed").$type<string[]>().notNull().default([]),
    /** Started by a "date passed" trigger: the row's date it ran for (see automation_fire); else null. */
    basis: text("basis"),
    /** Started by a schedule or an incoming webhook; null for row runs. */
    origin: text("origin").$type<RunOrigin>(),
    /** The version it runs (automation_version); a test run of a draft runs `definition`. */
    version: integer("version").notNull().default(1),
    /** Started with "Test run" in the editor: real effects, marked in the history. */
    test: boolean("test").notNull().default(false),
    /** A test run of unpublished changes: the steps it runs. */
    definition: jsonb("definition").$type<AutomationDefinition>(),
    /**
     * What started it beyond the row: an incoming webhook's body, a schedule's time, a property
     * change's values before and after (by property id).
     */
    triggerData: jsonb("trigger_data").$type<Record<string, unknown>>(),
    /**
     * While it runs: the `trigger` and each step's output as later steps' templates see them, not
     * masked. Cleared when it finishes; the history keeps the masked copies in `steps`.
     */
    state: jsonb("state").$type<{ trigger?: unknown; outputs?: Record<string, unknown> }>(),
    status: text("status").$type<AutomationRunStatus>().notNull().default("pending"),
    steps: jsonb("steps").$type<AutomationStep[]>().notNull().default([]),
    /** The webhook body, made the first time it's sent, so every retry sends the same one. */
    payload: text("payload"),
    /** How many times the worker took the run since it last waited on purpose (a wait step, a retry). */
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("automation_run_due_idx").on(t.status, t.nextAt),
    index("automation_run_automation_idx").on(t.automationId, t.createdAt),
  ],
);

/**
 * The rows a "date passed" automation has run for, and for which value of their date (`basis`: a
 * date property's start, or the row's added or edited time, as server/automations/timed.ts writes
 * it). A row runs again only once its date has another value that is past too. Trashing a row
 * keeps its entry, so a restored row doesn't run again for the same date; it goes with the row or
 * the automation.
 */
export const automationFire = pgTable(
  "automation_fire",
  {
    automationId: text("automation_id")
      .notNull()
      .references(() => databaseAutomation.id, { onDelete: "cascade" }),
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    basis: text("basis").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.rowId] }), index("automation_fire_row_idx").on(t.rowId)],
);
