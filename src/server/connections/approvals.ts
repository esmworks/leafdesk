import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, connection, notification, workspaceAgent } from "@/db/schema";
import type { AgentPendingCall, ApprovalDecision } from "@/lib/agents";
import { MAX_REDO_NOTE } from "@/lib/connections";
import { workspaceOwnerIds } from "@/server/access";
import { kickAgents } from "@/server/agents/kick";
import { recordAudit } from "@/server/audit";
import { signalInbox } from "@/server/notifications";
import { inputSummary } from "./tools";

/**
 * Approvals: a call to a connection's tool that may change something waits until an owner of
 * the workspace approves it, declines it or sends it back with a note ("Redo"). They find it in
 * their inbox and in the agent's runs. The first answer counts; a day without one fails the run,
 * and nothing is sent.
 */

export class ApprovalError extends Error {
  constructor(
    readonly code: "notFound" | "decided" | "forbidden" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** Tells the workspace's open sidebars to fetch their inbox again; the items are saved whether or not it reaches them. */
function refreshInboxes(workspaceId: string) {
  try {
    signalInbox(workspaceId);
  } catch (error) {
    console.error("[connections] could not refresh inboxes", error);
  }
}

/** Tells the workspace's owners a call waits for them (an inbox item each, about the run). */
export async function notifyApprovers(run: { id: string; workspaceId: string }, agentUserId: string) {
  const owners = await workspaceOwnerIds(run.workspaceId);
  if (!owners.length) return;
  await db.insert(notification).values(
    owners.map((userId) => ({ userId, workspaceId: run.workspaceId, kind: "agent_approval" as const, actorId: agentUserId, agentRunId: run.id })),
  );
  refreshInboxes(run.workspaceId);
}

/** Takes a run's approval items out of the inbox (it was answered, or ran out of time). */
export async function withdrawApproval(runId: string) {
  const gone = await db.delete(notification).where(eq(notification.agentRunId, runId)).returning({ workspaceId: notification.workspaceId });
  for (const workspaceId of new Set(gone.map((g) => g.workspaceId))) refreshInboxes(workspaceId);
}

/**
 * An owner's answer to the call a run waits on. `callId` names the call they saw, so an answer
 * meant for an earlier call (the agent asked again since) is refused rather than taken.
 */
export async function decideApproval(userId: string, input: { runId: string; callId: string; decision: ApprovalDecision; note?: string }) {
  const note = input.note?.trim().slice(0, MAX_REDO_NOTE) ?? "";
  if (input.decision === "redo" && !note) throw new ApprovalError("invalid", "Say what should change");
  const [run] = await db
    .select({ id: agentRun.id, workspaceId: agentRun.workspaceId, status: agentRun.status, pending: agentRun.pending, agentId: agentRun.agentId })
    .from(agentRun)
    .where(eq(agentRun.id, input.runId));
  if (!run) throw new ApprovalError("notFound", "No such run");
  if (!(await workspaceOwnerIds(run.workspaceId)).includes(userId)) throw new ApprovalError("forbidden", "Only owners of the workspace answer an agent's calls");
  const decision = { decision: input.decision, userId, ...(input.decision === "redo" ? { note } : {}) };
  // Only the first answer to this very call counts, and only within its time (the sweep that fails
  // a call run out of time may not have come yet).
  const now = new Date();
  const [taken] = await db
    .update(agentRun)
    .set({ status: "pending", nextAt: now, state: sql`jsonb_set(${agentRun.state}, '{decision}', ${JSON.stringify(decision)}::jsonb)` })
    .where(and(eq(agentRun.id, run.id), eq(agentRun.status, "awaiting_approval"), gt(agentRun.nextAt, now), sql`${agentRun.pending}->>'callId' = ${input.callId}`))
    .returning({ id: agentRun.id, pending: agentRun.pending });
  if (!taken) throw new ApprovalError("decided", "This call was already answered");
  await withdrawApproval(run.id);
  kickAgents();
  const pending = taken.pending as AgentPendingCall;
  const [conn] = await db.select({ name: connection.name }).from(connection).where(eq(connection.id, pending.connectionId));
  const [agent] = await db.select({ name: workspaceAgent.name }).from(workspaceAgent).where(eq(workspaceAgent.id, run.agentId));
  await recordAudit({
    workspaceId: run.workspaceId,
    actorId: userId,
    action: "connection.approval_decided",
    target: { type: "connection", id: pending.connectionId, label: conn?.name ?? null },
    details: { tool: pending.tool, decision: input.decision, agent: agent?.name ?? null, input: inputSummary(pending.arguments), ...(note ? { note: note.slice(0, 200) } : {}) },
  });
  return { runId: run.id };
}
