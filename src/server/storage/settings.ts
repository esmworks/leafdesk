import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, workspaceStorage } from "@/db/schema";
import {
  AVAILABLE_STORAGE_KINDS,
  parseS3Input,
  sameS3Location,
  StorageInputError,
  type S3Credentials,
  type S3StorageInput,
  type StorageConfig,
  type StorageKind,
  type StorageSettingsView,
  type StorageView,
} from "@/lib/workspace-storage";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { openJson, sealJson } from "@/server/secret-box";
import { StorageError } from "./driver";
import { uploadLimits } from "./index";
import { currentTarget, markBroken, probeStorage, removeRetiredStorage, targetDriver, type StorageTarget } from "./workspace";

/**
 * Settings > Storage, for owners: connect the workspace's own storage (tried with a test object
 * before it is kept), try it again, or disconnect it. Files already stored stay where they are:
 * connecting moves nothing, and a disconnected storage keeps serving the files it holds until they
 * are deleted. Only S3-compatible storage can be connected so far.
 */

export type StorageSettingsErrorCode = StorageInputError["field"] | "unavailable" | "refused" | "rateLimited" | "noStorage";

export class StorageSettingsError extends Error {
  constructor(
    readonly code: StorageSettingsErrorCode,
    /** For `refused`: what the storage said. */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Tries per workspace in a window: each one reaches out to a host an owner typed. */
const MAX_TRIES = 20;
const TRY_WINDOW_MS = 10 * 60 * 1000;
const tries = new Map<string, number[]>();

function countTry(workspaceId: string, now = Date.now()) {
  const recent = (tries.get(workspaceId) ?? []).filter((at) => now - at < TRY_WINDOW_MS);
  if (recent.length >= MAX_TRIES) throw new StorageSettingsError("rateLimited");
  recent.push(now);
  tries.set(workspaceId, recent);
}

/** A target as the settings show it: never its credentials. */
function viewOf(target: StorageTarget, usage: Map<string | null, { files: number; bytes: number }>): StorageView {
  const used = usage.get(target.id) ?? { files: 0, bytes: 0 };
  return {
    id: target.id,
    kind: target.kind,
    config: target.config,
    status: target.status,
    lastError: target.lastError,
    lastErrorAt: target.lastErrorAt?.toISOString() ?? null,
    verifiedAt: target.verifiedAt.toISOString(),
    files: used.files,
    bytes: used.bytes,
  };
}

/** What the audit log names a target by: its bucket and host. */
function labelOf(config: StorageConfig) {
  const host = config.endpoint ? new URL(config.endpoint).host : "s3.amazonaws.com";
  return `${config.bucket} (${host})`;
}

export async function getStorageSettings(userId: string, workspaceId: string): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const [targets, counts] = await Promise.all([
    db.select().from(workspaceStorage).where(eq(workspaceStorage.workspaceId, workspaceId)),
    db
      .select({ storageId: file.storageId, files: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${file.size}), 0)` })
      .from(file)
      .where(eq(file.workspaceId, workspaceId))
      .groupBy(file.storageId),
  ]);
  const usage = new Map(counts.map((c) => [c.storageId, { files: c.files, bytes: Number(c.bytes) }]));
  const current = targets.find((t) => t.status !== "disconnected");
  const quota = uploadLimits().workspaceQuotaBytes;
  return {
    current: current ? viewOf(current, usage) : null,
    retired: targets
      .filter((t) => t.status === "disconnected" && (usage.get(t.id)?.files ?? 0) > 0)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => viewOf(t, usage)),
    instanceUsed: usage.get(null)?.bytes ?? 0,
    instanceQuota: quota === Infinity ? null : quota,
  };
}

/**
 * What was typed, checked: the config and the credentials. Keys left blank are the current
 * storage's, when it is the same bucket (so its keys can be kept while other settings change).
 */
function readInput(kind: unknown, input: S3StorageInput, current: StorageTarget | null) {
  if (typeof kind !== "string" || !AVAILABLE_STORAGE_KINDS.includes(kind as StorageKind)) throw new StorageSettingsError("unavailable");
  const blankKeys = !String(input?.accessKeyId ?? "").trim() && !String(input?.secretAccessKey ?? "").trim();
  const kept = blankKeys && current?.kind === "s3" ? openJson<S3Credentials>(current.credentials) : null;
  try {
    const parsed = parseS3Input(kept ? { ...input, ...kept } : input);
    if (kept && !sameS3Location(parsed.config, current!.config)) throw new StorageInputError("accessKeyId");
    return { kind: kind as StorageKind, ...parsed };
  } catch (error) {
    if (error instanceof StorageInputError) throw new StorageSettingsError(error.field);
    throw error;
  }
}

/** Puts a test object there and back with these settings; throws `refused` with what went wrong. */
async function probe(workspaceId: string, kind: StorageKind, config: StorageConfig, credentials: S3Credentials) {
  countTry(workspaceId);
  try {
    await probeStorage(targetDriver(kind, config, credentials), workspaceId);
  } catch (error) {
    if (error instanceof StorageError) throw new StorageSettingsError("refused", error.message);
    if (error instanceof Error && error.message.startsWith("Bad storage key")) throw new StorageSettingsError("refused", error.message);
    throw error;
  }
}

/** Tries the settings without keeping them. */
export async function testStorage(userId: string, workspaceId: string, kind: unknown, input: S3StorageInput): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const parsed = readInput(kind, input, await currentTarget(workspaceId));
  await probe(workspaceId, parsed.kind, parsed.config, parsed.credentials);
}

/**
 * Connects the workspace's own storage once a test object went there and back: new uploads go
 * there from then on. The same bucket again (new keys, say) updates the connection; another one
 * takes over from the current, which keeps serving the files it holds.
 */
export async function connectStorage(userId: string, workspaceId: string, kind: unknown, input: S3StorageInput): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const parsed = readInput(kind, input, await currentTarget(workspaceId));
  await probe(workspaceId, parsed.kind, parsed.config, parsed.credentials);
  const replaced = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:workspace-storage:${workspaceId}`}))`);
    const [current] = await tx
      .select()
      .from(workspaceStorage)
      .where(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")));
    const values = {
      config: parsed.config,
      credentials: sealJson(parsed.credentials),
      status: "active" as const,
      lastError: null,
      lastErrorAt: null,
      verifiedAt: new Date(),
    };
    if (current && current.kind === parsed.kind && sameS3Location(current.config, parsed.config)) {
      await tx.update(workspaceStorage).set(values).where(eq(workspaceStorage.id, current.id));
      return null;
    }
    if (current) await tx.update(workspaceStorage).set({ status: "disconnected" }).where(eq(workspaceStorage.id, current.id));
    await tx.insert(workspaceStorage).values({ workspaceId, kind: parsed.kind, createdBy: userId, ...values });
    return current ?? null;
  });
  if (replaced) await removeRetiredStorage(replaced.id).catch((error) => console.warn("[storage] couldn't remove the replaced storage", error));
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.connected",
    target: { type: "storage", id: workspaceId, label: labelOf(parsed.config) },
  });
  return getStorageSettings(userId, workspaceId);
}

/** Tries the connected storage again with its own settings: active again when it works. */
export async function retestStorage(userId: string, workspaceId: string): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const current = await currentTarget(workspaceId);
  if (!current) throw new StorageSettingsError("noStorage");
  try {
    await probe(workspaceId, current.kind, current.config, openJson<S3Credentials>(current.credentials));
  } catch (error) {
    if (error instanceof StorageSettingsError && error.code === "refused") await markBroken(current.id, new Error(error.detail));
    throw error;
  }
  await db
    .update(workspaceStorage)
    .set({ status: "active", lastError: null, lastErrorAt: null, verifiedAt: new Date() })
    .where(and(eq(workspaceStorage.id, current.id), ne(workspaceStorage.status, "disconnected")));
  return getStorageSettings(userId, workspaceId);
}

/**
 * Disconnects the workspace's own storage: new uploads go to the instance's storage again. The
 * files it holds are still read from there (with its keys) until they are deleted; with none, it
 * is forgotten right away.
 */
export async function disconnectStorage(userId: string, workspaceId: string): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const [gone] = await db
    .update(workspaceStorage)
    .set({ status: "disconnected" })
    .where(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")))
    .returning();
  if (!gone) throw new StorageSettingsError("noStorage");
  await removeRetiredStorage(gone.id).catch((error) => console.warn("[storage] couldn't remove the disconnected storage", error));
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.disconnected",
    target: { type: "storage", id: workspaceId, label: labelOf(gone.config) },
  });
  return getStorageSettings(userId, workspaceId);
}
