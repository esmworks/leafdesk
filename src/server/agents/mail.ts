import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentMailbox, mailbox } from "@/db/schema";
import { requireOwnMailbox } from "@/server/mail-client/access";
import { mailTabShown } from "@/server/mail-client/read";
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

/** One of the person's mailboxes, and whether the agent may read it and draft in it. */
export type AgentMailboxView = { id: string; address: string; open: boolean };

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
  const open = new Set(
    (
      await db
        .select({ id: agentMailbox.mailboxId })
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
    ).map((r) => r.id),
  );
  return boxes.map((b) => ({ ...b, open: open.has(b.id) }));
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
