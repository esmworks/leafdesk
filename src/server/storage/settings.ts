import { randomBytes } from "node:crypto";
import { and, eq, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, workspace, workspaceStorage, workspaceStorageOauth } from "@/db/schema";
import { env } from "@/lib/env";
import {
  isOAuthStorageKind,
  locationOf,
  OAUTH_STORAGE_KINDS,
  parseS3Input,
  sameLocation,
  sameS3Location,
  StorageInputError,
  type OAuthCredentials,
  type OAuthStorageKind,
  type S3Credentials,
  type S3StorageInput,
  type StorageCredentials,
  type StorageLocation,
  type StorageSettingsView,
  type StorageView,
} from "@/lib/workspace-storage";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { openJson, sealJson } from "@/server/secret-box";
import { dropboxAccount } from "./dropbox";
import { StorageError } from "./driver";
import { driveAccount, driveFolder } from "./gdrive";
import { uploadLimits } from "./index";
import { authorizationUrl, exchangeCode, oauthSession, pkce } from "./oauth-session";
import { currentTarget, markBroken, probeStorage, removeRetiredStorage, targetDriver, type StorageTarget, type TargetDriverOptions } from "./workspace";

/**
 * Settings > Storage, for owners: connect the workspace's own storage (tried with a test object
 * before it is kept), try it again, or disconnect it. Files already stored stay where they are:
 * connecting moves nothing, and a disconnected storage keeps serving the files it holds until they
 * are deleted.
 *
 * An S3-compatible bucket is connected with the keys an owner types. Google Drive and Dropbox are
 * connected by signing in there (`beginStorageOAuth`, then `completeStorageOAuth` when the browser
 * comes back), as the app the instance registered with them.
 */

export type StorageSettingsErrorCode =
  | StorageInputError["field"]
  | "unavailable"
  | "notConfigured"
  | "oauthFailed"
  | "refused"
  | "rateLimited"
  | "noStorage";

export class StorageSettingsError extends Error {
  constructor(
    readonly code: StorageSettingsErrorCode,
    /** For `refused` and `oauthFailed`: what the storage said. */
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
    ...locationOf(target),
    id: target.id,
    status: target.status,
    lastError: target.lastError,
    lastErrorAt: target.lastErrorAt?.toISOString() ?? null,
    verifiedAt: target.verifiedAt.toISOString(),
    files: used.files,
    bytes: used.bytes,
  };
}

/** What the audit log names a target by: its bucket and host, or the account and folder. */
function labelOf(location: StorageLocation) {
  switch (location.kind) {
    case "s3": {
      const host = location.config.endpoint ? new URL(location.config.endpoint).host : "s3.amazonaws.com";
      return `${location.config.bucket} (${host})`;
    }
    case "gdrive":
      return `Google Drive: ${location.config.folderName} (${location.config.account})`;
    case "dropbox":
      return `Dropbox (${location.config.account})`;
  }
}

/** The sign-in kinds this instance has an app for. */
const oauthReady = () => OAUTH_STORAGE_KINDS.filter((kind) => env.storageOAuthApps[kind]);

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
    oauthReady: oauthReady(),
  };
}

/**
 * What was typed for an S3-compatible bucket, checked: the config and the credentials. Keys left
 * blank are the current storage's, when it is the same bucket (so its keys can be kept while other
 * settings change). Drive and Dropbox aren't typed: they are signed in to (see below).
 */
function readInput(kind: unknown, input: S3StorageInput, current: StorageTarget | null): { location: StorageLocation; credentials: S3Credentials } {
  if (kind !== "s3") throw new StorageSettingsError("unavailable");
  const blankKeys = !String(input?.accessKeyId ?? "").trim() && !String(input?.secretAccessKey ?? "").trim();
  const kept = blankKeys && current?.kind === "s3" ? openJson<S3Credentials>(current.credentials) : null;
  try {
    const parsed = parseS3Input(kept ? { ...input, ...kept } : input);
    if (kept && !sameS3Location(parsed.config, locationOf(current!).config as typeof parsed.config)) throw new StorageInputError("accessKeyId");
    return { location: { kind: "s3", config: parsed.config }, credentials: parsed.credentials };
  } catch (error) {
    if (error instanceof StorageInputError) throw new StorageSettingsError(error.field);
    throw error;
  }
}

/** A storage failure while trying a target, as the settings say it. */
function refusal(error: unknown): never {
  if (error instanceof StorageError) throw new StorageSettingsError("refused", error.message);
  if (error instanceof Error && error.message.startsWith("Bad storage key")) throw new StorageSettingsError("refused", error.message);
  throw error;
}

/** Puts a test object there and back with these settings; throws `refused` with what went wrong. */
async function probe(workspaceId: string, location: StorageLocation, credentials: StorageCredentials, options?: TargetDriverOptions) {
  countTry(workspaceId);
  try {
    await probeStorage(targetDriver(location, credentials, options), workspaceId);
  } catch (error) {
    refusal(error);
  }
}

/** Tries the settings without keeping them. */
export async function testStorage(userId: string, workspaceId: string, kind: unknown, input: S3StorageInput): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const parsed = readInput(kind, input, await currentTarget(workspaceId));
  await probe(workspaceId, parsed.location, parsed.credentials);
}

/**
 * Keeps a target that was just tried: new uploads go there from then on. The same place again (new
 * keys, or signing in to the same account) updates the connection; another one takes over from the
 * current, which keeps serving the files it holds.
 */
async function saveTarget(userId: string, workspaceId: string, location: StorageLocation, credentials: StorageCredentials) {
  const replaced = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:workspace-storage:${workspaceId}`}))`);
    const [current] = await tx
      .select()
      .from(workspaceStorage)
      .where(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")));
    const values = {
      config: location.config,
      credentials: sealJson(credentials),
      status: "active" as const,
      lastError: null,
      lastErrorAt: null,
      verifiedAt: new Date(),
    };
    if (current && sameLocation(locationOf(current), location)) {
      await tx.update(workspaceStorage).set(values).where(eq(workspaceStorage.id, current.id));
      return null;
    }
    if (current) await tx.update(workspaceStorage).set({ status: "disconnected" }).where(eq(workspaceStorage.id, current.id));
    await tx.insert(workspaceStorage).values({ workspaceId, kind: location.kind, createdBy: userId, ...values });
    return current ?? null;
  });
  if (replaced) await removeRetiredStorage(replaced.id).catch((error) => console.warn("[storage] couldn't remove the replaced storage", error));
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.connected",
    target: { type: "storage", id: workspaceId, label: labelOf(location) },
  });
}

/** Connects an S3-compatible bucket once a test object went there and back (see saveTarget). */
export async function connectStorage(userId: string, workspaceId: string, kind: unknown, input: S3StorageInput): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const parsed = readInput(kind, input, await currentTarget(workspaceId));
  await probe(workspaceId, parsed.location, parsed.credentials);
  await saveTarget(userId, workspaceId, parsed.location, parsed.credentials);
  return getStorageSettings(userId, workspaceId);
}

/** Tries the connected storage again with its own settings: active again when it works. */
export async function retestStorage(userId: string, workspaceId: string): Promise<StorageSettingsView> {
  await requireMembership(userId, workspaceId, "owner");
  const current = await currentTarget(workspaceId);
  if (!current) throw new StorageSettingsError("noStorage");
  try {
    let driver: ReturnType<typeof targetDriver>;
    try {
      driver = targetDriver(locationOf(current), openJson<StorageCredentials>(current.credentials), {
        // A sign-in refreshed on the way is kept, unless it was replaced meanwhile.
        persist: async (credentials) => {
          await db
            .update(workspaceStorage)
            .set({ credentials: sealJson(credentials) })
            .where(and(eq(workspaceStorage.id, current.id), eq(workspaceStorage.credentials, current.credentials)));
        },
      });
    } catch (error) {
      refusal(error);
    }
    countTry(workspaceId);
    await probeStorage(driver, workspaceId).catch(refusal);
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
    target: { type: "storage", id: workspaceId, label: labelOf(locationOf(gone)) },
  });
  return getStorageSettings(userId, workspaceId);
}

// ---------------------------------------------------------------------- Drive and Dropbox

/** How long a sign-in begun may take. */
const OAUTH_STATE_MS = 15 * 60_000;

/** Where Drive and Dropbox send the browser back to (registered with the instance's apps). */
export const storageOAuthRedirectUrl = () => `${env.appUrl}/api/storage/oauth/callback`;

/** Begins signing in to Drive or Dropbox for the workspace's storage: the address to send the browser to. */
export async function beginStorageOAuth(userId: string, workspaceId: string, kind: unknown): Promise<{ url: string }> {
  await requireMembership(userId, workspaceId, "owner");
  if (!isOAuthStorageKind(kind)) throw new StorageSettingsError("unavailable");
  const app = env.storageOAuthApps[kind];
  if (!app) throw new StorageSettingsError("notConfigured");
  countTry(workspaceId);
  await db.delete(workspaceStorageOauth).where(lte(workspaceStorageOauth.createdAt, new Date(Date.now() - OAUTH_STATE_MS)));
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkce();
  await db.insert(workspaceStorageOauth).values({ state, workspaceId, userId, kind, data: sealJson({ verifier }) });
  return { url: authorizationUrl(kind, app, { state, challenge, redirectUri: storageOAuthRedirectUrl() }) };
}

/** The workspace a sign-in begun with `state` belongs to, for sending the browser back whatever became of it. */
export async function storageOAuthReturnOf(state: string): Promise<string | null> {
  const [found] = await db.select({ workspaceId: workspaceStorageOauth.workspaceId }).from(workspaceStorageOauth).where(eq(workspaceStorageOauth.state, state)).limit(1);
  return found?.workspaceId ?? null;
}

/** Where the files go in the signed-in account: Drive's folder for the workspace, Dropbox's app folder. */
async function locationFor(kind: OAuthStorageKind, credentials: OAuthCredentials, workspaceId: string): Promise<{ location: StorageLocation; credentials: OAuthCredentials }> {
  const session = oauthSession(kind, env.storageOAuthApps[kind]!, credentials);
  if (kind === "dropbox") {
    const account = await dropboxAccount(session);
    return { location: { kind, config: account }, credentials: session.credentials() };
  }
  const account = await driveAccount(session);
  const [named] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const folder = await driveFolder(session, workspaceId, `Leafdesk (${(named?.name ?? workspaceId).slice(0, 80)})`);
  return { location: { kind, config: { ...account, ...folder } }, credentials: session.credentials() };
}

/**
 * The browser came back from Drive or Dropbox: finishes the sign-in begun with `state` by the same
 * person, still an owner; tries the storage with a test object; and connects it (see saveTarget).
 * Returns the workspace.
 */
export async function completeStorageOAuth(userId: string, input: { state: string; code: string }): Promise<{ workspaceId: string }> {
  const [pending] = await db.delete(workspaceStorageOauth).where(eq(workspaceStorageOauth.state, input.state)).returning();
  if (!pending || pending.userId !== userId || pending.createdAt.getTime() < Date.now() - OAUTH_STATE_MS || !isOAuthStorageKind(pending.kind)) {
    throw new StorageSettingsError("oauthFailed", "This sign-in expired or was begun by someone else; begin it again");
  }
  const { workspaceId, kind } = pending;
  await requireMembership(userId, workspaceId, "owner");
  const app = env.storageOAuthApps[kind];
  if (!app) throw new StorageSettingsError("notConfigured");
  const { verifier } = openJson<{ verifier: string }>(pending.data);
  let found: Awaited<ReturnType<typeof locationFor>>;
  try {
    const credentials = await exchangeCode(kind, app, { code: input.code, verifier, redirectUri: storageOAuthRedirectUrl() });
    found = await locationFor(kind, credentials, workspaceId);
  } catch (error) {
    if (error instanceof StorageError) throw new StorageSettingsError("oauthFailed", error.message);
    throw error;
  }
  await probe(workspaceId, found.location, found.credentials);
  await saveTarget(userId, workspaceId, found.location, found.credentials);
  return { workspaceId };
}
