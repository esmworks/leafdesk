/**
 * Asking for a higher monthly token limit (`agent_limit_request`): someone with full access to an
 * agent who isn't an owner (only owners set the limit, see manage.ts) asks for a number and says
 * why; the workspace's owners get it in their inbox and by email, and the first to answer raises
 * the limit to it (through updateAgent, so it is in the agent's history and the audit log) or
 * declines. Whoever asked hears the answer. One request waits at a time per agent and person:
 * asking again changes it.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentLimitRequest, notification, user, workspace, workspaceAgent } from "@/db/schema";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { MAX_LIMIT_REQUEST_NOTE, type AgentLimitRequestView } from "@/lib/agent-guardrails";
import { MAX_AGENT_TOKEN_LIMIT } from "@/lib/agents";
import { agentPath } from "@/lib/agent-chat";
import { env } from "@/lib/env";
import { redactError } from "@/lib/redact";
import { requireMembership, workspaceOwnerIds } from "@/server/access";
import { tellRequester } from "@/server/ai-limit-notices";
import { mailStatus, sendMail } from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
import { agentLimitRequestEmail } from "@/server/mail/templates";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import { AgentError } from "./errors";
import { updateAgent } from "./manage";
import { agentWithLevel } from "./sharing";


/** The request the person has waiting on the agent, if any (for its Runs tab). */
export async function pendingLimitRequest(userId: string, agentId: string): Promise<AgentLimitRequestView | null> {
  const { agent } = await agentWithLevel(userId, agentId, "full");
  const [found] = await db
    .select()
    .from(agentLimitRequest)
    .where(and(eq(agentLimitRequest.agentId, agent.id), eq(agentLimitRequest.requestedBy, userId), eq(agentLimitRequest.status, "pending")));
  return found ? { id: found.id, tokens: found.tokens, note: found.note, createdAt: found.createdAt.toISOString() } : null;
}

/**
 * Asks the workspace's owners to raise the agent's monthly token limit to `tokens`, for those
 * with full access who aren't owners, while the agent has a limit (above which `tokens` must be).
 */
export async function requestHigherLimit(userId: string, agentId: string, tokens: unknown, note: unknown): Promise<AgentLimitRequestView> {
  const { agent, owner } = await agentWithLevel(userId, agentId, "full");
  if (owner) throw new AgentError("notAllowed", "Owners change the limit themselves");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change it");
  if (agent.monthlyTokenLimit === null) throw new AgentError("invalid", "The agent has no limit to raise", { reason: "noLimit" });
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= agent.monthlyTokenLimit || tokens > MAX_AGENT_TOKEN_LIMIT) {
    throw new AgentError("invalid", "Ask for a whole number of tokens above the agent's limit, up to a billion", { reason: "requestTokens" });
  }
  const reason = typeof note === "string" ? note.trim() : "";
  if (reason.length > MAX_LIMIT_REQUEST_NOTE) throw new AgentError("invalid", `Say why in at most ${MAX_LIMIT_REQUEST_NOTE} characters`, { reason: "requestNote" });
  const owners = await workspaceOwnerIds(agent.workspaceId);
  const { request, fresh } = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(agentLimitRequest)
      .set({ tokens, note: reason })
      .where(and(eq(agentLimitRequest.agentId, agent.id), eq(agentLimitRequest.requestedBy, userId), eq(agentLimitRequest.status, "pending")))
      .returning();
    if (changed) {
      // The owners see it again, unread, with the new number; it isn't pushed or emailed twice.
      await tx.update(notification).set({ readAt: null }).where(eq(notification.agentLimitRequestId, changed.id));
      return { request: changed, fresh: [] as string[] };
    }
    const [created] = await tx.insert(agentLimitRequest).values({ agentId: agent.id, workspaceId: agent.workspaceId, requestedBy: userId, tokens, note: reason }).returning();
    const told = owners.length
      ? await tx
          .insert(notification)
          .values(owners.map((ownerId) => ({ userId: ownerId, workspaceId: agent.workspaceId, kind: "agent_limit_request" as const, actorId: userId, agentLimitRequestId: created.id })))
          .returning({ id: notification.id })
      : [];
    return { request: created, fresh: told.map((n) => n.id) };
  });
  try {
    signalInbox(agent.workspaceId);
  } catch {
    // No collaboration server (scripts).
  }
  if (fresh.length) {
    pushNotifications(fresh);
    void emailOwners(agent, userId, request.tokens, request.note, owners);
  }
  return { id: request.id, tokens: request.tokens, note: request.note, createdAt: request.createdAt.toISOString() };
}

async function emailOwners(agent: typeof workspaceAgent.$inferSelect, requesterId: string, tokens: number, note: string, owners: string[]) {
  if (mailStatus() === "disabled") return;
  const [asker] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, requesterId));
  const [ws] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, agent.workspaceId));
  for (const ownerId of owners) {
    try {
      const [person] = await db.select({ email: user.email }).from(user).where(eq(user.id, ownerId));
      if (!person?.email) continue;
      const locale = await recipientLocale(ownerId, DEFAULT_LOCALE);
      const email = agentLimitRequestEmail(locale, {
        askerName: asker?.name || asker?.email || "",
        agentName: agent.name,
        workspaceName: ws?.name ?? "",
        current: agent.monthlyTokenLimit ?? 0,
        tokens,
        note,
        link: `${env.appUrl}${agentPath(agent.workspaceId, agent.id)}`,
      });
      await sendMail({ to: person.email, ...email });
    } catch (error) {
      console.error("[agent limits] could not email a request", redactError(error));
    }
  }
}

/**
 * An owner answers a request: `approve` raises the agent's monthly token limit to the number asked
 * for, else it is declined. Either way the owners' inbox items go and whoever asked is told.
 */
export async function decideLimitRequest(userId: string, workspaceId: string, requestId: string, approve: boolean): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const [request] = await db
    .update(agentLimitRequest)
    .set({ status: approve ? "approved" : "declined", decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(agentLimitRequest.id, requestId), eq(agentLimitRequest.workspaceId, workspaceId), eq(agentLimitRequest.status, "pending")))
    .returning();
  if (!request) throw new AgentError("requestNotFound", "This request was answered already");
  try {
    if (approve) await updateAgent(userId, request.agentId, { monthlyTokenLimit: request.tokens });
  } catch (error) {
    // The limit didn't change (the agent was archived meanwhile, say): the request waits again.
    await db.update(agentLimitRequest).set({ status: "pending", decidedBy: null, decidedAt: null }).where(eq(agentLimitRequest.id, request.id));
    throw error;
  }
  await db.delete(notification).where(eq(notification.agentLimitRequestId, request.id));
  try {
    signalInbox(workspaceId);
  } catch {
    // No collaboration server (scripts).
  }
  const [agent] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, request.agentId));
  if (agent) await tellRequester(agent, request.requestedBy, approve ? "raised" : "declined");
}
