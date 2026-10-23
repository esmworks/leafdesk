import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pendingChange, user, workspaceAgent } from "@/db/schema";
import { forEachOf, MAX_STEP_MESSAGE, stepIds, type ApprovalAction, type ApprovalState, type AutomationAction } from "@/lib/automations";
import { resolveText, type TemplateScope } from "@/lib/automation-templates";
import { pageLabel } from "@/lib/labels";
import { MAX_PENDING_REASON, type ApprovalNextStep, type ApprovalPayload } from "@/lib/pending-changes";
import { findMembership, resolvePageAccess } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { getProperties } from "@/server/databases";
import { notifyReviewers, signalQueue } from "@/server/pending-changes";

/**
 * An automation's approval step (lib/automations ApprovalAction). The first time a run reaches it,
 * it asks: the people it names and those the row's person properties name (members who can open
 * the row) get an entry in the "For review" queue (kind `automation_approval`, linked to the run)
 * and a "review" notification, and the run waits in the queue until the entry expires. Answering
 * it wakes the run (server/pending-changes.ts, then queue.ts wakeRun); the worker reads the answer
 * from the entry, so an answer counts once however often the run is taken: approved, the next
 * step runs; rejected, the run stops; unanswered in time, it stops or goes on.
 */

const DAY_MS = 24 * 60 * 60_000;

type Run = { id: string; rowId: string | null; actorId: string | null; test: boolean; version: number };
type Automation = { id: string; name: string; databaseId: string; workspaceId: string };
type Row = { id: string; properties: Record<string, unknown> } | null;

/** Nobody the step names can be asked: the run fails with why. */
export class ApprovalStepError extends Error {
  readonly code = "noApprovers";
}

/**
 * Who an approval step asks: its people and the people in the row's person properties, as long as
 * they are members of the workspace (not agents) and can open the row (the database for a run
 * without one). In the order named, each once.
 */
export async function resolveApprovers(automation: Automation, row: Row, action: ApprovalAction): Promise<{ id: string; name: string }[]> {
  const fromRow = row
    ? action.propertyIds.flatMap((id) => {
        const value = row.properties[id];
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      })
    : [];
  const candidates = [...new Set([...action.userIds, ...fromRow])];
  if (!candidates.length) return [];
  const people = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(and(inArray(user.id, candidates), notAgentUser(user.id)));
  const target = row?.id ?? automation.databaseId;
  const out: { id: string; name: string }[] = [];
  for (const id of candidates) {
    const person = people.find((p) => p.id === id);
    if (!person || !(await findMembership(id, automation.workspaceId))) continue;
    const { level } = await resolvePageAccess(id, target).catch(() => ({ level: "none" as const }));
    if (level !== "none") out.push(person);
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/\{\{[^{}]*\}\}/g, "x")).host;
  } catch {
    return url.slice(0, 80);
  }
};

/**
 * The steps after `index`, each as a short line (lib/pending-changes ApprovalNextStep): property
 * names, a database's title, people's or an agent's name, a host, minutes or a message, named as
 * they are now. The approver reads it to know what approving lets happen.
 */
export async function nextStepsOf(actions: AutomationAction[], index: number, databaseId: string): Promise<ApprovalNextStep[]> {
  const ids = stepIds(actions);
  const later = actions.slice(index + 1);
  const sourceOf = (a: AutomationAction) => {
    const over = forEachOf(a);
    const source = over ? actions[ids.indexOf(over)] : undefined;
    return source?.type === "find_rows" ? source.databaseId : databaseId;
  };
  const databaseIds = new Set<string>([databaseId]);
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const a of later) {
    databaseIds.add(sourceOf(a));
    if (a.type === "find_rows" || a.type === "create_row" || a.type === "upsert_row") databaseIds.add(a.databaseId);
    if (a.type === "notify" || a.type === "approval") a.userIds.forEach((id) => userIds.add(id));
    if (a.type === "run_agent") agentIds.add(a.agentId);
  }
  const [titles, names, agents, schemas] = await Promise.all([
    db.select({ id: page.id, title: page.title }).from(page).where(inArray(page.id, [...databaseIds])),
    userIds.size ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...userIds])) : [],
    agentIds.size ? db.select({ id: workspaceAgent.id, name: workspaceAgent.name }).from(workspaceAgent).where(inArray(workspaceAgent.id, [...agentIds])) : [],
    Promise.all([...databaseIds].map(async (id) => [id, await getProperties(id)] as const)).then((all) => new Map(all)),
  ]);
  const title = (id: string) => pageLabel(titles.find((t) => t.id === id)?.title ?? "");
  const person = (id: string) => names.find((n) => n.id === id)?.name ?? "";
  const propNames = (database: string, propertyIds: string[]) =>
    propertyIds
      .flatMap((id) => schemas.get(database)?.find((p) => p.id === id)?.name ?? [])
      .join(", ");
  return later.map((a, n) => {
    const id = ids[index + 1 + n];
    const over = forEachOf(a);
    const target = sourceOf(a);
    const line = (detail?: string): ApprovalNextStep => ({
      id,
      type: a.type,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
      ...(over ? { forEach: over } : {}),
    });
    switch (a.type) {
      case "set_properties":
        return line(propNames(target, Object.keys(a.values)));
      case "notify":
      case "approval":
        return line([...a.userIds.map(person), propNames(target, a.propertyIds)].filter(Boolean).join(", "));
      case "run_agent":
        return line(agents.find((x) => x.id === a.agentId)?.name);
      case "webhook":
        return line(hostOf(a.url));
      case "http_request":
        return line(`${a.method} ${hostOf(a.url)}`);
      case "find_rows":
      case "create_row":
      case "upsert_row":
        return line(title(a.databaseId));
      case "wait":
        return line(String(a.minutes));
      case "log":
        return line(a.message);
      case "move_to_trash":
        return line();
    }
  });
}

/** The entry an approval step of a run asked with, if it asked already (a run taken again after a restart). */
async function existingChange(runId: string, stepId: string) {
  const [found] = await db
    .select({ id: pendingChange.id, expiresAt: pendingChange.expiresAt })
    .from(pendingChange)
    .where(and(eq(pendingChange.automationRunId, runId), sql`${pendingChange.payload}->>'stepId' = ${stepId}`));
  return found ?? null;
}

/**
 * Asks for the approval: the "For review" entry (once per run and step) and a notification to the
 * approvers. Returns the state the step keeps and the message as rendered. Fails
 * (ApprovalStepError) when nobody can be asked. A test run asks nobody and says whom it would.
 */
export async function askApproval(input: {
  automation: Automation;
  run: Run;
  row: Row;
  action: ApprovalAction;
  stepId: string;
  index: number;
  actions: AutomationAction[];
  scope: TemplateScope;
}): Promise<{ state: ApprovalState; message: string; missing: string[] }> {
  const { automation, run, row, action, stepId } = input;
  const rendered = resolveText(action.message, input.scope);
  const message = rendered.value.trim().slice(0, MAX_STEP_MESSAGE);
  const approvers = await resolveApprovers(automation, row, action);
  if (!approvers.length) {
    throw new ApprovalStepError(
      action.propertyIds.length
        ? "Nobody to ask: none of the people named, nor anyone the row's person properties name, is a member who can open the row"
        : "Nobody to ask: none of the people named is a member who can open the row",
    );
  }
  const expiresAt = new Date(Date.now() + action.timeoutDays * DAY_MS);
  if (run.test) return { state: { changeId: "", approvers, expiresAt: expiresAt.toISOString(), test: true }, message, missing: rendered.missing };
  const found = await existingChange(run.id, stepId);
  if (found) return { state: { changeId: found.id, approvers, expiresAt: found.expiresAt.toISOString() }, message, missing: rendered.missing };
  const payload: ApprovalPayload = {
    stepId,
    automationName: automation.name,
    version: run.version,
    message,
    approverIds: approvers.map((a) => a.id),
    nextSteps: await nextStepsOf(input.actions, input.index, automation.databaseId),
    onTimeout: action.onTimeout,
  };
  const [made] = await db
    .insert(pendingChange)
    .values({
      workspaceId: automation.workspaceId,
      kind: "automation_approval",
      databaseId: automation.databaseId,
      rowId: run.rowId,
      payload,
      reason: message.replace(/\s+/g, " ").slice(0, MAX_PENDING_REASON),
      source: { kind: "automation_run", automationRunId: run.id },
      automationId: automation.id,
      automationRunId: run.id,
      expiresAt,
    })
    .returning({ id: pendingChange.id });
  // The notification names whoever made the change that started the run, when someone did.
  await notifyReviewers(automation.workspaceId, payload.approverIds, run.actorId);
  signalQueue(automation.workspaceId, [automation.databaseId]);
  return { state: { changeId: made.id, approvers, expiresAt: expiresAt.toISOString() }, message, missing: rendered.missing };
}

export type ApprovalAnswer =
  | { answer: "waiting"; until: Date }
  | { answer: "approved" | "rejected"; by: { id: string; name: string } | null; at: string }
  | { answer: "timedOut" };

/**
 * How the step's entry was answered, as the worker reads it. Still unanswered past its expiry, it
 * is expired here, unless someone answers in that same moment: then their answer counts.
 */
export async function readAnswer(changeId: string): Promise<ApprovalAnswer> {
  const load = async () => {
    const [found] = await db
      .select({
        status: pendingChange.status,
        decidedBy: pendingChange.decidedBy,
        decidedAt: pendingChange.decidedAt,
        expiresAt: pendingChange.expiresAt,
        name: user.name,
      })
      .from(pendingChange)
      .leftJoin(user, eq(user.id, pendingChange.decidedBy))
      .where(eq(pendingChange.id, changeId));
    return found;
  };
  let found = await load();
  // Gone: nobody answered while it was kept.
  if (!found) return { answer: "timedOut" };
  if (found.status === "pending" || found.status === "failed") {
    if (found.expiresAt.getTime() > Date.now()) return { answer: "waiting", until: found.expiresAt };
    const [expired] = await db
      .update(pendingChange)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(pendingChange.id, changeId), inArray(pendingChange.status, ["pending", "failed"])))
      .returning({ workspaceId: pendingChange.workspaceId, databaseId: pendingChange.databaseId });
    if (expired) {
      signalQueue(expired.workspaceId, [expired.databaseId]);
      return { answer: "timedOut" };
    }
    found = await load();
    if (!found) return { answer: "timedOut" };
  }
  if (found.status === "approved" || found.status === "dismissed") {
    return {
      answer: found.status === "approved" ? "approved" : "rejected",
      by: found.decidedBy ? { id: found.decidedBy, name: found.name ?? "" } : null,
      at: (found.decidedAt ?? new Date()).toISOString(),
    };
  }
  return { answer: "timedOut" };
}

/** Whether the entry still waits for an answer (the worker looks again after saving a waiting run). */
export async function stillWaiting(changeId: string) {
  const [found] = await db.select({ status: pendingChange.status }).from(pendingChange).where(eq(pendingChange.id, changeId));
  return found?.status === "pending" || found?.status === "failed";
}

/**
 * Closes the entries a run asked with that nobody answered, once the run ended some other way (its
 * automation turned off, its row gone, its person's access lost): nothing is left to approve.
 */
export async function closeApprovals(changeIds: string[]) {
  const ids = changeIds.filter(Boolean);
  if (!ids.length) return;
  const closed = await db
    .update(pendingChange)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(inArray(pendingChange.id, ids), inArray(pendingChange.status, ["pending", "failed"])))
    .returning({ workspaceId: pendingChange.workspaceId, databaseId: pendingChange.databaseId });
  for (const c of closed) signalQueue(c.workspaceId, [c.databaseId]);
}
