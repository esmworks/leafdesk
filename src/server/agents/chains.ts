/**
 * Chains of agents: agents that run one after another, each with its own task, each handed the
 * answer of the one before (pure part and limits in lib/agent-chains.ts). A chain is a schedule of
 * kind "agent_chain", its name and steps in the schedule's settings; it runs when someone clicks Run
 * now, and on its repeat rule when it `repeats`.
 *
 * Each step is an ordinary schedule run of its agent (source `schedule` with `chain`): held to the
 * access of whoever started the chain (who clicked, or who set it last for a scheduled run), who
 * must still be able to edit the agent when the step starts (run.ts asks), looking after the step's
 * database if it names one, and reported to that person. Only the chain's last run is reported:
 * the steps before it hand on instead (run.ts `finish` calls chainStepEnded). The next step starts
 * when one ends done; one that fails, is stopped, finds nothing new (finish_run `nothing_new`), or
 * read email or files on a person's computer (which another agent may not be handed) ends the chain
 * there. A step's answer reaches the next one framed as data from another agent, and counts as
 * others' words when its run read any (lib/agents.ts readOthersWords, the `received` step).
 *
 * A chain has one run going at a time (`agent_chain_run_going_idx`). Who may see, change, run and
 * delete one: those who can edit every agent it runs and open every database its steps look after.
 */
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentChainRun, agentRun, page, schedule, user, workspaceAgent, type WorkspaceRole } from "@/db/schema";
import {
  checkChainInput,
  type AgentChainInputError,
  type AgentChainRunStatus,
  type AgentChainRunView,
  type AgentChainStep,
  type AgentChainTrigger,
  type AgentChainView,
  MAX_CHAINS_PER_WORKSPACE,
} from "@/lib/agent-chains";
import { hasAgentLevel } from "@/lib/agent-sharing";
import { MAX_SCHEDULE_TASK, readEmail, type AgentRunCode, type AgentStepRecord, type RunSource } from "@/lib/agents";
import { readLocalFiles } from "@/lib/local-reads";
import { redactError } from "@/lib/redact";
import { nextOccurrence, parseRepeatRule, SCHEDULE_ERRORS, type ScheduleError } from "@/lib/schedule";
import { dayString, isTimeZone, localDay } from "@/lib/time-zone";

import { findMembership, pageAccessOf, requireMember } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { lockWorkspaceSchedules, MAX_SCHEDULES_PER_WORKSPACE, registerScheduleHandler, ScheduleRunError, type ScheduleRow } from "@/server/schedules";
import { startTriggered } from "@/server/triggers";
import { AgentError } from "./errors";
import { kickAgents } from "./kick";
import { agentLevels } from "./sharing";

/** How long after its step's run ended a chain's run still going is taken to have lost it (finish hands on at once). */
const LOST_AFTER_MS = 2 * 60_000;

type ChainRunRow = typeof agentChainRun.$inferSelect;

/** A chain as stored: its name, steps and whether it repeats, from its schedule's settings. */
const stepsOf = (row: ScheduleRow): AgentChainStep[] => row.settings.steps ?? [];

/** The input reason (lib/agent-chains) as the agents' error texts name it. */
const REASONS: Record<AgentChainInputError, string> = { name: "chainName", nameLength: "chainNameLength", steps: "chainSteps", task: "task", taskLength: "taskLength" };

/**
 * Whether `userId` may see, change and run chains with these steps: every agent still in the
 * workspace edited by them, every database opened. An agent removed since doesn't count: its step
 * ends the chain when reached.
 */
async function mayRun(userId: string, workspaceId: string, chains: AgentChainStep[][], role: WorkspaceRole): Promise<boolean[]> {
  const agentIds = [...new Set(chains.flat().map((s) => s.agentId))];
  const databaseIds = [...new Set(chains.flat().flatMap((s) => (s.databaseId ? [s.databaseId] : [])))];
  const [levels, present, opened] = await Promise.all([
    agentLevels(userId, workspaceId, agentIds, role),
    agentIds.length
      ? db
          .select({ id: workspaceAgent.id })
          .from(workspaceAgent)
          .where(and(inArray(workspaceAgent.id, agentIds), eq(workspaceAgent.workspaceId, workspaceId)))
          .then((rows) => new Set(rows.map((r) => r.id)))
      : new Set<string>(),
    Promise.all(databaseIds.map(async (id) => [id, (await pageAccessOf(userId, id)).level !== "none"] as const)).then((pairs) => new Map(pairs)),
  ]);
  return chains.map((steps) =>
    steps.every((s) => (!present.has(s.agentId) || hasAgentLevel(levels.get(s.agentId) ?? "none", "edit")) && (!s.databaseId || opened.get(s.databaseId) === true)),
  );
}

async function chainRow(workspaceId: string, chainId: string) {
  const [row] = await db
    .select()
    .from(schedule)
    .where(and(eq(schedule.id, chainId), eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "agent_chain")));
  return row;
}

/** The chain, for someone who may run it (chainNotFound otherwise, as for one that isn't there). */
async function requireChain(userId: string, workspaceId: string, chainId: string) {
  const membership = await requireMember(userId, workspaceId);
  const row = await chainRow(workspaceId, chainId);
  if (!row || !(await mayRun(userId, workspaceId, [stepsOf(row)], membership.role))[0]) throw new AgentError("chainNotFound", "Chain not found");
  return { row, membership };
}

/**
 * Ends a chain's run that still reads as going but whose step's run is gone, or ended a while ago
 * without handing on (a run ended somewhere that doesn't tell the chain). Returns the run as it is now.
 */
async function settleLost(chainRun: ChainRunRow, now = new Date()): Promise<ChainRunRow> {
  if (chainRun.status !== "running") return chainRun;
  const [stepRun] = chainRun.runId ? await db.select({ status: agentRun.status, finishedAt: agentRun.finishedAt }).from(agentRun).where(eq(agentRun.id, chainRun.runId)) : [];
  const ended = stepRun && (stepRun.status === "done" || stepRun.status === "failed");
  const lost = !stepRun ? chainRun.createdAt.getTime() < now.getTime() - LOST_AFTER_MS : ended && (stepRun.finishedAt?.getTime() ?? 0) < now.getTime() - LOST_AFTER_MS;
  if (!lost) return chainRun;
  const [closed] = await db
    .update(agentChainRun)
    .set({ status: stepRun?.status === "done" ? "stopped" : "failed", code: "lost", finishedAt: now })
    .where(and(eq(agentChainRun.id, chainRun.id), eq(agentChainRun.status, "running"), eq(agentChainRun.step, chainRun.step)))
    .returning();
  return closed ?? chainRun;
}

const runView = (r: ChainRunRow): AgentChainRunView => ({
  id: r.id,
  status: r.status,
  step: r.step,
  trigger: r.trigger,
  code: r.code,
  startedAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** The chains of a workspace someone may run, oldest first, each with its latest run. */
export async function listAgentChains(userId: string, workspaceId: string): Promise<AgentChainView[]> {
  const membership = await requireMember(userId, workspaceId);
  const all = await db
    .select()
    .from(schedule)
    .where(and(eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "agent_chain")))
    .orderBy(asc(schedule.createdAt));
  if (!all.length) return [];
  const allowed = await mayRun(userId, workspaceId, all.map(stepsOf), membership.role);
  const rows = all.filter((_, i) => allowed[i]);
  if (!rows.length) return [];

  const agentIds = [...new Set(rows.flatMap((r) => stepsOf(r).map((s) => s.agentId)))];
  const databaseIds = [...new Set(rows.flatMap((r) => stepsOf(r).flatMap((s) => (s.databaseId ? [s.databaseId] : []))))];
  const setterIds = [...new Set(rows.flatMap((r) => (r.runAs ? [r.runAs] : [])))];
  const [agents, databases, setters, latest] = await Promise.all([
    db
      .select({ id: workspaceAgent.id, name: workspaceAgent.name, icon: workspaceAgent.icon })
      .from(workspaceAgent)
      .where(and(inArray(workspaceAgent.id, agentIds), eq(workspaceAgent.workspaceId, workspaceId)))
      .then((found) => new Map(found.map((a) => [a.id, a]))),
    databaseIds.length
      ? db
          .select({ id: page.id, title: page.title })
          .from(page)
          .where(inArray(page.id, databaseIds))
          .then((found) => new Map(found.map((d) => [d.id, d.title])))
      : new Map<string, string>(),
    setterIds.length
      ? db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, setterIds))
          .then((found) => new Map(found.map((u) => [u.id, u.name])))
      : new Map<string, string>(),
    db
      .selectDistinctOn([agentChainRun.scheduleId])
      .from(agentChainRun)
      .where(
        inArray(
          agentChainRun.scheduleId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(agentChainRun.scheduleId, desc(agentChainRun.createdAt)),
  ]);
  const runs = new Map(await Promise.all(latest.map(async (r) => [r.scheduleId, await settleLost(r)] as const)));

  return rows.map((r) => {
    const run = runs.get(r.id);
    return {
      id: r.id,
      name: r.settings.name ?? "",
      steps: stepsOf(r).map((s) => {
        const agent = agents.get(s.agentId);
        return {
          agentId: s.agentId,
          agentName: agent?.name ?? "",
          agentIcon: agent?.icon ?? null,
          task: s.task,
          databaseId: s.databaseId,
          databaseTitle: s.databaseId ? (databases.get(s.databaseId) ?? null) : null,
        };
      }),
      repeats: r.settings.repeats === true,
      rule: r.rule,
      timeZone: r.timeZone,
      enabled: r.enabled,
      nextRunAt: r.enabled && r.nextRunAt ? r.nextRunAt.toISOString() : null,
      lastError: SCHEDULE_ERRORS.includes(r.lastError as ScheduleError) ? (r.lastError as ScheduleError) : null,
      setBy: r.runAs ? { id: r.runAs, name: setters.get(r.runAs) ?? "" } : null,
      run: run ? runView(run) : null,
    };
  });
}

/** A chain as given: its name, steps, and when it repeats (`repeats` false: only on a click; the rule is kept). */
export type AgentChainInput = { name?: unknown; steps?: unknown; repeats?: unknown; rule?: unknown; timeZone?: unknown };

/**
 * Adds a chain to the workspace, or changes one (`chainId`), as `userId` from now on: its scheduled
 * runs are held to their access. Turns it back on when it was paused; the next run is counted from now.
 */
export async function setAgentChain(userId: string, workspaceId: string, chainId: string | null, input: AgentChainInput, now = new Date()): Promise<string> {
  const membership = await requireMember(userId, workspaceId);
  const existing = chainId ? (await requireChain(userId, workspaceId, chainId)).row : undefined;
  const checked = checkChainInput({ name: input.name, steps: input.steps }, MAX_SCHEDULE_TASK);
  if (!checked.ok) throw new AgentError("invalid", "Invalid chain", { reason: REASONS[checked.reason] });
  const { name, steps } = checked;

  // Agents of this workspace, not archived, that they can edit; databases of it they can open.
  const agentIds = [...new Set(steps.map((s) => s.agentId))];
  const agents = await db
    .select({ id: workspaceAgent.id, archivedAt: workspaceAgent.archivedAt })
    .from(workspaceAgent)
    .where(and(inArray(workspaceAgent.id, agentIds), eq(workspaceAgent.workspaceId, workspaceId)));
  const levels = await agentLevels(userId, workspaceId, agentIds, membership.role);
  if (agents.length !== agentIds.length || agents.some((a) => a.archivedAt || !hasAgentLevel(levels.get(a.id) ?? "none", "edit"))) {
    throw new AgentError("invalid", "Choose agents you can edit", { reason: "chainAgent" });
  }
  for (const databaseId of new Set(steps.flatMap((s) => (s.databaseId ? [s.databaseId] : [])))) {
    const { page: found, level } = await pageAccessOf(userId, databaseId);
    if (!found || level === "none" || found.workspaceId !== workspaceId || found.kind !== "database" || found.archivedAt || found.isTemplate || found.inTemplate) {
      throw new AgentError("notADatabase", "Database not found");
    }
  }

  const timeZone = input.timeZone !== undefined ? input.timeZone : existing?.timeZone;
  if (!isTimeZone(timeZone)) throw new AgentError("invalid", "Invalid repeat rule or time zone", { reason: "repeat" });
  let ruleInput = input.rule !== undefined ? input.rule : existing?.rule;
  if (ruleInput && typeof ruleInput === "object" && !Array.isArray(ruleInput) && (ruleInput as { start?: unknown }).start === undefined) {
    ruleInput = { ...ruleInput, start: dayString(localDay(now.getTime(), timeZone)) };
  }
  const rule = parseRepeatRule(ruleInput);
  if (!rule) throw new AgentError("invalid", "Invalid repeat rule or time zone", { reason: "repeat" });
  const repeats = input.repeats !== undefined ? input.repeats === true : existing?.settings.repeats === true;

  const values = {
    rule,
    timeZone,
    settings: { name, steps, repeats },
    enabled: true,
    nextRunAt: repeats ? nextOccurrence(rule, timeZone, now) : null,
    lastError: null,
    failures: 0,
    runAs: userId,
  };
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceSchedules(tx, workspaceId);
    if (existing) {
      const [updated] = await tx.update(schedule).set(values).where(eq(schedule.id, existing.id)).returning({ id: schedule.id });
      if (!updated) throw new AgentError("chainNotFound", "Chain not found");
      return updated.id;
    }
    const [[chains], [inWorkspace]] = await Promise.all([
      tx
        .select({ n: count() })
        .from(schedule)
        .where(and(eq(schedule.workspaceId, workspaceId), eq(schedule.kind, "agent_chain"))),
      tx.select({ n: count() }).from(schedule).where(eq(schedule.workspaceId, workspaceId)),
    ]);
    if (chains.n >= MAX_CHAINS_PER_WORKSPACE) throw new AgentError("tooManySchedules", `A workspace has at most ${MAX_CHAINS_PER_WORKSPACE} chains`, { max: String(MAX_CHAINS_PER_WORKSPACE) });
    if (inWorkspace.n >= MAX_SCHEDULES_PER_WORKSPACE) {
      throw new AgentError("tooManySchedules", `A workspace has at most ${MAX_SCHEDULES_PER_WORKSPACE} schedules`, { max: String(MAX_SCHEDULES_PER_WORKSPACE) });
    }
    const [created] = await tx
      .insert(schedule)
      .values({ ...values, workspaceId, kind: "agent_chain", createdBy: userId })
      .returning({ id: schedule.id });
    return created.id;
  });
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "agent.chain_set",
    target: { type: "agent_chain", id, label: name },
    details: { steps: steps.length, repeats, ...(repeats ? { rule, timeZone } : {}), created: !existing || undefined },
  });
  return id;
}

/** Deletes a chain, for those who may run it; the step run under way goes on, and nothing after it starts. */
export async function removeAgentChain(userId: string, workspaceId: string, chainId: string) {
  const { row } = await requireChain(userId, workspaceId, chainId);
  await db.delete(schedule).where(eq(schedule.id, row.id));
  await recordAudit({ workspaceId, actorId: userId, action: "agent.chain_removed", target: { type: "agent_chain", id: row.id, label: row.settings.name ?? "" } });
}

/**
 * Starts a run of the chain as `startedBy`: its first step's run, queued. "busy" when one is still
 * going; throws AgentError("paused") when the first agent is paused, ("invalid") when it is gone.
 */
async function startChain(row: ScheduleRow, startedBy: string, trigger: AgentChainTrigger, scheduledFor?: string): Promise<"started" | "busy"> {
  const [first] = stepsOf(row);
  if (!first) throw new AgentError("invalid", "A chain needs steps", { reason: "chainSteps" });
  const [going] = await db
    .select()
    .from(agentChainRun)
    .where(and(eq(agentChainRun.scheduleId, row.id), eq(agentChainRun.status, "running")));
  if (going && (await settleLost(going)).status === "running") return "busy";
  try {
    await db.transaction(async (tx) => {
      const [made] = await tx.insert(agentChainRun).values({ workspaceId: row.workspaceId, scheduleId: row.id, startedBy, trigger }).returning({ id: agentChainRun.id });
      const { run } = await startTriggered({
        target: { agentId: first.agentId },
        workspaceId: row.workspaceId,
        source: { kind: "schedule", scheduleId: row.id, scheduledBy: startedBy, ...(first.databaseId ? { databaseId: first.databaseId } : {}), chain: { runId: made.id, step: 0 } },
        context: { actorId: startedBy, timeZone: row.timeZone, ...(scheduledFor ? { scheduledFor } : {}) },
        prompt: first.task,
        tx,
      });
      await tx.update(agentChainRun).set({ runId: run.id }).where(eq(agentChainRun.id, made.id));
    });
  } catch (error) {
    // Another click or the schedule started it meanwhile (agent_chain_run_going_idx).
    if ((error as { code?: unknown }).code === "23505" || (error as { cause?: { code?: unknown } }).cause?.code === "23505") return "busy";
    throw error;
  }
  kickAgents();
  return "started";
}

/** The first step's agent, as it is now: missing or archived ends the chain before it starts. */
async function firstAgent(row: ScheduleRow) {
  const [first] = stepsOf(row);
  if (!first) return undefined;
  const [agent] = await db
    .select({ archivedAt: workspaceAgent.archivedAt, enabled: workspaceAgent.enabled })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.id, first.agentId), eq(workspaceAgent.workspaceId, row.workspaceId)));
  return agent && !agent.archivedAt ? agent : undefined;
}

/** Run now: a run of the chain as `userId`, who gets its report. */
export async function runAgentChain(userId: string, workspaceId: string, chainId: string) {
  const { row } = await requireChain(userId, workspaceId, chainId);
  const agent = await firstAgent(row);
  if (!agent) throw new AgentError("invalid", "Choose agents you can edit", { reason: "chainAgent" });
  if (!agent.enabled) throw new AgentError("paused", "The first agent is paused");
  if ((await startChain(row, userId, "click")) === "busy") throw new AgentError("chainRunning", "The chain is still running");
}

registerScheduleHandler("agent_chain", async ({ schedule: row, runAs, at }) => {
  if (row.settings.repeats !== true) return false;
  const membership = await findMembership(runAs, row.workspaceId);
  if (!membership || !(await mayRun(runAs, row.workspaceId, [stepsOf(row)], membership.role))[0]) {
    throw new ScheduleRunError("accessLost", "Whoever set the chain can no longer edit its agents or open its databases");
  }
  const agent = await firstAgent(row);
  if (!agent) throw new ScheduleRunError("agentGone");
  // A paused agent doesn't run; the chain carries on once it is turned on again.
  if (!agent.enabled) return false;
  return (await startChain(row, runAs, "schedule", at.toISOString())) === "started";
});

/** How a step's run ended, as finish() has it. */
type StepEnding = { status: "done" | "failed"; code?: AgentRunCode | null; quiet?: boolean };

/**
 * A step of a chain ended (run.ts finish, and an approval that expired): starts the next step when
 * it ended done, or ends the chain's run. True when the next step started, so the run isn't
 * reported (the chain's last run is). Never throws.
 */
export async function chainStepEnded(
  run: { id: string; workspaceId: string; source: RunSource; steps: readonly AgentStepRecord[] },
  ending: StepEnding,
): Promise<boolean> {
  if (run.source.kind !== "schedule" || !run.source.chain) return false;
  const { scheduleId, scheduledBy } = run.source;
  const { runId: chainRunId, step } = run.source.chain;
  const close = (status: AgentChainRunStatus, code: string | null) =>
    db
      .update(agentChainRun)
      .set({ status, code, finishedAt: new Date() })
      .where(and(eq(agentChainRun.id, chainRunId), eq(agentChainRun.status, "running"), eq(agentChainRun.step, step)));
  try {
    const [chainRun] = await db.select().from(agentChainRun).where(eq(agentChainRun.id, chainRunId));
    if (!chainRun || chainRun.status !== "running" || chainRun.step !== step) return false;
    const [row] = await db.select().from(schedule).where(eq(schedule.id, scheduleId));
    if (!row) return false;
    const steps = stepsOf(row);
    if (ending.status !== "done") {
      await close(ending.code === "stopped" ? "stopped" : "failed", ending.code ?? null);
      return false;
    }
    if (ending.quiet) {
      await close("stopped", "nothingNew");
      return false;
    }
    if (step >= steps.length - 1) {
      await close("done", null);
      return false;
    }
    // What it read in a person's mail or on their computer stays with that person and agent.
    if (readEmail(run.steps) || readLocalFiles(run.steps)) {
      await close("stopped", "privateRead");
      return false;
    }
    const next = steps[step + 1];
    const [agent] = await db
      .select({ archivedAt: workspaceAgent.archivedAt })
      .from(workspaceAgent)
      .where(and(eq(workspaceAgent.id, next.agentId), eq(workspaceAgent.workspaceId, row.workspaceId)));
    if (!agent || agent.archivedAt) {
      await close("failed", "agentGone");
      return false;
    }
    const handed = await db.transaction(async (tx) => {
      const [moved] = await tx
        .update(agentChainRun)
        .set({ step: step + 1 })
        .where(and(eq(agentChainRun.id, chainRunId), eq(agentChainRun.status, "running"), eq(agentChainRun.step, step)))
        .returning({ id: agentChainRun.id });
      if (!moved) return false;
      const { run: queued } = await startTriggered({
        target: { agentId: next.agentId },
        workspaceId: row.workspaceId,
        source: {
          kind: "schedule",
          scheduleId: row.id,
          scheduledBy,
          ...(next.databaseId ? { databaseId: next.databaseId } : {}),
          chain: { runId: chainRunId, step: step + 1, after: run.id },
        },
        context: { actorId: scheduledBy, timeZone: row.timeZone },
        prompt: next.task,
        tx,
      });
      await tx.update(agentChainRun).set({ runId: queued.id }).where(eq(agentChainRun.id, chainRunId));
      return true;
    });
    if (handed) kickAgents();
    return handed;
  } catch (error) {
    console.error("[agents] could not hand a chain on", redactError(error));
    await close("failed", "lost").catch(() => {});
    return false;
  }
}

/** A chain's name and size, for a step's run: what it tells the agent, and what its run list shows. */
export async function chainNames(scheduleIds: string[]): Promise<Map<string, { name: string; steps: number }>> {
  if (!scheduleIds.length) return new Map();
  const rows = await db
    .select({ id: schedule.id, settings: schedule.settings })
    .from(schedule)
    .where(and(inArray(schedule.id, scheduleIds), eq(schedule.kind, "agent_chain")));
  return new Map(rows.map((r) => [r.id, { name: r.settings.name ?? "", steps: r.settings.steps?.length ?? 0 }]));
}
