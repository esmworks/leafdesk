import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { file, page, workspace, workspaceSso } from "@/db/schema";
import { confirmsWorkspaceName, type Proof } from "@/lib/account";
import { type AccountSession, reauthenticate } from "@/server/account";
import { AccessError, requireMembership } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { deleteQueued, queueStorageDeletion } from "@/server/files";
import { mailStatus, sendMail, workspaceDeletedEmail } from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
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
 * audit log). Once that commits, every open editor of its pages is disconnected, the other people
 * in it are emailed, and its files are removed from storage in the background (queued in the
 * transaction, so none is forgotten when that fails). Its audit log goes with it, so the deletion is
 * written to the server log.
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

  const { keys, pageIds, people } = await db.transaction(async (tx) => {
    // Deleted, or no longer theirs to delete, since the checks above: refused.
    const people = await lockOwnedWorkspace(tx, userId, workspaceId);
    // Only the open ones: those are what collab has to disconnect.
    const open = openPageIds();
    const pages = open.length
      ? await tx.select({ id: page.id }).from(page).where(and(eq(page.workspaceId, workspaceId), inArray(page.id, open)))
      : [];
    const connections = await tx
      .select({ providerId: workspaceSso.providerId })
      .from(workspaceSso)
      .where(eq(workspaceSso.workspaceId, workspaceId));
    for (const { providerId } of connections) await forgetConnectionSignIns(tx, providerId);
    const files = await tx.delete(file).where(eq(file.workspaceId, workspaceId)).returning({ key: file.storageKey });
    await queueStorageDeletion(tx, files.map((f) => f.key));
    await deleteWorkspaces(tx, [workspaceId]);
    return { keys: files.map((f) => f.key), pageIds: pages.map((p) => p.id), people };
  });

  console.info(`[workspaces] ${userId} deleted the workspace ${workspaceId} (${people.length} other people, ${keys.length} files)`);
  try {
    await getCollab().disconnectWorkspace(workspaceId, pageIds);
  } catch (error) {
    console.warn("[workspaces] could not close collab connections", error);
  }
  tellPeople(people, row.name, current.user.name);
  // Not awaited: removing thousands of files mustn't hold up the answer. They were queued with the
  // deletion, so whatever fails here, or is cut short by a restart, the file cleanup deletes later.
  void deleteQueued(keys).catch((error) => console.error("[workspaces] could not remove the files", error));
}

/** The pages and databases open in collab, or none when it doesn't run in this process. */
function openPageIds() {
  try {
    return getCollab().openPageIds();
  } catch {
    return [];
  }
}

/** Emails the workspace's other people that it was deleted, and by whom, each in their language. */
function tellPeople(people: { userId: string; email: string; name: string }[], workspaceName: string, by: string) {
  if (mailStatus() === "disabled") return;
  for (const person of people) {
    void recipientLocale(person.userId, null)
      .then((locale) =>
        sendMail({ to: person.email, ...workspaceDeletedEmail(locale, { name: person.name, workspace: workspaceName, by }) }),
      )
      .catch((error) => console.error("[workspaces] could not send the deletion notice", error));
  }
}
