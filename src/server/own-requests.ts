/**
 * Own requests: a question a person asks the AI chat on a schedule (schedule kind `own_request`),
 * with no agent. Each time it comes round it is asked as them, with their access, model and limits,
 * as if they had typed it: a run of their own AI chat (`agent_run` with no agent, source
 * `assistant` with `scheduleId`), started through the trigger layer (server/triggers.ts) in one
 * conversation of theirs kept for the schedule (key `schedule:<id>`), so the answers line up in
 * their AI chat. The agents' worker takes the run (agents/run.ts runInSlot → ai-chat.ts
 * resumeChatRun) and its end counts toward the schedule's failures in a row (server/schedules.ts).
 *
 * Only whoever set it lists, changes or removes it. It only reads (`read`) unless they chose `auto`;
 * never `ask`, which would wait with no one there. An `auto` answer that read others' words asks
 * before changing anything, as the chat does: the run then waits in the conversation for them, and
 * the schedule skips its times until it ends. AI off for the workspace skips its times too; whoever
 * set it leaving the workspace pauses it.
 *
 * The server imports this module for its handler (server.ts), as it does agents/schedules.ts.
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, schedule, user } from "@/db/schema";
import type { AssistantRunSource } from "@/lib/agents";
import { MAX_SCHEDULE_TASK } from "@/lib/agents";
import { nextOccurrence, parseRepeatRule, SCHEDULE_ERRORS, type ScheduleError } from "@/lib/schedule";
import { dayString, isTimeZone, localDay } from "@/lib/time-zone";
import type { TriggerView } from "@/lib/triggers";
import { findMembership, requireMembership } from "@/server/access";
import { AgentError } from "@/server/agents/errors";
import { aiAvailable } from "@/server/ai-writing";
import { lockWorkspaceSchedules, MAX_SCHEDULES_PER_WORKSPACE, registerScheduleHandler, ScheduleRunError, type ScheduleRow } from "@/server/schedules";
import { startTriggered } from "@/server/triggers";

/** Own requests a person may keep in a workspace. */
export const MAX_OWN_REQUESTS = 10;

export type OwnRequestInput = {
  rule?: unknown;
  timeZone?: unknown;
  task?: unknown;
  /** "read" (the default) or "auto". */
  mode?: unknown;
};

export type OwnRequestView = Extract<TriggerView, { kind: "schedule" }>;

/** The person's own requests in the workspace, oldest first. */
async function ownRows(userId: string, workspaceId: string) {
  return db
    .select()
    .from(schedule)
    .where(and(eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "own_request"), eq(schedule.runAs, userId)))
    .orderBy(schedule.createdAt);
}

export async function viewOwnRequests(rows: ScheduleRow[]): Promise<OwnRequestView[]> {
  const setterIds = [...new Set(rows.flatMap((r) => (r.runAs ? [r.runAs] : [])))];
  const names = new Map(setterIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, setterIds))).map((u) => [u.id, u.name]) : []);
  return rows.map((r) => ({
    kind: "schedule",
    conversation: "keyed",
    id: r.id,
    scheduleKind: "own_request",
    enabled: r.enabled,
    rule: r.rule,
    timeZone: r.timeZone,
    task: r.settings.task ?? "",
    taskHidden: false,
    databaseId: null,
    nextRunAt: r.enabled && r.nextRunAt ? r.nextRunAt.toISOString() : null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastError: SCHEDULE_ERRORS.includes(r.lastError as ScheduleError) ? (r.lastError as ScheduleError) : null,
    failures: r.failures,
    setBy: r.runAs ? { id: r.runAs, name: names.get(r.runAs) ?? "" } : null,
  }));
}

/** The person's own requests in a workspace they are in. */
export async function listOwnRequests(userId: string, workspaceId: string): Promise<OwnRequestView[]> {
  await requireMembership(userId, workspaceId);
  return viewOwnRequests(await ownRows(userId, workspaceId));
}

function checkTask(value: unknown) {
  const task = typeof value === "string" ? value.trim() : "";
  if (!task) throw new AgentError("invalid", "A schedule needs a task", { reason: "task" });
  if (task.length > MAX_SCHEDULE_TASK) throw new AgentError("invalid", `A task has at most ${MAX_SCHEDULE_TASK} characters`, { reason: "taskLength" });
  return task;
}

/**
 * Adds an own request (`scheduleId` null) or changes one of the person's. Turns it back on when it
 * was off (paused, or after failing again and again) and counts its failures from 0 again; the
 * next time is counted from now. A rule without `start` starts today, in the time zone.
 */
export async function setOwnRequest(userId: string, workspaceId: string, scheduleId: string | null, input: OwnRequestInput, now = new Date()): Promise<OwnRequestView> {
  await requireMembership(userId, workspaceId);
  let existing: ScheduleRow | undefined;
  if (scheduleId) {
    [existing] = (await ownRows(userId, workspaceId)).filter((r) => r.id === scheduleId);
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
  const task = checkTask(input.task !== undefined ? input.task : existing?.settings.task);
  // Anything but `auto` only reads.
  const mode: "read" | "auto" = (input.mode !== undefined ? input.mode : existing?.settings.mode) === "auto" ? "auto" : "read";
  const values = { rule, timeZone, settings: { task, mode }, enabled: true, nextRunAt: nextOccurrence(rule, timeZone, now), lastError: null, failures: 0, runAs: userId };
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceSchedules(tx, workspaceId);
    if (existing) {
      const [updated] = await tx.update(schedule).set(values).where(eq(schedule.id, existing.id)).returning({ id: schedule.id });
      if (!updated) throw new AgentError("scheduleNotFound", "Schedule not found");
      return updated.id;
    }
    const [[mine], [inWorkspace]] = await Promise.all([
      tx
        .select({ n: count() })
        .from(schedule)
        .where(and(eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "own_request"), eq(schedule.runAs, userId))),
      tx.select({ n: count() }).from(schedule).where(eq(schedule.workspaceId, workspaceId)),
    ]);
    if (mine.n >= MAX_OWN_REQUESTS) throw new AgentError("tooManySchedules", `A person has at most ${MAX_OWN_REQUESTS} requests on a schedule`, { max: String(MAX_OWN_REQUESTS) });
    if (inWorkspace.n >= MAX_SCHEDULES_PER_WORKSPACE) {
      throw new AgentError("tooManySchedules", `A workspace has at most ${MAX_SCHEDULES_PER_WORKSPACE} schedules`, { max: String(MAX_SCHEDULES_PER_WORKSPACE) });
    }
    const [created] = await tx
      .insert(schedule)
      .values({ ...values, workspaceId, kind: "own_request", createdBy: userId })
      .returning({ id: schedule.id });
    return created.id;
  });
  const [row] = await db.select().from(schedule).where(eq(schedule.id, id));
  return (await viewOwnRequests([row]))[0];
}

/** Removes one of the person's own requests; an answer it started goes on. */
export async function removeOwnRequest(userId: string, workspaceId: string, scheduleId: string) {
  await requireMembership(userId, workspaceId);
  const [removed] = await db
    .delete(schedule)
    .where(and(eq(schedule.id, scheduleId), eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "own_request"), eq(schedule.runAs, userId)))
    .returning({ id: schedule.id });
  if (!removed) throw new AgentError("scheduleNotFound", "Schedule not found");
}

/** Whether the request's last answer still waits, is under way or waits on the person: one at a time. */
async function answerWaiting(row: ScheduleRow) {
  const [waiting] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        isNull(agentRun.agentId),
        inArray(agentRun.status, ["pending", "running", "awaiting_approval"]),
        sql`${agentRun.source}->>'scheduleId' = ${row.id}`,
      ),
    )
    .limit(1);
  return Boolean(waiting);
}

registerScheduleHandler("own_request", async ({ schedule: row, runAs, at }) => {
  // Whoever set it left the workspace: it pauses until someone sets it again (only they can).
  if (!(await findMembership(runAs, row.workspaceId))) throw new ScheduleRunError("accessLost", "Whoever set the request is no longer in the workspace");
  // AI off: nothing to ask; it carries on once AI is back.
  if (!(await aiAvailable(row.workspaceId))) return false;
  if (await answerWaiting(row)) return false;
  const source: AssistantRunSource = {
    kind: "assistant",
    userId: runAs,
    // Set by the trigger layer to the conversation kept for the schedule.
    conversationId: "",
    scope: null,
    skillId: null,
    model: null,
    thinking: "balanced",
    mode: row.settings.mode === "auto" ? "auto" : "read",
    timeZone: row.timeZone,
    files: [],
    replaced: 0,
    scheduleId: row.id,
  };
  await startTriggered({
    target: { self: runAs },
    workspaceId: row.workspaceId,
    source,
    context: { actorId: runAs, scheduledFor: at.toISOString(), timeZone: row.timeZone },
    prompt: row.settings.task ?? "",
    conversation: { rule: "keyed", key: `schedule:${row.id}` },
  });
  return true;
});
