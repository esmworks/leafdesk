/**
 * Recording versions of an agent's setup (lib/agent-versions, server/agents/versions.ts): the
 * saving paths (manage.ts, skills.ts, schedules.ts, and permissions.ts for the pages shared with an
 * agent) call recordAgentVersion once their change is in.
 * It reads the setup back from the database, so a column added to the agent later is kept too. A
 * person's saves in quick succession add to their latest version (mergesInto); an agent keeps its
 * last MAX_AGENT_VERSIONS.
 *
 * Kept apart from versions.ts, which restores through those saving paths: they import this module.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lte, notInArray } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { agentDatabaseShare, agentSkill, agentVersion, pagePermission, schedule, workspaceAgent } from "@/db/schema";
import {
  changedParts,
  MAX_AGENT_VERSIONS,
  mergesInto,
  parseSnapshot,
  sameSnapshot,
  settingsOf,
  type AgentSnapshot,
  type AgentVersionKind,
  type SnapshotSchedule,
} from "@/lib/agent-versions";
import { AGENT_ACCESS_LEVELS } from "@/lib/agents";

export type Agent = typeof workspaceAgent.$inferSelect;
export type AgentVersionRow = typeof agentVersion.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Set while a change made of several saves (a restore) records its version itself. */
const quiet = new AsyncLocalStorage<true>();

/** Runs `fn` without its saves making versions: the caller records one when it's done. */
export const withoutVersions = <T>(fn: () => Promise<T>): Promise<T> => quiet.run(true, fn);

/** The agent's columns: their property and their SQL name (a snapshot's settings are keyed by it, as a migration reads them). */
export const agentColumns = () => Object.entries(getTableColumns(workspaceAgent)) as [keyof Agent, PgColumn][];

/** The agent's settings as a snapshot keeps them. */
export const agentSettings = (agent: Agent) => settingsOf(Object.fromEntries(agentColumns().map(([key, column]) => [column.name, agent[key]])));

/** The agent's setup as it is now. */
export async function readSnapshot(agent: Agent, tx: Tx | typeof db = db): Promise<AgentSnapshot> {
  const [skills, schedules, shares] = await Promise.all([
    tx.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, agent.id)).orderBy(asc(agentSkill.position), asc(agentSkill.createdAt)),
    tx
      .select()
      .from(schedule)
      .where(and(eq(schedule.agentId, agent.id), eq(schedule.kind, "agent")))
      .orderBy(asc(schedule.createdAt), asc(schedule.id)),
    // Shares an automation made (agent_database_share) come and go with the automation, which
    // shares and takes them back without making versions (manage.ts).
    tx
      .select({ pageId: pagePermission.pageId, level: pagePermission.level })
      .from(pagePermission)
      .where(
        and(
          eq(pagePermission.userId, agent.userId),
          inArray(pagePermission.level, [...AGENT_ACCESS_LEVELS]),
          notInArray(pagePermission.pageId, tx.select({ id: agentDatabaseShare.databaseId }).from(agentDatabaseShare).where(eq(agentDatabaseShare.agentId, agent.id))),
        ),
      )
      .orderBy(asc(pagePermission.pageId)),
  ]);
  return parseSnapshot({
    settings: agentSettings(agent),
    skills: skills.map((s) => s.pageId),
    schedules: schedules.map((s): SnapshotSchedule => ({ id: s.id, rule: s.rule, timeZone: s.timeZone, task: s.settings.task ?? "", databaseId: s.databaseId })),
    shares,
  });
}

type SaveOptions = { kind?: Exclude<AgentVersionKind, "baseline">; restoredFrom?: number };

/** Keeps the agent's setup as a new version, or adds it to the latest one (see the module comment). */
export async function saveVersion(userId: string | null, agentId: string, { kind = "changed", restoredFrom }: SaveOptions = {}): Promise<AgentVersionRow | null> {
  return db.transaction(async (tx) => {
    // One save at a time per agent, so two can't take the same number.
    const [agent] = await tx.select().from(workspaceAgent).where(eq(workspaceAgent.id, agentId)).for("update");
    if (!agent) return null;
    const snapshot = await readSnapshot(agent, tx);
    const [latest, previous] = await tx.select().from(agentVersion).where(eq(agentVersion.agentId, agentId)).orderBy(desc(agentVersion.number)).limit(2);
    const now = new Date();
    if (latest && kind === "changed") {
      if (sameSnapshot(parseSnapshot(latest.snapshot), snapshot)) return latest;
      if (mergesInto(latest, userId, now)) {
        const changes = previous ? changedParts(parseSnapshot(previous.snapshot), snapshot) : latest.changes;
        // Changed back to how the version before was: nothing of this one is left.
        if (changes && !changes.length) {
          await tx.delete(agentVersion).where(eq(agentVersion.id, latest.id));
          return previous;
        }
        const [merged] = await tx.update(agentVersion).set({ snapshot, changes, updatedAt: now }).where(eq(agentVersion.id, latest.id)).returning();
        return merged;
      }
    }
    const number = (latest?.number ?? 0) + 1;
    const [created] = await tx
      .insert(agentVersion)
      .values({
        agentId,
        number,
        kind,
        snapshot,
        changes: latest ? changedParts(parseSnapshot(latest.snapshot), snapshot) : null,
        restoredFrom: restoredFrom ?? null,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.delete(agentVersion).where(and(eq(agentVersion.agentId, agentId), lte(agentVersion.number, number - MAX_AGENT_VERSIONS)));
    return created;
  });
}

/**
 * Records the agent's setup after `userId` saved a change to it ("created": they made it). The
 * change is in already: a version that can't be kept is logged rather than failing the change.
 */
export async function recordAgentVersion(userId: string, agentId: string, kind: "created" | "changed" = "changed") {
  if (quiet.getStore()) return;
  try {
    await saveVersion(userId, agentId, { kind });
  } catch (error) {
    console.error("[agent versions]", error);
  }
}

/**
 * Records a version of the agent `principal` is the user of, if it's one: `userId` set or removed
 * its entry on a page (from the agent's settings, the page's Share menu or a tool).
 */
export async function recordAgentVersionOfUser(userId: string, principal: string) {
  if (quiet.getStore()) return;
  const [agent] = await db
    .select({ id: workspaceAgent.id })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.userId, principal), isNull(workspaceAgent.archivedAt)));
  if (agent) await recordAgentVersion(userId, agent.id);
}
