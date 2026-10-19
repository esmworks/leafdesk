import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, storageAccount, user, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import { availableStorageKinds, OAUTH_STORAGE_KINDS, type StorageCredentials, type StorageSettingsView, type StorageView } from "@/lib/workspace-storage";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { openJson } from "@/server/secret-box";
import { auditLabel, listStorageAccounts, oauthReady, refuseDuringMove } from "./accounts";
import { countTry, refusal, StorageSettingsError } from "./errors";
import { uploadLimits } from "./index";
import { latestMove, moveDestinations } from "./moves";
import { currentTarget, loadTargets, markBroken, persistOn, probeStorage, removeRetiredStorage, targetDriver, targetLocation, type StorageTarget } from "./workspace";

export { StorageSettingsError, type StorageSettingsErrorCode } from "./errors";

/**
 * Settings > Storage, for owners: where the workspace's uploads go (the server's storage, or a
 * place in a storage account one of its owners connected), using one of one's own storage accounts
 * for it (accounts.ts, attachAccount), trying it again, stopping using it, and moving the files
 * (moves.ts). Files already stored stay where they are unless moved: using another storage moves
 * nothing, and storage no longer used keeps serving the files it holds until they are deleted.
 */

/** A place as the settings show it: never its credentials. */
function viewOf(target: StorageTarget, usage: Map<string | null, { files: number; bytes: number }>, viewerId: string, owners: Map<string, string>): StorageView {
  const used = usage.get(target.id) ?? { files: 0, bytes: 0 };
  const { account } = target;
  return {
    ...targetLocation(target),
    id: target.id,
    accountId: account.id,
    accountLabel: account.label,
    ownerName: account.userId ? (owners.get(account.userId) ?? null) : null,
    mine: account.userId === viewerId,
    // A disconnected account is broken for the workspaces still using it: nothing new goes there.
    status: account.status,
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt?.toISOString() ?? null,
    verifiedAt: account.verifiedAt.toISOString(),
    files: used.files,
    bytes: used.bytes,
  };
}

export async function getStorageSettings(userId: string, workspaceId: string, { isAdmin = false }: { isAdmin?: boolean } = {}): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const [targets, counts] = await Promise.all([
    loadTargets(eq(workspaceStorage.workspaceId, workspaceId)),
    db
      .select({ storageId: file.storageId, files: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${file.size}), 0)` })
      .from(file)
      .where(eq(file.workspaceId, workspaceId))
      .groupBy(file.storageId),
  ]);
  const usage = new Map(counts.map((c) => [c.storageId, { files: c.files, bytes: Number(c.bytes) }]));
  const ownerIds = [...new Set(targets.map((t) => t.account.userId).filter((id): id is string => Boolean(id)))];
  const owners = new Map(
    ownerIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ownerIds))).map((u) => [u.id, u.name]) : [],
  );
  const current = targets.find((t) => t.status !== "disconnected");
  const quota = uploadLimits().workspaceQuotaBytes;
  const ready = oauthReady();
  const [accounts, move, destinations] = await Promise.all([
    env.ownStorageEnabled ? listStorageAccounts(userId) : [],
    latestMove(workspaceId),
    moveDestinations(userId, workspaceId),
  ]);
  return {
    ownStorage: env.ownStorageEnabled,
    current: current ? viewOf(current, usage, userId, owners) : null,
    retired: targets
      .filter((t) => t.status === "disconnected" && (usage.get(t.id)?.files ?? 0) > 0)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => viewOf(t, usage, userId, owners)),
    instanceUsed: usage.get(null)?.bytes ?? 0,
    instanceQuota: quota === Infinity ? null : quota,
    accounts: accounts.filter((a) => a.status !== "disconnected"),
    kinds: availableStorageKinds(env.ownStorageEnabled, ready),
    unconfigured: env.ownStorageEnabled && isAdmin ? OAUTH_STORAGE_KINDS.filter((kind) => !ready.includes(kind)) : [],
    move,
    destinations,
  };
}

/** Tries the storage the workspace uploads to again: its account is active again when it works. */
export async function retestStorage(userId: string, workspaceId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const current = await currentTarget(workspaceId);
  if (!current) throw new StorageSettingsError("noStorage");
  try {
    let driver: ReturnType<typeof targetDriver>;
    try {
      driver = targetDriver(targetLocation(current), openJson<StorageCredentials>(current.account.credentials), persistOn(current.account.id, current.account.credentials));
    } catch (error) {
      refusal(error);
    }
    countTry(workspaceId);
    await probeStorage(driver, workspaceId).catch(refusal);
  } catch (error) {
    if (error instanceof StorageSettingsError && error.code === "refused") await markBroken(current.account.id, new Error(error.detail));
    throw error;
  }
  await db
    .update(storageAccount)
    .set({ status: "active", lastError: null, lastErrorAt: null, verifiedAt: new Date() })
    .where(and(eq(storageAccount.id, current.account.id), ne(storageAccount.status, "disconnected")));
}

/**
 * Stops the workspace uploading to its storage account: new uploads go to the server's storage
 * again. The files there are still read from it (with its owner's credentials) until they are
 * deleted or moved; with none, its place there is forgotten right away. Any owner may do it.
 */
export async function disconnectStorage(userId: string, workspaceId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  await refuseDuringMove(workspaceId);
  const [gone] = await db
    .update(workspaceStorage)
    .set({ status: "disconnected" })
    .where(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")))
    .returning({ id: workspaceStorage.id });
  if (!gone) throw new StorageSettingsError("noStorage");
  const [target] = await loadTargets(eq(workspaceStorage.id, gone.id));
  await removeRetiredStorage(gone.id).catch((error) => console.warn("[storage] couldn't remove the disconnected storage", error));
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.disconnected",
    target: { type: "storage", id: workspaceId, label: target ? auditLabel(targetLocation(target)) : "" },
  });
}
