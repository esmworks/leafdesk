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
import { afterCutOff, cutOffConnection } from "@/server/sso";
import { deleteWorkspaces, lockOwnedWorkspace, WorkspaceError } from "@/server/workspaces";

/**
 * Deletes a workspace for good (Settings > General). Owners only, after the workspace's name typed
 * to confirm and the same proof as deleting the account (`reauthenticate`).
 *
 * In one transaction, with the workspace locked (nobody joins and no owner changes meanwhile): the
 * workspace goes with everything that belongs to it (by foreign keys: members, pages, databases,
 * comments, teamspaces, groups, agents and their users, connections, tokens for it alone, its audit
 * log); then everyone's sign-ins through its single sign-on connection are forgotten and their API
 * tokens and connected apps revoked, as when the connection is removed (cutOffConnection: those for
 * all their workspaces would keep reaching the others). Last, so that the people's token and app
 * rows in every workspace are locked only for the end of the transaction, not while the workspace's
 * rows are deleted: requests using those tokens wait meanwhile. It also leaves less time for one of
 * them to make a token the revocation misses, though as when the connection is removed, a token
 * made while the transaction runs isn't seen by it and survives.
 *
 * Once that commits, every open editor of its pages is disconnected, the other people in it are
 * emailed, its files are removed from storage in the background (queued in the transaction, so none
 * is forgotten when that fails), and the pages the signed-out people have open elsewhere are closed
 * (afterCutOff, which only logs its errors). Its audit log goes with it, so the deletion, with how
 * much of its single sign-on users' access it revoked (not counting their tokens for this workspace
 * alone, which went with it), is written to the server log.
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

  const { keys, pageIds, people, cutOff } = await db.transaction(async (tx) => {
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
    const files = await tx.delete(file).where(eq(file.workspaceId, workspaceId)).returning({ key: file.storageKey });
    await queueStorageDeletion(tx, files.map((f) => f.key));
    await deleteWorkspaces(tx, [workspaceId]);
    // After the workspace is gone (see above). Nothing it deleted is needed: the sign-ins point at
    // the connection's provider id without a foreign key, so they are still there to forget.
    const cutOff: Awaited<ReturnType<typeof cutOffConnection>>[] = [];
    for (const { providerId } of connections) cutOff.push(await cutOffConnection(tx, providerId));
    return { keys: files.map((f) => f.key), pageIds: pages.map((p) => p.id), people, cutOff };
  });

  const tokens = cutOff.reduce((n, c) => n + c.counts.revokedApiTokens, 0);
  const apps = cutOff.reduce((n, c) => n + c.counts.revokedConnectedApps, 0);
  console.info(
    `[workspaces] ${userId} deleted the workspace ${workspaceId} (${people.length} other people, ${keys.length} files; ` +
      `${tokens} API tokens and ${apps} connected apps of its single sign-on users revoked)`,
  );
  try {
    await getCollab().disconnectWorkspace(workspaceId, pageIds);
  } catch (error) {
    console.warn("[workspaces] could not close collab connections", error);
  }
  tellPeople(people, row.name, current.user.name);
  // Not awaited: removing thousands of files mustn't hold up the answer. They were queued with the
  // deletion, so whatever fails here, or is cut short by a restart, the file cleanup deletes later.
  void deleteQueued(keys).catch((error) => console.error("[workspaces] could not remove the files", error));
  // Last: it goes person by person, and the emails mustn't wait for it.
  await afterCutOff(cutOff);
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
