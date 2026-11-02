import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentMailbox, agentRun, mailbox, mailMessage, workspaceAgent } from "@/db/schema";
import { mailTriggerTakes } from "@/lib/agent-mail-trigger";
import { MAX_MAIL_RUNS_PER_DAY, MAX_MAIL_RUNS_PER_HOUR } from "@/lib/agents";
import { rowOfMessage } from "@/server/mail-client/read";
import { senderRules } from "@/server/mail-client/senders";
import { startTriggered } from "@/server/triggers";
import { runMailboxes } from "./mail";

/**
 * New email starting agents' runs: the Mail tab's index (mail-client/indexer.ts) calls mailArrived
 * with the messages it just added to a mailbox's inbox, read by the minute's sweep or by a tab
 * watching it. Each agent its owner opened the mailbox to with `onNewMail` (agent_mailbox) gets a
 * run for each thread the new messages its filters take are in, with the owner's task: one run
 * per thread waiting at once, and at most MAX_MAIL_RUNS_PER_HOUR and _PER_DAY. The run reads the
 * email as anyone's words from the start (agents/run.ts).
 */

/** Mail sent longer ago than this starts no run: one moved back into the inbox, or long held up on the way. */
const FRESH_MS = 2 * 86_400_000;

type Box = Pick<typeof mailbox.$inferSelect, "id" | "workspaceId" | "userId" | "address">;

export async function mailArrived(box: Box, messageIds: string[]): Promise<number> {
  if (!messageIds.length) return 0;
  const triggers = await db
    .select({ agentId: agentMailbox.agentId, task: agentMailbox.task, filters: agentMailbox.filters, agent: workspaceAgent })
    .from(agentMailbox)
    .innerJoin(workspaceAgent, eq(workspaceAgent.id, agentMailbox.agentId))
    .where(and(eq(agentMailbox.mailboxId, box.id), eq(agentMailbox.onNewMail, true), eq(workspaceAgent.enabled, true), isNull(workspaceAgent.archivedAt)));
  if (!triggers.length) return 0;
  const fresh = new Date(Date.now() - FRESH_MS);
  const found = await db
    .select({ id: mailMessage.id, threadId: mailMessage.threadId, fromAddress: mailMessage.fromAddress, subject: mailMessage.subject, draft: mailMessage.draft, automated: mailMessage.automated, sentAt: mailMessage.sentAt })
    .from(mailMessage)
    .where(and(eq(mailMessage.mailboxId, box.id), inArray(mailMessage.id, messageIds), gt(mailMessage.sentAt, fresh)));
  // Mail from an address the owner blocked goes to the junk instead (mail-client/senders.ts).
  const rules = await senderRules(
    box.userId,
    found.map((m) => m.fromAddress),
  );
  const messages = found.filter((m) => rules.get(m.fromAddress.toLowerCase()) !== "block");
  if (!messages.length) return 0;
  // Mail the owner sent from any of their mailboxes here (a copy to themselves, a reply that came back).
  const own = (await db.select({ address: mailbox.address }).from(mailbox).where(and(eq(mailbox.workspaceId, box.workspaceId), eq(mailbox.userId, box.userId)))).map((b) => b.address);
  let queued = 0;
  for (const trigger of triggers) {
    // Still the owner's to give: the mailbox opened to the agent, and the Mail tab theirs (mail.ts).
    if (!(await runMailboxes(trigger.agent, box.userId)).includes(box.id)) continue;
    const taken = messages.filter((m) => mailTriggerTakes(m, own, trigger.filters));
    const known = trigger.filters.knownOnly ? await Promise.all(taken.map((m) => rowOfMessage(box.userId, m.id).catch(() => null))) : null;
    // The newest message of each thread: the run reads the whole thread.
    const newest = new Map<string, (typeof messages)[number]>();
    taken.forEach((m, i) => {
      if (known && !known[i]) return;
      const before = newest.get(m.threadId);
      if (!before || before.sentAt < m.sentAt) newest.set(m.threadId, m);
    });
    for (const message of newest.values()) {
      if (await waitingFor(trigger.agentId, box.id, message.threadId)) continue;
      if (await atLimit(trigger.agentId, box.id)) {
        await db
          .update(agentMailbox)
          .set({ limitedAt: new Date() })
          .where(and(eq(agentMailbox.agentId, trigger.agentId), eq(agentMailbox.mailboxId, box.id)));
        break;
      }
      await startTriggered({
        target: { agentId: trigger.agentId },
        workspaceId: box.workspaceId,
        source: { kind: "mail", mailboxId: box.id, userId: box.userId, threadId: message.threadId, messageId: message.id },
        context: { actorId: box.userId },
        prompt: trigger.task,
      });
      queued += 1;
    }
  }
  return queued;
}

/** Whether a run for the thread waits to start: it will read the thread as it is then, the newest message too. */
async function waitingFor(agentId: string, mailboxId: string, threadId: string) {
  const [one] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.agentId, agentId),
        eq(agentRun.status, "pending"),
        sql`${agentRun.source}->>'kind' = 'mail' and ${agentRun.source}->>'mailboxId' = ${mailboxId} and ${agentRun.source}->>'threadId' = ${threadId}`,
      ),
    )
    .limit(1);
  return Boolean(one);
}

/** Whether the agent's runs from this mailbox's email reached the hour's or the day's limit. */
async function atLimit(agentId: string, mailboxId: string) {
  const [counts] = await db
    .select({
      hour: count(sql`case when ${agentRun.createdAt} > now() - interval '1 hour' then 1 end`),
      day: count(),
    })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.agentId, agentId),
        sql`${agentRun.createdAt} > now() - interval '1 day'`,
        sql`${agentRun.source}->>'kind' = 'mail' and ${agentRun.source}->>'mailboxId' = ${mailboxId}`,
      ),
    );
  return (counts?.hour ?? 0) >= MAX_MAIL_RUNS_PER_HOUR || (counts?.day ?? 0) >= MAX_MAIL_RUNS_PER_DAY;
}
