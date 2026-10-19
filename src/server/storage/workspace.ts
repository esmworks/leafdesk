import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, storageDeletion, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import { locationOf, type OAuthCredentials, type OAuthStorageKind, type S3Credentials, type StorageCredentials, type StorageLocation } from "@/lib/workspace-storage";
import { openJson, sealJson } from "@/server/secret-box";
import { StorageError, type ObjectRef, type StorageDriver } from "./driver";
import { dropboxDriver } from "./dropbox";
import { gdriveDriver } from "./gdrive";
import { instanceStorage, uploadLimits } from "./index";
import { OAUTH_PROVIDERS, oauthSession } from "./oauth-session";
import { s3Driver } from "./s3";

/**
 * Which storage a workspace's files are in. A workspace stores new uploads in its own storage while
 * it has one connected (`storageFor`), the instance's otherwise; a file is read and deleted where it
 * was stored (`storageOf`, by `file.storage_id`), wherever new uploads go now. Avatars always live
 * in the instance's storage.
 *
 * Requests to a workspace's storage watch how it answers: one it refuses (revoked keys, a deleted
 * bucket, a host that is gone) marks it broken with the error, for Settings > Storage to show; the
 * next one that works marks it active again. A server error or "slow down" doesn't count. Uploads
 * never fall back to the instance's storage when the workspace's own is broken: they fail.
 */

export type StorageTarget = typeof workspaceStorage.$inferSelect;

export type TargetDriverOptions = {
  /** Keeps credentials a sign-in refreshed (OAuth kinds); none while a target is only being tried. */
  persist?: (credentials: OAuthCredentials) => Promise<void>;
};

/**
 * A driver for a target's kind, config and credentials. An S3 endpoint is one someone typed, so
 * guarded; Drive and Dropbox are reached at their own fixed addresses, signed in as the instance's
 * app for them (STORAGE_GDRIVE_* / STORAGE_DROPBOX_*).
 */
export function targetDriver(location: StorageLocation, credentials: StorageCredentials, options: TargetDriverOptions = {}): StorageDriver {
  if (location.kind === "s3") {
    const { config } = location;
    const keys = credentials as S3Credentials;
    return s3Driver({
      bucket: config.bucket,
      endpoint: config.endpoint ?? undefined,
      region: config.region,
      accessKeyId: keys.accessKeyId,
      secretAccessKey: keys.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      prefix: config.prefix ?? undefined,
      guard: { allowedHosts: env.storageAllowedHosts },
    });
  }
  const app = env.storageOAuthApps[location.kind];
  if (!app) throw new StorageError(`This server has no ${OAUTH_PROVIDERS[location.kind].name} app set up any more`);
  const session = oauthSession(location.kind, app, credentials as OAuthCredentials, { persist: options.persist });
  if (location.kind === "gdrive") return gdriveDriver({ folderId: location.config.folderId, session });
  return dropboxDriver({ session });
}

type Cached = { fingerprint: string; driver: StorageDriver };
const CACHE = "__leafdeskStorageTargets";

/** Drivers by target, made again when its config, credentials or the allowed hosts change. */
function cache(): Map<string, Cached> {
  const holder = globalThis as Record<string, unknown>;
  holder[CACHE] ??= new Map<string, Cached>();
  return holder[CACHE] as Map<string, Cached>;
}

function cachedDriver(target: StorageTarget): StorageDriver {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([target.kind, target.config, target.credentials, env.storageAllowedHosts, env.storageOAuthApps[target.kind as OAuthStorageKind] ?? null]))
    .digest("base64url");
  const found = cache().get(target.id);
  if (found?.fingerprint === fingerprint) return found.driver;
  let sealed = target.credentials;
  const driver = targetDriver(locationOf(target), openJson<StorageCredentials>(target.credentials), {
    // Only over the credentials this driver began with: never over a newer sign-in's.
    async persist(credentials) {
      const next = sealJson(credentials);
      const [kept] = await db
        .update(workspaceStorage)
        .set({ credentials: next })
        .where(and(eq(workspaceStorage.id, target.id), eq(workspaceStorage.credentials, sealed)))
        .returning({ id: workspaceStorage.id });
      if (kept) sealed = next;
    },
  });
  cache().set(target.id, { fingerprint, driver });
  return driver;
}

/** Whether a failure says something about the storage (rather than a passing hiccup or a bug of ours). */
function countsAgainst(error: unknown) {
  if (error instanceof StorageError) return !error.transient;
  return !(error instanceof Error && error.message.startsWith("Bad storage key"));
}

/** Records that the target refused a request: broken, unless it is disconnected already. */
export async function markBroken(id: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await db
    .update(workspaceStorage)
    .set({
      status: sql`case when ${workspaceStorage.status} = 'active' then 'broken' else ${workspaceStorage.status} end`,
      lastError: message,
      lastErrorAt: new Date(),
    })
    .where(eq(workspaceStorage.id, id));
}

async function markWorking(id: string) {
  await db
    .update(workspaceStorage)
    .set({ status: "active", lastError: null, lastErrorAt: null })
    .where(and(eq(workspaceStorage.id, id), eq(workspaceStorage.status, "broken")));
}

/** The target's driver, reporting how its requests go (see above). */
function watched(target: StorageTarget): StorageDriver {
  // Made on the first request, so a target that can't have a driver (its app was taken off the
  // server) is reported like one that refuses.
  const inner = () => cachedDriver(target);
  const report = async <T>(request: (driver: StorageDriver) => Promise<T>): Promise<T> => {
    try {
      const result = await request(inner());
      if (target.status === "broken") await markWorking(target.id).catch(() => undefined);
      return result;
    } catch (error) {
      if (countsAgainst(error)) await markBroken(target.id, error).catch(() => undefined);
      throw error;
    }
  };
  return {
    kind: target.kind,
    put: (key, body, info) => report((driver) => driver.put(key, body, info)),
    get: (ref, range) => report((driver) => driver.get(ref, range)),
    delete: (ref) => report((driver) => driver.delete(ref)),
  };
}

/** The workspace's storage new uploads go to: not disconnected (active or broken), or none. */
export async function currentTarget(workspaceId: string): Promise<StorageTarget | null> {
  const [target] = await db
    .select()
    .from(workspaceStorage)
    .where(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")))
    .limit(1);
  return target ?? null;
}

export type UploadTarget = {
  /** The workspace's storage (for `file.storage_id`); null for the instance's. */
  storageId: string | null;
  driver: StorageDriver;
  /**
   * Bytes the workspace may keep in this storage: the instance's quota for the instance's storage
   * (UPLOAD_WORKSPACE_QUOTA_MB), none for its own.
   */
  quotaBytes: number;
};

/** Where the workspace's new uploads go (see above). */
export async function storageFor(workspaceId: string): Promise<UploadTarget> {
  const target = await currentTarget(workspaceId);
  if (!target) return { storageId: null, driver: instanceStorage(), quotaBytes: uploadLimits().workspaceQuotaBytes };
  return { storageId: target.id, driver: watched(target), quotaBytes: Infinity };
}

/** A stored object's place: which storage, and its ref there. */
export type StoredObject = { storageId: string | null; key: string; objectId?: string | null };

/** The storage a file (or queued deletion) is in. Throws when a workspace's storage is gone. */
export async function storageOf(stored: { storageId: string | null }): Promise<StorageDriver> {
  if (!stored.storageId) return instanceStorage();
  const [target] = await db.select().from(workspaceStorage).where(eq(workspaceStorage.id, stored.storageId));
  if (!target) throw new StorageError("The workspace's storage is gone");
  return watched(target);
}

/** `storageOf` for many objects in a row (an export, a cleanup): each storage is looked up once. */
export function storageResolver(): (stored: { storageId: string | null }) => Promise<StorageDriver> {
  const seen = new Map<string, Promise<StorageDriver>>();
  return (stored) => {
    if (!stored.storageId) return Promise.resolve(instanceStorage());
    let driver = seen.get(stored.storageId);
    if (!driver) {
      driver = storageOf(stored);
      seen.set(stored.storageId, driver);
      // A lookup that failed is tried again for the next object.
      driver.catch(() => seen.delete(stored.storageId!));
    }
    return driver;
  };
}

/** The ref of a file's (or queued object's) bytes in its storage. */
export const refOf = (stored: { storageKey: string; storageObjectId?: string | null }): ObjectRef => ({
  key: stored.storageKey,
  objectId: stored.storageObjectId ?? null,
});

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<Buffer | null> {
  if (!stream) return null;
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/**
 * Tries a storage before it is kept: stores a small object under the workspace, reads it back
 * whole and in part (files are served in ranges), and deletes it. Throws a StorageError saying what
 * didn't work.
 */
export async function probeStorage(driver: StorageDriver, workspaceId: string): Promise<void> {
  const key = `${workspaceId}/leafdesk-check-${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
  const payload = Buffer.from(`Leafdesk storage check ${randomBytes(12).toString("hex")}\n`);
  const objectId = await driver.put(key, Readable.from([payload]), { size: payload.length, contentType: "text/plain" });
  const ref: ObjectRef = { key, objectId: objectId || null };
  try {
    const whole = await readAll(await driver.get(ref));
    if (!whole) throw new StorageError("The test file wasn't there when read back");
    if (!whole.equals(payload)) throw new StorageError("The test file came back different");
    const part = await readAll(await driver.get(ref, { start: 9, end: 15 }));
    if (!part?.equals(payload.subarray(9, 16))) throw new StorageError("The storage doesn't answer byte ranges");
  } catch (error) {
    await driver.delete(ref).catch(() => undefined);
    throw error;
  }
  await driver.delete(ref);
}

/**
 * Removes workspace storage nothing needs any more: disconnected (or left by a deleted workspace)
 * and holding no file and no queued deletion. Its credentials go with it. Returns how many went.
 */
export async function removeRetiredStorage(id?: string): Promise<number> {
  const gone = await db
    .delete(workspaceStorage)
    .where(
      and(
        id ? eq(workspaceStorage.id, id) : undefined,
        or(eq(workspaceStorage.status, "disconnected"), isNull(workspaceStorage.workspaceId)),
        sql`not exists (select 1 from ${file} f where f.storage_id = ${workspaceStorage.id})`,
        sql`not exists (select 1 from ${storageDeletion} d where d.storage_id = ${workspaceStorage.id})`,
      ),
    )
    .returning({ id: workspaceStorage.id });
  for (const { id: removed } of gone) cache().delete(removed);
  return gone.length;
}
