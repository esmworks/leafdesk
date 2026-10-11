import { eq } from "drizzle-orm";
import { db } from "@/db";
import { file, page, workspace, workspaceSso } from "@/db/schema";
import { confirmsWorkspaceName, type Proof } from "@/lib/account";
import { type AccountSession, reauthenticate } from "@/server/account";
import { AccessError, requireMembership } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { removeStored } from "@/server/files";
import { forgetConnectionSignIns } from "@/server/sso";
import { deleteWorkspaces, lockOwnedWorkspace, WorkspaceError } from "@/server/workspaces";

/**
 * Deletes a workspace for good (Settings > General). Owners only, after the workspace's name typed
 * to confirm and the same proof as deleting the account (`reauthenticate`).
 *
 * In one transaction, with the workspace locked (nobody joins and no owner changes meanwhile):
 * everyone's sign-ins through its single sign-on connection are forgotten, as when the connection
 * is removed; then the workspace goes with everything that belongs to it (by foreign keys: members,
 * pages, databases, comments, teamspaces, groups, agents and their users, connections, tokens, its
 * audit log). Its files are removed from storage once that commits, and every open editor of its
 * pages is disconnected. Its audit log goes with it, so the deletion is written to the server log.
 */
export async function deleteWorkspace(current: AccountSession, workspaceId: string, input: { confirmation: unknown; proof: Proof }) {
  const userId = current.user.id;
  await requireMembership(userId, workspaceId, "owner");
  const [row] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!row) throw new AccessError();
  // Before the proof, so a mistyped name doesn't use up a code.
  if (!confirmsWorkspaceName(input.confirmation, row.name)) {
    throw new WorkspaceError("confirmationMismatch", "Type the workspace's name to delete it.");
  }
  await reauthenticate(current, input.proof);

  const { keys, pageIds } = await db.transaction(async (tx) => {
    // Deleted, or no longer theirs to delete, since the checks above: refused.
    await lockOwnedWorkspace(tx, userId, workspaceId);
    const pages = await tx.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId));
    const connections = await tx
      .select({ providerId: workspaceSso.providerId })
      .from(workspaceSso)
      .where(eq(workspaceSso.workspaceId, workspaceId));
    for (const { providerId } of connections) await forgetConnectionSignIns(tx, providerId);
    const files = await tx.delete(file).where(eq(file.workspaceId, workspaceId)).returning({ key: file.storageKey });
    await deleteWorkspaces(tx, [workspaceId]);
    return { keys: files.map((f) => f.key), pageIds: pages.map((p) => p.id) };
  });

  console.info(`[workspaces] ${userId} deleted the workspace ${workspaceId} (${pageIds.length} pages, ${keys.length} files)`);
  await removeStored(keys);
  try {
    await getCollab().disconnectWorkspace(workspaceId, pageIds);
  } catch (error) {
    console.warn("[workspaces] could not close collab connections", error);
  }
}
