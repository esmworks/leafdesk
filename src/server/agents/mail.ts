import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentMailbox, mailbox } from "@/db/schema";
import { NO_MAIL_FILTERS, parseMailTrigger, type MailTriggerFilters } from "@/lib/agent-mail-trigger";
import { requireOwnMailbox } from "@/server/mail-client/access";
import { isIndexed } from "@/server/mail-client/indexer";
import { mailTabShown, openMailbox } from "@/server/mail-client/read";
import { RowMailError } from "@/server/row-mail/settings";
import { AgentError } from "./errors";
import { agentWithLevel } from "./sharing";

/**
 * Mailboxes members open to agents (agent_mailbox). An agent reads no one's mail on its own: the
 * owner of a mailbox opens it to an agent they may use, and only the agent's runs that work for
 * them and show what they did to them alone (their chat with it in the app, a schedule they set
 * that looks after no database: lib/agents.ts ownerSeesRun) get the mail tools of
 * server/ai-chat-mail.ts, held to those mailboxes. Other owners of the agent never see that mail.
 */

/**
 * One of the person's mailboxes, whether the agent may read it and draft in it, and whether its new
 * email starts the agent's runs (agents/mail-trigger.ts): with what task, which email, and when the
 * limit last held some back.
 */
export type AgentMailboxView = {
  id: string;
  address: string;
  open: boolean;
  trigger: { on: boolean; task: string; filters: MailTriggerFilters; limitedAt: string | null };
};

/** The person's mailboxes in the agent's workspace, for its settings; none where the Mail tab isn't theirs. */
export async function agentMailboxesOf(userId: string, agentId: string): Promise<AgentMailboxView[]> {
  const { agent } = await agentWithLevel(userId, agentId, "interact");
  if (!(await mailTabShown(userId, agent.workspaceId))) return [];
  const boxes = await db
    .select({ id: mailbox.id, address: mailbox.address })
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, agent.workspaceId), eq(mailbox.userId, userId)))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt));
  if (!boxes.length) return [];
  const open = new Map(
    (
      await db
        .select({ id: agentMailbox.mailboxId, on: agentMailbox.onNewMail, task: agentMailbox.task, filters: agentMailbox.filters, limitedAt: agentMailbox.limitedAt })
        .from(agentMailbox)
        .where(
          and(
            eq(agentMailbox.agentId, agent.id),
            inArray(
              agentMailbox.mailboxId,
              boxes.map((b) => b.id),
            ),
          ),
        )
    ).map((r) => [r.id, r]),
  );
  return boxes.map((b) => {
    const kept = open.get(b.id);
    return {
      ...b,
      open: Boolean(kept),
      trigger: kept
        ? { on: kept.on, task: kept.task, filters: { ...NO_MAIL_FILTERS, ...kept.filters }, limitedAt: kept.limitedAt?.toISOString() ?? null }
        : { on: false, task: "", filters: NO_MAIL_FILTERS, limitedAt: null },
    };
  });
}

/** Opens one of the person's own mailboxes to the agent, or closes it again. */
export async function setAgentMailbox(userId: string, agentId: string, mailboxId: string, open: boolean) {
  const { agent } = await agentWithLevel(userId, agentId, "interact");
  // Closing one stays possible: it holds the agent off the mail once it is restored.
  if (open && agent.archivedAt) throw new AgentError("archived", "Restore the agent to open your email to it");
  const box = await requireOwnMailbox(userId, mailboxId);
  if (box.workspaceId !== agent.workspaceId) throw new RowMailError("noMailbox");
  if (open) await db.insert(agentMailbox).values({ agentId: agent.id, mailboxId: box.id }).onConflictDoNothing();
  else await db.delete(agentMailbox).where(and(eq(agentMailbox.agentId, agent.id), eq(agentMailbox.mailboxId, box.id)));
}

/**
 * Sets whether new email in a mailbox the person opened to the agent starts its runs, with what
 * task and filters (lib/agent-mail-trigger.ts). Turning it on reads a mailbox the Mail tab never
 * opened for the first time, so its new mail is noticed from then on.
 */
export async function setAgentMailTrigger(userId: string, agentId: string, mailboxId: string, input: unknown) {
  const { agent } = await agentWithLevel(userId, agentId, "interact");
  const trigger = parseMailTrigger(input);
  if (!trigger) throw new AgentError("invalid", "Check the task and the filters");
  // A paused agent keeps it, starting nothing until it is on again (mail-trigger.ts).
  if (trigger.on && agent.archivedAt) throw new AgentError("archived", "Restore the agent to have your email start it");
  const box = await requireOwnMailbox(userId, mailboxId);
  if (box.workspaceId !== agent.workspaceId) throw new RowMailError("noMailbox");
  const [kept] = await db
    .update(agentMailbox)
    .set({ onNewMail: trigger.on, task: trigger.task, filters: trigger.filters, ...(trigger.on ? { limitedAt: null } : {}) })
    .where(and(eq(agentMailbox.agentId, agent.id), eq(agentMailbox.mailboxId, box.id)))
    .returning({ id: agentMailbox.mailboxId });
  if (!kept) throw new AgentError("invalid", "Open the mailbox to the agent first");
  if (trigger.on && !(await isIndexed(box.id))) void openMailbox(userId, box.id).catch(() => {});
}

/**
 * The mailboxes of `member` an agent's run may read, asked when the run is taken (after an approval
 * too): opened to it, still theirs, and the Mail tab still shown to them. Empty for no one.
 */
export async function runMailboxes(agent: { id: string; workspaceId: string }, member: string | null): Promise<string[]> {
  if (!member || !(await mailTabShown(member, agent.workspaceId))) return [];
  const rows = await db
    .select({ id: mailbox.id })
    .from(agentMailbox)
    .innerJoin(mailbox, eq(mailbox.id, agentMailbox.mailboxId))
    .where(and(eq(agentMailbox.agentId, agent.id), eq(mailbox.userId, member), eq(mailbox.workspaceId, agent.workspaceId)))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt));
  return rows.map((r) => r.id);
}
