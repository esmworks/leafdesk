import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentSnapshot, AgentVersionKind } from "@/lib/agent-versions";
import { workspaceAgent } from "./agents";
import { user } from "./auth";

/**
 * A saved setup of an agent (see server/agents/versions.ts): its settings, skills, schedules and the
 * pages shared with it, as they were after a change. Numbered from 1 per agent; a person's saves in
 * quick succession update the latest version instead of adding one, and the oldest go past
 * MAX_AGENT_VERSIONS.
 */
export const agentVersion = pgTable(
  "agent_version",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    kind: text("kind").$type<AgentVersionKind>().notNull().default("changed"),
    snapshot: jsonb("snapshot").$type<AgentSnapshot>().notNull(),
    /** What differs from the version before (lib/agent-versions changedParts); null: not known. */
    changes: jsonb("changes").$type<string[]>(),
    /** "restored": the number of the version brought back. */
    restoredFrom: integer("restored_from"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last save it holds: saves that follow soon after by the same person merge into it. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_version_number_idx").on(t.agentId, t.number)],
);
