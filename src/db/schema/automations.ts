import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AutomationAction,
  AutomationRunStatus,
  AutomationStep,
  AutomationTrigger,
} from "@/lib/automations";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * A database automation (see server/automations): when its trigger matches a row write, its
 * actions run once, in order, as the person who last saved it, with their access at the time.
 * People with full access to the database manage them; they go with the database.
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
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("database_automation_database_idx").on(t.databaseId)],
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
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Who made the change that started it; null for anonymous form answers and lost accounts. */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** The row was added (rather than changed). */
    created: boolean("created").notNull().default(false),
    /** Ids of the properties the change touched. */
    changed: jsonb("changed").$type<string[]>().notNull().default([]),
    status: text("status").$type<AutomationRunStatus>().notNull().default("pending"),
    steps: jsonb("steps").$type<AutomationStep[]>().notNull().default([]),
    /** The webhook body, made the first time it's sent, so every retry sends the same one. */
    payload: text("payload"),
    /** How many times the worker took the run. */
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
