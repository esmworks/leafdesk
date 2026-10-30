import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mailbox } from "@/db/schema";
import { AccessError, enforceWorkspacePolicy, findMembership, isGuest } from "@/server/access";
import { RowMailError } from "@/server/row-mail/settings";
import { workspaceSettings } from "@/server/workspaces";

/**
 * Who reads a mailbox in the Mail tab: its owner alone, while they are a member (not a guest) of
 * its workspace, email is on there, and the workspace's policies let this session in. No one else,
 * agents, MCP clients, the REST API and automations included.
 */
export async function requireOwnMailbox(userId: string, mailboxId: string) {
  const [box] = typeof mailboxId === "string" ? await db.select().from(mailbox).where(and(eq(mailbox.id, mailboxId), eq(mailbox.userId, userId))) : [];
  if (!box) throw new RowMailError("noMailbox");
  await requireMailIn(userId, box.workspaceId);
  return box;
}

/** That the person may use the Mail tab in the workspace (see requireOwnMailbox). */
export async function requireMailIn(userId: string, workspaceId: string) {
  const membership = typeof workspaceId === "string" ? await findMembership(userId, workspaceId) : null;
  if (!membership || isGuest(membership.role)) throw new AccessError();
  await enforceWorkspacePolicy(userId, workspaceId);
  if (!(await workspaceSettings(workspaceId)).email) throw new RowMailError("disabled");
}
