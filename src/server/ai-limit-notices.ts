/**
 * Word of AI spending to those who answer for it (lib/agent-guardrails.ts has the rules): the
 * workspace's owners hear when a month's spending nears its limit (LIMIT_NEAR_SHARE) and when it
 * reaches it, for the workspace's cost limit and for each agent's token limit (whoever created the
 * agent hears too, while they are in the workspace); and an agent new enough to be set up wrong
 * that spends fast is paused, once a month, and they hear of that. Each is an "ai_limit" inbox
 * item, pushed and emailed at once; the unique index on the month keeps it to one per person.
 *
 * Callers count first and ask here after, never waiting on it: nothing here may stop a run or a
 * request, so every failure is logged and swallowed.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { notification, user, workspace, workspaceAgent } from "@/db/schema";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { aiLimitPath, limitStage, spendingFast, type AiLimitNotice } from "@/lib/agent-guardrails";
import { env } from "@/lib/env";
import { redactError } from "@/lib/redact";
import { findMembership, workspaceOwnerIds } from "@/server/access";
import { saveVersion } from "@/server/agents/version-record";
import { monthOf } from "@/server/ai/usage";
import { recordAudit } from "@/server/audit";
import { mailStatus, sendMail } from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
import { aiLimitEmail } from "@/server/mail/templates";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";

type Agent = typeof workspaceAgent.$inferSelect;

/** "2026-10", the month a notice is about (notification.date). */
const monthKey = (now: Date) => monthOf(now).slice(0, 7);

/** The workspace's owners, and the agent's creator while they are a member of it. */
async function recipientsOf(workspaceId: string, agent: Agent | null): Promise<string[]> {
  const owners = await workspaceOwnerIds(workspaceId);
  if (!agent?.createdBy || owners.includes(agent.createdBy)) return owners;
  const membership = await findMembership(agent.createdBy, workspaceId);
  return membership && membership.role !== "guest" ? [...owners, agent.createdBy] : owners;
}

/**
 * Records the notice for each person who hasn't had it this month (agent or workspace), then
 * pushes and emails those it is new to. Returns how many were told.
 */
async function tell(workspaceId: string, agent: Agent | null, notice: AiLimitNotice, now: Date, recipients?: string[]): Promise<number> {
  const people = recipients ?? (await recipientsOf(workspaceId, agent));
  if (!people.length) return 0;
  const inserted = await db
    .insert(notification)
    .values(people.map((userId) => ({ userId, workspaceId, kind: "ai_limit" as const, actorId: agent?.userId ?? null, date: monthKey(now), message: notice })))
    .onConflictDoNothing()
    .returning({ id: notification.id, userId: notification.userId });
  if (!inserted.length) return 0;
  try {
    signalInbox(workspaceId);
  } catch {
    // No collaboration server (scripts): the inbox catches up when it is next opened.
  }
  pushNotifications(inserted.map((n) => n.id));
  // Not waited for: a run's turn or a request goes on meanwhile.
  void emailNotice(workspaceId, agent, notice, inserted.map((n) => n.userId));
  return inserted.length;
}

/** Emails each of `userIds` about the notice, in their own language. */
async function emailNotice(workspaceId: string, agent: Agent | null, notice: AiLimitNotice, userIds: string[]) {
  if (mailStatus() === "disabled") return;
  const [ws] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const link = `${env.appUrl}${aiLimitPath(workspaceId, agent?.id ?? null)}`;
  for (const userId of userIds) {
    try {
      const [person] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      if (!person?.email) continue;
      const locale = await recipientLocale(userId, DEFAULT_LOCALE);
      const email = aiLimitEmail(locale, {
        notice,
        agentName: agent?.name ?? null,
        workspaceName: ws?.name ?? "",
        limit: agent?.monthlyTokenLimit ?? null,
        link,
      });
      await sendMail({ to: person.email, ...email });
    } catch (error) {
      console.error("[ai limits] could not email a notice", redactError(error));
    }
  }
}

/** What this process told or did already, by agent or workspace, month and notice: spending is looked at on every turn. */
const done = new Set<string>();

/**
 * After a turn of one of the agent's runs was counted: `monthTokens` is all it used this month.
 * Tells of its limit nearing or reached, and pauses it when it is new and spending fast ("paused":
 * the run should stop). `agent` is as the run read it; the pause looks again.
 */
export async function noticeAgentSpending(agent: Agent, monthTokens: number, now = new Date()): Promise<"paused" | null> {
  try {
    const stage = limitStage(monthTokens, agent.monthlyTokenLimit);
    const stageKey = stage && `${agent.id}:${monthKey(now)}:${stage}`;
    if (stageKey && !done.has(stageKey)) {
      done.add(stageKey);
      await tell(agent.workspaceId, agent, stage!, now);
    }
    const pauseKey = `${agent.id}:${monthKey(now)}:paused`;
    if (done.has(pauseKey) || !spendingFast(agent, monthTokens, now)) return null;
    done.add(pauseKey);
    return (await pauseSpendingAgent(agent, now)) ? "paused" : null;
  } catch (error) {
    console.error("[ai limits] could not look at an agent's spending", redactError(error));
    return null;
  }
}

/**
 * Pauses a new agent that spends fast, unless it was paused for it this month already: an owner
 * who turned it back on after that has looked, and it runs on. The pause is the agent's own change
 * (no person did it), in its history and the audit log.
 */
async function pauseSpendingAgent(agent: Agent, now: Date): Promise<boolean> {
  const [before] = await db
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.kind, "ai_limit"),
        eq(notification.workspaceId, agent.workspaceId),
        eq(notification.actorId, agent.userId),
        eq(notification.message, "paused"),
        eq(notification.date, monthKey(now)),
      ),
    )
    .limit(1);
  if (before) return false;
  const [paused] = await db
    .update(workspaceAgent)
    .set({ enabled: false })
    .where(and(eq(workspaceAgent.id, agent.id), eq(workspaceAgent.enabled, true)))
    .returning();
  if (!paused) return false;
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: null,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { name: agent.name, enabled: false, previous: { enabled: true }, reason: "spendingFast" },
  });
  await saveVersion(null, agent.id).catch((error) => console.error("[ai limits] could not keep the paused agent's version", redactError(error)));
  await tell(agent.workspaceId, paused, "paused", now);
  return true;
}

/**
 * Before an AI request of the workspace: what it spent this month against its owners' cost limit.
 * Tells the owners once when it nears the limit and once when it reaches it.
 */
export function noticeWorkspaceSpending(workspaceId: string, spentUsd: number, limitUsd: number | null, now = new Date()): void {
  const stage = limitStage(spentUsd, limitUsd);
  if (!stage) return;
  const key = `${workspaceId}:${monthKey(now)}:${stage}`;
  if (done.has(key)) return;
  done.add(key);
  void tell(workspaceId, null, stage, now).catch((error) => {
    done.delete(key);
    console.error("[ai limits] could not tell of the workspace's spending", redactError(error));
  });
}

/** For tests: forgets what this process told or did. */
export function forgetAiLimitNotices() {
  done.clear();
}

/** Tells whoever asked for a higher limit what an owner decided ("raised" or "declined"). */
export async function tellRequester(agent: Agent, requesterId: string, notice: "raised" | "declined", now = new Date()) {
  // Not once a month: each answer is its own (no date, so the unique index leaves it alone).
  const [row] = await db
    .insert(notification)
    .values({ userId: requesterId, workspaceId: agent.workspaceId, kind: "ai_limit", actorId: agent.userId, message: notice, createdAt: now })
    .returning({ id: notification.id });
  try {
    signalInbox(agent.workspaceId);
  } catch {
    // As in tell.
  }
  pushNotifications([row.id]);
  await emailNotice(agent.workspaceId, agent, notice, [requesterId]);
}
