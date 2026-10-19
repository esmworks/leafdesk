import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { file, storageAccount, storageDeletion, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import {
  locationOf,
  type AccountLocation,
  type OAuthCredentials,
  type OAuthStorageKind,
  type S3Credentials,
  type StorageCredentials,
  type StorageLocation,
} from "@/lib/workspace-storage";
import { openJson, sealJson } from "@/server/secret-box";
import { StorageError, type ObjectRef, type StorageDriver } from "./driver";
import { dropboxDriver } from "./dropbox";
import { gdriveDriver } from "./gdrive";
import { instanceStorage, uploadLimits } from "./index";
import { OAUTH_PROVIDERS, oauthSession } from "./oauth-session";
import { s3Driver } from "./s3";

/**
 * Which storage a workspace's files are in. A workspace stores new uploads in its place in a
 * storage account while it has one (`storageFor`), the instance's otherwise; a file is read and
 * deleted where it was stored (`storageOf`, by `file.storage_id`), wherever new uploads go now.
 * Avatars always live in the instance's storage.
 *
 * Requests to someone's storage watch how it answers: one it refuses (revoked keys, a deleted
 * bucket, a host that is gone) marks its account broken with the error, for the settings to show;
 * the next one that works marks it active again. A server error or "slow down" doesn't count.
 * Uploads never fall back to the instance's storage when the workspace's own is broken: they fail.
 * None of this depends on OWN_STORAGE_ENABLED: workspaces connected while it was on keep working.
 */

export type StorageAccountRow = typeof storageAccount.$inferSelect;
/** A workspace's place in a storage account, with the account. */
export type StorageTarget = typeof workspaceStorage.$inferSelect & { account: StorageAccountRow };

/** Where a target's files are: its account's location with the workspace's place in it. */
export const targetLocation = (target: StorageTarget): StorageLocation => locationOf(target.account, target.config);

/** Places (with their accounts) matching `where`. */
export async function loadTargets(where: SQL | undefined, reader: Pick<typeof db, "select"> = db): Promise<StorageTarget[]> {
  const rows = await reader.select({ place: workspaceStorage, account: storageAccount }).from(workspaceStorage).innerJoin(storageAccount, eq(storageAccount.id, workspaceStorage.storageAccountId)).where(where);
  return rows.map(({ place, account }) => ({ ...place, account }));
}

export type TargetDriverOptions = {
  /** Keeps credentials a sign-in refreshed (OAuth kinds); none while a target is only being tried. */
  persist?: (credentials: OAuthCredentials) => Promise<void>;
};

/**
 * A driver for a target's kind, config and credentials. An S3 endpoint is one someone typed, so
 * guarded; Drive and Dropbox are reached at their own fixed addresses, signed in as the instance's
 * app for them (STORAGE_GDRIVE_* / STORAGE_DROPBOX_*).
 */
export function targetDriver(location: StorageLocation | AccountLocation, credentials: StorageCredentials, options: TargetDriverOptions = {}): StorageDriver {
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
  if (location.kind === "gdrive") {
    // A workspace's folder, or (trying the account itself) the Leafdesk folder the workspaces' go in.
    const folderId = ("folderId" in location.config && location.config.folderId) || location.config.rootFolderId;
    if (!folderId) throw new StorageError("No Google Drive folder to use yet");
    return gdriveDriver({ folderId, session });
  }
  return dropboxDriver({ session });
}

/**
 * Keeps credentials a sign-in refreshed on the account, only over the ones the driver began with:
 * never over a newer sign-in's. Returns the persist option, and follows what it wrote.
 */
export function persistOn(accountId: string, sealed: string): TargetDriverOptions {
  let current = sealed;
  return {
    async persist(credentials) {
      const next = sealJson(credentials);
      const [kept] = await db
        .update(storageAccount)
        .set({ credentials: next })
        .where(and(eq(storageAccount.id, accountId), eq(storageAccount.credentials, current)))
        .returning({ id: storageAccount.id });
      if (kept) current = next;
    },
  };
}

/** A driver for a storage account itself (trying it, before any workspace has a place there). */
export function accountDriver(account: StorageAccountRow): StorageDriver {
  return targetDriver(locationOf(account) as AccountLocation, openJson<StorageCredentials>(account.credentials), persistOn(account.id, account.credentials));
}

type Cached = { fingerprint: string; driver: StorageDriver };
const CACHE = "__leafdeskStorageTargets";

/** Drivers by place, made again when its config, its account's credentials or the allowed hosts change. */
function cache(): Map<string, Cached> {
  const holder = globalThis as Record<string, unknown>;
  holder[CACHE] ??= new Map<string, Cached>();
  return holder[CACHE] as Map<string, Cached>;
}

function cachedDriver(target: StorageTarget): StorageDriver {
  const { account } = target;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([account.kind, account.config, target.config, account.credentials, env.storageAllowedHosts, env.storageOAuthApps[account.kind as OAuthStorageKind] ?? null]))
    .digest("base64url");
  const found = cache().get(target.id);
  if (found?.fingerprint === fingerprint) return found.driver;
  const driver = targetDriver(targetLocation(target), openJson<StorageCredentials>(account.credentials), persistOn(account.id, account.credentials));
  cache().set(target.id, { fingerprint, driver });
  return driver;
}

/** Whether a failure says something about the storage (rather than a passing hiccup or a bug of ours). */
function countsAgainst(error: unknown) {
  if (error instanceof StorageError) return !error.transient;
  return !(error instanceof Error && error.message.startsWith("Bad storage key"));
}

/** Records that a storage account refused a request: broken, unless it is disconnected already. */
export async function markBroken(accountId: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await db
    .update(storageAccount)
    .set({
      status: sql`case when ${storageAccount.status} = 'active' then 'broken' else ${storageAccount.status} end`,
      lastError: message,
      lastErrorAt: new Date(),
    })
    .where(eq(storageAccount.id, accountId));
}

async function markWorking(accountId: string) {
  await db
    .update(storageAccount)
    .set({ status: "active", lastError: null, lastErrorAt: null })
    .where(and(eq(storageAccount.id, accountId), eq(storageAccount.status, "broken")));
}

/** The target's driver, reporting how its requests go (see above). */
function watched(target: StorageTarget): StorageDriver {
  // Made on the first request, so a target that can't have a driver (its app was taken off the
  // server) is reported like one that refuses.
  const inner = () => cachedDriver(target);
  const report = async <T>(request: (driver: StorageDriver) => Promise<T>): Promise<T> => {
    try {
      const result = await request(inner());
      if (target.account.status === "broken") await markWorking(target.account.id).catch(() => undefined);
      return result;
    } catch (error) {
      if (countsAgainst(error)) await markBroken(target.account.id, error).catch(() => undefined);
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

/** Whether the workspace ever kept files in someone's storage (Settings > Storage stays for it while own storage is off). */
export async function hasOwnStorage(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ id: workspaceStorage.id }).from(workspaceStorage).where(eq(workspaceStorage.workspaceId, workspaceId)).limit(1);
  return Boolean(row);
}

/** The workspace's place new uploads go to: the one not disconnected, or none. */
export async function currentTarget(workspaceId: string, reader: Pick<typeof db, "select"> = db): Promise<StorageTarget | null> {
  const [target] = await loadTargets(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")), reader);
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
  const [target] = await loadTargets(eq(workspaceStorage.id, stored.storageId));
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
 * Tries a storage before it is kept: stores a small object under `scope` (a workspace's id, or
 * "leafdesk-check" for an account no workspace uses yet), reads it back whole and in part (files
 * are served in ranges), and deletes it. Throws a StorageError saying what didn't work.
 */
export async function probeStorage(driver: StorageDriver, scope: string): Promise<void> {
  const key = `${scope}/leafdesk-check-${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
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
 * Removes workspaces' places nothing needs any more: disconnected (or left by a deleted workspace)
 * and holding no file and no queued deletion; then the storage accounts nothing needs any more
 * (disconnected, or their owner's Leafdesk account is gone) once no place is in them, with their
 * credentials. Returns how many places went.
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
  await db
    .delete(storageAccount)
    .where(
      and(
        or(eq(storageAccount.status, "disconnected"), isNull(storageAccount.userId)),
        sql`not exists (select 1 from ${workspaceStorage} w where w.storage_account_id = ${storageAccount.id})`,
      ),
    );
  return gone.length;
}
