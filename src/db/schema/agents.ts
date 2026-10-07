import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AgentRunCode, AgentRunContext, AgentRunSource, AgentRunStatus, AgentRunUsage, AgentStepRecord } from "@/lib/agents";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * An agent of a workspace (see lib/agents.ts and server/agents). It acts as its own user (`userId`,
 * a bot user that can't sign in, a guest of the workspace), so it sees only the pages shared with
 * it and its changes show its name. Agents aren't deleted, only archived: their user stays, so
 * what they did keeps their name.
 */
export const workspaceAgent = pgTable(
  "workspace_agent",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The agent's own user. */
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    /** Paused agents don't run; their queued runs end as `agentDisabled`. */
    enabled: boolean("enabled").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("workspace_agent_workspace_idx").on(t.workspaceId)],
);

/**
 * One time an agent ran: what started it, what it did and how it ended. Runs wait here
 * (`pending`, from `nextAt`) until the agents' worker takes them, so a restart loses nothing.
 * Finished runs are kept AGENT_RUN_HISTORY_DAYS, as the agent's history.
 */
export const agentRun = pgTable(
  "agent_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    source: jsonb("source").$type<AgentRunSource>().notNull(),
    context: jsonb("context").$type<AgentRunContext>().notNull(),
    /** The task the run was given (an automation action's prompt). */
    prompt: text("prompt").notNull().default(""),
    status: text("status").$type<AgentRunStatus>().notNull().default("pending"),
    code: text("code").$type<AgentRunCode>(),
    error: text("error"),
    steps: jsonb("steps").$type<AgentStepRecord[]>().notNull().default([]),
    /** What the agent said at the end. */
    answer: text("answer").notNull().default(""),
    usage: jsonb("usage").$type<AgentRunUsage>(),
    /** How many times the worker took the run. */
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_run_due_idx").on(t.status, t.nextAt), index("agent_run_agent_idx").on(t.agentId, t.createdAt)],
);
