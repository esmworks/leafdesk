/**
 * An agent's schedules: those who can edit an agent (sharing.ts) set when it runs on its own, on a repeat rule in a time zone
 * (lib/schedule, server/schedules), with a task and, if they like, a database it looks after. On a
 * database the run may change and comment on the database's rows (MAX_SCHEDULED_WRITES); on none it
 * only reads. When the run ends, whoever set the schedule finds what it did (or why it failed) in
 * their inbox (`agent_report`, see run.ts).
 *
 * A schedule's run is held to the access of whoever set it last, as a run someone asks for is held
 * to theirs, and stands behind what it reads as they do. The schedule pauses when it can't run any
 * more: the agent archived ("agentGone"), that person no longer able to edit the agent or to open
 * the database ("accessLost"). A paused agent, a database in the trash or one not shared with the
 * agent skips runs instead, and a schedule whose last run still waits (for its turn, or for an owner
 * to approve a call) skips one. A run over a database with rows no one in the workspace stands
 * behind (an anonymous form answer) asks an owner before each connection tool (run.ts).
 *
 * The server imports this module for its handler (server.ts); the scheduler itself doesn't, so
 * modules it is imported by stay clear of the agents' worker.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, page, schedule, user, workspaceAgent } from "@/db/schema";
import { hasAgentLevel } from "@/lib/agent-sharing";
import { MAX_AGENT_SCHEDULES, MAX_SCHEDULE_TASK, type AgentScheduleView } from "@/lib/agents";
import { nextOccurrence, parseRepeatRule, SCHEDULE_ERRORS, type ScheduleError } from "@/lib/schedule";
import { dayString, isTimeZone, localDay } from "@/lib/time-zone";
import { findMembership, pageAccessOf, pageVisibleTo } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { lockWorkspaceSchedules, MAX_SCHEDULES_PER_WORKSPACE, registerScheduleHandler, ScheduleRunError, type ScheduleRow } from "@/server/schedules";
import { AgentError, agentFor } from "./manage";
import { agentLevel as levelOnAgent } from "./sharing";
import { queueAgentRun } from "./run";
import { recordAgentVersion } from "./version-record";

/**
 * A schedule as set: a new one needs `rule`, `timeZone` and `task`; a change keeps what it leaves
 * out (a task null too, for one the owner can't read). A rule without `start` starts today, in the
 * time zone.
 */
export type AgentScheduleInput = {
  rule?: unknown;
  timeZone?: unknown;
  task?: unknown;
  /** A database of the agent's workspace the owner can open; null for none. */
  databaseId?: unknown;
};

const agentLevel = (level: string): AgentScheduleView["agentAccess"] => (level === "full" ? "edit" : (level as AgentScheduleView["agentAccess"]));

/** Schedules as `userId` (an owner) sees them. */
async function viewSchedules(userId: string, agentUserId: string, rows: ScheduleRow[]): Promise<AgentScheduleView[]> {
  const databaseIds = [...new Set(rows.flatMap((r) => (r.databaseId ? [r.databaseId] : [])))];
  const databases = new Map(
    databaseIds.length
      ? (
          await db
            .select({ id: page.id, title: page.title, icon: page.icon })
            .from(page)
            .where(and(inArray(page.id, databaseIds), pageVisibleTo(userId)))
        ).map((d) => [d.id, d])
      : [],
  );
  const access = new Map(await Promise.all(databaseIds.map(async (id) => [id, agentLevel((await pageAccessOf(agentUserId, id)).level)] as const)));
  const setterIds = [...new Set(rows.flatMap((r) => (r.runAs ? [r.runAs] : [])))];
  const setters = new Map(
    setterIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, setterIds))).map((u) => [u.id, u.name]) : [],
  );
  return rows.map((r) => {
    const database = r.databaseId ? databases.get(r.databaseId) : undefined;
    // The task may name what is in the database: only those who can open it read it.
    const open = !r.databaseId || Boolean(database);
    return {
      id: r.id,
      rule: r.rule,
      timeZone: r.timeZone,
      task: open ? (r.settings.task ?? "") : "",
      taskHidden: !open,
      databaseId: r.databaseId,
      databaseTitle: database?.title ?? null,
      databaseIcon: database?.icon ?? null,
      agentAccess: r.databaseId ? (access.get(r.databaseId) ?? "none") : null,
      enabled: r.enabled,
      nextRunAt: r.enabled && r.nextRunAt ? r.nextRunAt.toISOString() : null,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastError: SCHEDULE_ERRORS.includes(r.lastError as ScheduleError) && r.lastError !== "dashboardGone" ? (r.lastError as AgentScheduleView["lastError"]) : null,
      setBy: r.runAs ? { id: r.runAs, name: setters.get(r.runAs) ?? "" } : null,
    };
  });
}

async function schedulesOf(agentId: string) {
  return db
    .select()
    .from(schedule)
    .where(and(eq(schedule.agentId, agentId), eq(schedule.kind, "agent")))
    .orderBy(schedule.createdAt);
}

/** An agent's schedules, oldest first, for anyone it is shared with. */
export async function listAgentSchedules(userId: string, agentId: string): Promise<AgentScheduleView[]> {
  const agent = await agentFor(userId, agentId, "interact");
  return viewSchedules(userId, agent.userId, await schedulesOf(agent.id));
}

/**
 * A database of the workspace `userId` can open, to look after on a schedule. One in the trash only
 * when the schedule already looks after it (`kept`): its runs skip until it comes back.
 */
async function requireScheduleDatabase(userId: string, workspaceId: string, databaseId: string, kept: boolean) {
  const { page: found, level } = await pageAccessOf(userId, databaseId);
  if (!found || level === "none" || found.workspaceId !== workspaceId || found.kind !== "database" || (found.archivedAt && !kept) || found.isTemplate || found.inTemplate) {
    throw new AgentError("notADatabase", "Database not found");
  }
  return found;
}

function checkTask(value: unknown) {
  const task = typeof value === "string" ? value.trim() : "";
  if (!task) throw new AgentError("invalid", "A schedule needs a task", { reason: "task" });
  if (task.length > MAX_SCHEDULE_TASK) throw new AgentError("invalid", `A task has at most ${MAX_SCHEDULE_TASK} characters`, { reason: "taskLength" });
  return task;
}

/**
 * Adds a schedule to an agent, or changes one (`scheduleId`), as `userId` from now on: its runs are
 * held to their access. Turns it back on when it was paused; the next run is counted from now.
 */
export async function setAgentSchedule(
  userId: string,
  agentId: string,
  scheduleId: string | null,
  input: AgentScheduleInput,
  now = new Date(),
): Promise<AgentScheduleView> {
  const agent = await agentFor(userId, agentId, "edit");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change its schedules");
  let existing: ScheduleRow | undefined;
  if (scheduleId) {
    [existing] = await db
      .select()
      .from(schedule)
      .where(and(eq(schedule.id, scheduleId), eq(schedule.agentId, agent.id), eq(schedule.kind, "agent")));
    if (!existing) throw new AgentError("scheduleNotFound", "Schedule not found");
  }
  const timeZone = input.timeZone !== undefined ? input.timeZone : existing?.timeZone;
  if (!isTimeZone(timeZone)) throw new AgentError("invalid", "Invalid repeat rule or time zone", { reason: "repeat" });
  let ruleInput = input.rule !== undefined ? input.rule : existing?.rule;
  if (ruleInput && typeof ruleInput === "object" && !Array.isArray(ruleInput) && (ruleInput as { start?: unknown }).start === undefined) {
    ruleInput = { ...ruleInput, start: dayString(localDay(now.getTime(), timeZone)) };
  }
  const rule = parseRepeatRule(ruleInput);
  if (!rule) throw new AgentError("invalid", "Invalid repeat rule or time zone", { reason: "repeat" });
  const task = checkTask(input.task !== undefined && input.task !== null ? input.task : existing?.settings.task);
  const databaseInput = input.databaseId !== undefined ? input.databaseId : (existing?.databaseId ?? null);
  if (databaseInput !== null && typeof databaseInput !== "string") throw new AgentError("notADatabase", "Database not found");
  const databaseId = databaseInput || null;
  // Whoever sets it runs it from now on: they need to be able to open the database too.
  if (databaseId) await requireScheduleDatabase(userId, agent.workspaceId, databaseId, databaseId === existing?.databaseId);
  const values = {
    rule,
    timeZone,
    settings: { task },
    databaseId,
    enabled: true,
    nextRunAt: nextOccurrence(rule, timeZone, now),
    lastError: null,
    runAs: userId,
  };

  const id = await db.transaction(async (tx) => {
    // Counted under the lock on the workspace's schedules, so two added at once can't both pass.
    await lockWorkspaceSchedules(tx, agent.workspaceId);
    if (existing) {
      const [updated] = await tx
        .update(schedule)
        .set(values)
        .where(eq(schedule.id, existing.id))
        .returning({ id: schedule.id });
      // Removed by another owner meanwhile.
      if (!updated) throw new AgentError("scheduleNotFound", "Schedule not found");
      return updated.id;
    }
    const [[ofAgent], [inWorkspace]] = await Promise.all([
      tx.select({ n: count() }).from(schedule).where(eq(schedule.agentId, agent.id)),
      tx.select({ n: count() }).from(schedule).where(eq(schedule.workspaceId, agent.workspaceId)),
    ]);
    if (ofAgent.n >= MAX_AGENT_SCHEDULES) throw new AgentError("tooManySchedules", `An agent has at most ${MAX_AGENT_SCHEDULES} schedules`, { max: String(MAX_AGENT_SCHEDULES) });
    if (inWorkspace.n >= MAX_SCHEDULES_PER_WORKSPACE) {
      throw new AgentError("tooManySchedules", `A workspace has at most ${MAX_SCHEDULES_PER_WORKSPACE} schedules`, { max: String(MAX_SCHEDULES_PER_WORKSPACE) });
    }
    const [created] = await tx
      .insert(schedule)
      .values({ ...values, workspaceId: agent.workspaceId, kind: "agent", agentId: agent.id, createdBy: userId })
      .returning({ id: schedule.id });
    return created.id;
  });
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.schedule_set",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { name: agent.name, scheduleId: id, rule, timeZone, ...(databaseId ? { databaseId } : {}), created: !scheduleId || undefined },
  });
  await recordAgentVersion(userId, agent.id);
  const [row] = await db.select().from(schedule).where(eq(schedule.id, id));
  return (await viewSchedules(userId, agent.userId, [row]))[0];
}

/** Removes one of an agent's schedules, for those who can edit the agent; runs it already started go on. */
export async function removeAgentSchedule(userId: string, agentId: string, scheduleId: string) {
  const agent = await agentFor(userId, agentId, "edit");
  const [removed] = await db
    .delete(schedule)
    .where(and(eq(schedule.id, scheduleId), eq(schedule.agentId, agent.id), eq(schedule.kind, "agent")))
    .returning({ id: schedule.id });
  if (!removed) throw new AgentError("scheduleNotFound", "Schedule not found");
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.schedule_removed",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { name: agent.name, scheduleId },
  });
  await recordAgentVersion(userId, agent.id);
}

/** Whether the schedule's last run still waits or is under way: a schedule has one run at a time. */
async function runWaiting(row: ScheduleRow) {
  const [waiting] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.agentId, row.agentId!),
        inArray(agentRun.status, ["pending", "running", "awaiting_approval"]),
        sql`${agentRun.source}->>'kind' = 'schedule'`,
        sql`${agentRun.source}->>'scheduleId' = ${row.id}`,
      ),
    )
    .limit(1);
  return Boolean(waiting);
}

registerScheduleHandler("agent", async ({ schedule: row, runAs, at }) => {
  if (!row.agentId) throw new ScheduleRunError("agentGone");
  const [agent] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, row.agentId));
  if (!agent || agent.archivedAt) throw new ScheduleRunError("agentGone");
  // A paused agent doesn't run; its schedules carry on once it is turned on again.
  if (!agent.enabled) return false;
  const membership = await findMembership(runAs, row.workspaceId);
  if (!membership || !hasAgentLevel(await levelOnAgent(runAs, agent, membership.role), "edit")) {
    throw new ScheduleRunError("accessLost", "Whoever set the schedule can no longer edit the agent");
  }
  if (row.databaseId) {
    const { page: database, level } = await pageAccessOf(runAs, row.databaseId);
    if (!database || database.kind !== "database") throw new ScheduleRunError("accessLost", "The database is gone");
    // A database in the trash isn't looked after; the schedule carries on if it comes back.
    if (database.archivedAt) return false;
    if (level === "none") throw new ScheduleRunError("accessLost", "Whoever set the schedule can no longer open the database");
    // Not shared with the agent (the tab warns): no run that could only fail; it runs once shared.
    if ((await pageAccessOf(agent.userId, row.databaseId)).level === "none") return false;
  }
  if (await runWaiting(row)) return false;
  await queueAgentRun({
    agentId: agent.id,
    workspaceId: row.workspaceId,
    source: { kind: "schedule", scheduleId: row.id, scheduledBy: runAs, ...(row.databaseId ? { databaseId: row.databaseId } : {}) },
    context: { actorId: runAs, scheduledFor: at.toISOString(), timeZone: row.timeZone },
    prompt: row.settings.task ?? "",
  });
  return true;
});
