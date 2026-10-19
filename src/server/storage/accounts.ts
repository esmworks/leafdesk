import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, storageAccount, storageMove, storageOauth, workspace, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import {
  availableStorageKinds,
  cleanAccountLabel,
  defaultAccountLabel,
  isOAuthStorageKind,
  locationOf,
  OAUTH_STORAGE_KINDS,
  parseS3Input,
  sameS3Location,
  StorageInputError,
  type AccountLocation,
  type OAuthCredentials,
  type OAuthStorageKind,
  type PlaceConfig,
  type S3Credentials,
  type S3StorageInput,
  type StorageAccountsView,
  type StorageAccountView,
  type StorageCredentials,
  type StorageLocation,
} from "@/lib/workspace-storage";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { openJson, sealJson } from "@/server/secret-box";
import { StorageError } from "./driver";
import { dropboxAccount } from "./dropbox";
import { countTry, refusal, StorageSettingsError } from "./errors";
import { driveAccount, driveFolder, driveRootFolder } from "./gdrive";
import { authorizationUrl, exchangeCode, oauthSession, pkce } from "./oauth-session";
import {
  accountDriver,
  currentTarget,
  loadTargets,
  markBroken,
  persistOn,
  probeStorage,
  removeRetiredStorage,
  targetDriver,
  type StorageAccountRow,
  type TargetDriverOptions,
} from "./workspace";

/**
 * Storage someone connects to their own account (account settings > Connected storage), once, and
 * then uses in the workspaces they own: an S3-compatible bucket with the keys they type, or Google
 * Drive or Dropbox by signing in there (`beginStorageOAuth`, then `completeStorageOAuth` when the
 * browser comes back) as the app the instance registered with them. Each workspace that uses it
 * gets a place of its own there (a Drive folder inside the account's Leafdesk folder; for a bucket
 * or a Dropbox, the workspace's keys start with its id), so one connection serves many workspaces.
 *
 * Shared workspaces read the files through Leafdesk (/api/files), so their other members need no
 * account with the storage. Only its owner can attach it to a workspace. Nothing new can be
 * connected or attached while OWN_STORAGE_ENABLED is off; what is connected keeps working.
 */

/** Refuses anything that connects new storage while own storage is off on this server. */
export function requireOwnStorage() {
  if (!env.ownStorageEnabled) throw new StorageSettingsError("disabled");
}

/** The sign-in kinds this instance has an app for. */
export const oauthReady = () => OAUTH_STORAGE_KINDS.filter((kind) => env.storageOAuthApps[kind]);

/** What the audit log names a target by: its bucket and host, or the account and folder. */
export function auditLabel(location: StorageLocation) {
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

/** Whether two accounts are the same storage: the same bucket and folder, or the same Drive or Dropbox account. */
function sameAccount(a: AccountLocation, b: AccountLocation) {
  if (a.kind === "s3" || b.kind === "s3") return a.kind === "s3" && b.kind === "s3" && sameS3Location(a.config, b.config);
  return a.kind === b.kind && a.config.accountId === b.config.accountId;
}

/** The person's storage account, or `noAccount`. */
async function ownAccount(userId: string, accountId: string): Promise<StorageAccountRow> {
  const [found] = await db
    .select()
    .from(storageAccount)
    .where(and(eq(storageAccount.id, accountId), eq(storageAccount.userId, userId)));
  if (!found) throw new StorageSettingsError("noAccount");
  return found;
}

// ---------------------------------------------------------------------- Listing

/** The person's storage accounts, with the workspaces using them (or still holding files there). */
export async function listStorageAccounts(userId: string): Promise<StorageAccountView[]> {
  const accounts = await db
    .select()
    .from(storageAccount)
    .where(eq(storageAccount.userId, userId))
    .orderBy(asc(storageAccount.createdAt));
  if (!accounts.length) return [];
  const places = await db
    .select({
      accountId: workspaceStorage.storageAccountId,
      workspaceId: workspace.id,
      name: workspace.name,
      status: workspaceStorage.status,
      files: sql<number>`(select count(*)::int from ${file} f where f.storage_id = ${workspaceStorage.id})`,
    })
    .from(workspaceStorage)
    .innerJoin(workspace, eq(workspace.id, workspaceStorage.workspaceId))
    .where(inArray(workspaceStorage.storageAccountId, accounts.map((a) => a.id)));
  const using = new Map<string, StorageAccountView["workspaces"]>();
  for (const place of places) {
    if (place.status === "disconnected" && !Number(place.files)) continue;
    const list = using.get(place.accountId) ?? [];
    const seen = list.find((w) => w.id === place.workspaceId);
    if (seen) seen.current ||= place.status !== "disconnected";
    else list.push({ id: place.workspaceId, name: place.name, current: place.status !== "disconnected" });
    using.set(place.accountId, list);
  }
  return accounts
    .map((account) => ({
      ...(locationOf(account) as AccountLocation),
      id: account.id,
      label: account.label,
      isDefault: account.isDefault,
      status: account.status,
      lastError: account.lastError,
      verifiedAt: account.verifiedAt.toISOString(),
      workspaces: using.get(account.id) ?? [],
    }))
    // A disconnected account is listed only while workspaces still read files from it.
    .filter((view) => view.status !== "disconnected" || view.workspaces.length > 0);
}

export async function getStorageAccounts(userId: string, { isAdmin = false }: { isAdmin?: boolean } = {}): Promise<StorageAccountsView> {
  const ready = oauthReady();
  return {
    ownStorage: env.ownStorageEnabled,
    accounts: await listStorageAccounts(userId),
    kinds: availableStorageKinds(env.ownStorageEnabled, ready),
    unconfigured: env.ownStorageEnabled && isAdmin ? OAUTH_STORAGE_KINDS.filter((kind) => !ready.includes(kind)) : [],
  };
}

// ---------------------------------------------------------------------- Connecting

/**
 * What was typed for an S3-compatible bucket, checked. Keys left blank are those of the person's
 * account for the same bucket, when there is one (so its keys can be kept while other settings change).
 */
async function readS3Input(userId: string, input: S3StorageInput): Promise<{ location: AccountLocation & { kind: "s3" }; credentials: S3Credentials }> {
  const blankKeys = !String(input?.accessKeyId ?? "").trim() && !String(input?.secretAccessKey ?? "").trim();
  try {
    if (blankKeys) {
      const probe = parseS3Input({ ...input, accessKeyId: "x", secretAccessKey: "x" });
      const mine = await db
        .select()
        .from(storageAccount)
        .where(and(eq(storageAccount.userId, userId), eq(storageAccount.kind, "s3"), ne(storageAccount.status, "disconnected")));
      const same = mine.find((a) => sameS3Location(locationOf(a).config as typeof probe.config, probe.config));
      if (!same) throw new StorageInputError("accessKeyId");
      const kept = openJson<S3Credentials>(same.credentials);
      return { location: { kind: "s3", config: probe.config }, credentials: kept };
    }
    const parsed = parseS3Input(input);
    return { location: { kind: "s3", config: parsed.config }, credentials: parsed.credentials };
  } catch (error) {
    if (error instanceof StorageInputError) throw new StorageSettingsError(error.field);
    throw error;
  }
}

/** Puts a test object there and back; throws `refused` with what went wrong. */
async function probeAccount(scope: string, location: AccountLocation | StorageLocation, credentials: StorageCredentials, options?: TargetDriverOptions) {
  try {
    await probeStorage(targetDriver(location, credentials, options), scope);
  } catch (error) {
    refusal(error);
  }
}

/** Where a probe of an account no workspace uses yet goes. */
const ACCOUNT_SCOPE = "leafdesk-check";

/**
 * Keeps a storage account that was just tried. The same storage again (new keys, or signing in to
 * the same account again) updates the person's connection; another one is added, as their default
 * when they have none yet.
 */
async function saveAccount(userId: string, location: AccountLocation, credentials: StorageCredentials, label?: unknown): Promise<StorageAccountRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:storage-account:${userId}`}))`);
    const mine = await tx
      .select()
      .from(storageAccount)
      .where(and(eq(storageAccount.userId, userId), ne(storageAccount.status, "disconnected")));
    const values = { config: location.config, credentials: sealJson(credentials), status: "active" as const, lastError: null, lastErrorAt: null, verifiedAt: new Date() };
    const same = mine.find((a) => a.kind === location.kind && sameAccount(locationOf(a) as AccountLocation, location));
    if (same) {
      const [updated] = await tx
        .update(storageAccount)
        .set({ ...values, ...(label !== undefined && { label: cleanAccountLabel(label, same.label) }) })
        .where(eq(storageAccount.id, same.id))
        .returning();
      return updated;
    }
    const [made] = await tx
      .insert(storageAccount)
      .values({ userId, kind: location.kind, label: cleanAccountLabel(label, defaultAccountLabel(location)), isDefault: !mine.some((a) => a.isDefault), ...values })
      .returning();
    return made;
  });
}

/** Tries an S3-compatible bucket's settings without keeping them. */
export async function testS3Account(userId: string, input: S3StorageInput): Promise<void> {
  requireOwnStorage();
  const parsed = await readS3Input(userId, input);
  countTry(userId);
  await probeAccount(ACCOUNT_SCOPE, parsed.location, parsed.credentials);
}

/**
 * Connects an S3-compatible bucket to the person's account once a test object went there and back;
 * with `workspaceId`, that workspace (which they own) starts using it too.
 */
export async function connectS3Account(userId: string, input: S3StorageInput & { label?: unknown }, workspaceId?: string): Promise<StorageAccountRow> {
  requireOwnStorage();
  if (workspaceId) await requireMembership(userId, workspaceId, "owner");
  const parsed = await readS3Input(userId, input);
  countTry(userId);
  await probeAccount(ACCOUNT_SCOPE, parsed.location, parsed.credentials);
  const account = await saveAccount(userId, parsed.location, parsed.credentials, input.label);
  if (workspaceId) await attachAccount(userId, workspaceId, account.id);
  return account;
}

/** Tries a storage account again with its own settings: active again when it works. */
export async function retestAccount(userId: string, accountId: string): Promise<void> {
  let account = await ownAccount(userId, accountId);
  if (account.status === "disconnected") throw new StorageSettingsError("accountDisconnected");
  countTry(userId);
  try {
    try {
      account = await ensureDriveRoot(account);
      await probeStorage(accountDriver(account), ACCOUNT_SCOPE);
    } catch (error) {
      refusal(error);
    }
  } catch (error) {
    if (error instanceof StorageSettingsError && error.code === "refused") await markBroken(account.id, new Error(error.detail));
    throw error;
  }
  await db
    .update(storageAccount)
    .set({ status: "active", lastError: null, lastErrorAt: null, verifiedAt: new Date() })
    .where(and(eq(storageAccount.id, account.id), ne(storageAccount.status, "disconnected")));
}

export async function renameAccount(userId: string, accountId: string, label: unknown): Promise<void> {
  const account = await ownAccount(userId, accountId);
  await db
    .update(storageAccount)
    .set({ label: cleanAccountLabel(label, account.label) })
    .where(eq(storageAccount.id, account.id));
}

/** Makes the account the person's default (new workspaces they make use it), or none with `isDefault` false. */
export async function setDefaultAccount(userId: string, accountId: string, isDefault: boolean): Promise<void> {
  const account = await ownAccount(userId, accountId);
  if (isDefault && account.status === "disconnected") throw new StorageSettingsError("accountDisconnected");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:storage-account:${userId}`}))`);
    if (isDefault) await tx.update(storageAccount).set({ isDefault: false }).where(and(eq(storageAccount.userId, userId), ne(storageAccount.id, account.id)));
    await tx.update(storageAccount).set({ isDefault }).where(eq(storageAccount.id, account.id));
  });
}

/**
 * Disconnects a storage account: no workspace uploads there any more (they go back to the server's
 * storage) and none may start using it. The files it holds move to where each workspace's other
 * owners keep theirs, when there is somewhere they may go (see moves.ts); meanwhile, and for files
 * with nowhere to go, its credentials keep serving them until they are moved or deleted. Then it
 * is forgotten, with its credentials.
 */
export async function disconnectAccount(userId: string, accountId: string): Promise<void> {
  const account = await ownAccount(userId, accountId);
  const { planMovesAway, kickMoves } = await import("./moves");
  const detached = await db.transaction(async (tx) => {
    await tx.update(storageAccount).set({ status: "disconnected", isDefault: false }).where(eq(storageAccount.id, account.id));
    await planMovesAway(tx, { accountIds: [account.id], reason: "disconnected", actorId: userId, mode: "block" });
    return tx
      .update(workspaceStorage)
      .set({ status: "disconnected" })
      .where(and(eq(workspaceStorage.storageAccountId, account.id), ne(workspaceStorage.status, "disconnected")))
      .returning({ id: workspaceStorage.id, workspaceId: workspaceStorage.workspaceId });
  });
  for (const place of detached) {
    if (!place.workspaceId) continue;
    await recordAudit({
      workspaceId: place.workspaceId,
      actorId: userId,
      action: "storage.disconnected",
      target: { type: "storage", id: place.workspaceId, label: account.label },
    });
  }
  kickMoves();
  await removeRetiredStorage().catch((error) => console.warn("[storage] couldn't remove the disconnected storage", error));
}

// ---------------------------------------------------------------------- Drive and Dropbox

/** How long a sign-in begun may take. */
const OAUTH_STATE_MS = 15 * 60_000;

/** Where Drive and Dropbox send the browser back to (registered with the instance's apps). */
export const storageOAuthRedirectUrl = () => `${env.appUrl}/api/storage/oauth/callback`;

/**
 * Begins signing in to Drive or Dropbox to connect it to the person's account: the address to send
 * the browser to. With `workspaceId` (begun from a workspace's Settings > Storage, by an owner),
 * that workspace starts using it once connected.
 */
export async function beginStorageOAuth(userId: string, kind: unknown, workspaceId?: string | null): Promise<{ url: string }> {
  requireOwnStorage();
  if (workspaceId) await requireMembership(userId, workspaceId, "owner");
  if (!isOAuthStorageKind(kind)) throw new StorageSettingsError("unavailable");
  const app = env.storageOAuthApps[kind];
  if (!app) throw new StorageSettingsError("notConfigured");
  countTry(userId);
  await db.delete(storageOauth).where(lte(storageOauth.createdAt, new Date(Date.now() - OAUTH_STATE_MS)));
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkce();
  await db.insert(storageOauth).values({ state, userId, kind, workspaceId: workspaceId ?? null, data: sealJson({ verifier }) });
  return { url: authorizationUrl(kind, app, { state, challenge, redirectUri: storageOAuthRedirectUrl() }) };
}

/** Where a sign-in begun with `state` came from, for sending the browser back whatever became of it; null when unknown. */
export async function storageOAuthReturnOf(state: string): Promise<{ workspaceId: string | null } | null> {
  const [found] = await db.select({ workspaceId: storageOauth.workspaceId }).from(storageOauth).where(eq(storageOauth.state, state)).limit(1);
  return found ?? null;
}

/** The signed-in account, as its location: the Drive account with its Leafdesk folder, or the Dropbox account. */
async function accountLocationFor(kind: OAuthStorageKind, credentials: OAuthCredentials): Promise<{ location: AccountLocation; credentials: OAuthCredentials }> {
  const session = oauthSession(kind, env.storageOAuthApps[kind]!, credentials);
  if (kind === "dropbox") return { location: { kind, config: await dropboxAccount(session) }, credentials: session.credentials() };
  const account = await driveAccount(session);
  const root = await driveRootFolder(session);
  return { location: { kind, config: { ...account, rootFolderId: root.folderId } }, credentials: session.credentials() };
}

/**
 * The browser came back from Drive or Dropbox: finishes the sign-in begun with `state` by the same
 * person, tries the storage with a test object, and connects it to their account (see saveAccount);
 * and to the workspace it was begun from, when one was. Returns that workspace.
 */
export async function completeStorageOAuth(userId: string, input: { state: string; code: string }): Promise<{ workspaceId: string | null }> {
  const [pending] = await db.delete(storageOauth).where(eq(storageOauth.state, input.state)).returning();
  if (!pending || pending.userId !== userId || pending.createdAt.getTime() < Date.now() - OAUTH_STATE_MS || !isOAuthStorageKind(pending.kind)) {
    throw new StorageSettingsError("oauthFailed", "This sign-in expired or was begun by someone else; begin it again");
  }
  requireOwnStorage();
  const { workspaceId, kind } = pending;
  if (workspaceId) await requireMembership(userId, workspaceId, "owner");
  const app = env.storageOAuthApps[kind];
  if (!app) throw new StorageSettingsError("notConfigured");
  const { verifier } = openJson<{ verifier: string }>(pending.data);
  let found: Awaited<ReturnType<typeof accountLocationFor>>;
  try {
    const credentials = await exchangeCode(kind, app, { code: input.code, verifier, redirectUri: storageOAuthRedirectUrl() });
    found = await accountLocationFor(kind, credentials);
  } catch (error) {
    if (error instanceof StorageError) throw new StorageSettingsError("oauthFailed", error.message);
    throw error;
  }
  await probeAccount(ACCOUNT_SCOPE, found.location, found.credentials);
  const account = await saveAccount(userId, found.location, found.credentials);
  if (workspaceId) await attachAccount(userId, workspaceId, account.id);
  return { workspaceId };
}

// ---------------------------------------------------------------------- Workspaces' places

/** A Drive account connected before it had a Leafdesk folder gets one (kept on the account). */
async function ensureDriveRoot(account: StorageAccountRow): Promise<StorageAccountRow> {
  if (account.kind !== "gdrive" || (account.config as { rootFolderId?: string | null }).rootFolderId) return account;
  const app = env.storageOAuthApps.gdrive;
  if (!app) throw new StorageError("This server has no Google Drive app set up any more");
  const session = oauthSession("gdrive", app, openJson<OAuthCredentials>(account.credentials), persistOn(account.id, account.credentials));
  const root = await driveRootFolder(session);
  const config = { ...account.config, rootFolderId: root.folderId };
  const [updated] = await db.update(storageAccount).set({ config }).where(eq(storageAccount.id, account.id)).returning();
  return updated ?? { ...account, config };
}

/**
 * The workspace's place in the account: its own Drive folder (made in the account's Leafdesk
 * folder, or found again), nothing more for a bucket or a Dropbox. Reaches out to Drive.
 */
export async function placeFor(account: StorageAccountRow, workspaceId: string): Promise<{ account: StorageAccountRow; place: PlaceConfig }> {
  if (account.kind !== "gdrive") return { account, place: {} };
  const rooted = await ensureDriveRoot(account);
  const app = env.storageOAuthApps.gdrive!;
  const session = oauthSession("gdrive", app, openJson<OAuthCredentials>(rooted.credentials), persistOn(rooted.id, rooted.credentials));
  const [named] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const root = (rooted.config as { rootFolderId?: string | null }).rootFolderId;
  const folder = await driveFolder(session, workspaceId, `Leafdesk (${(named?.name ?? workspaceId).slice(0, 80)})`, {}, root);
  return { account: rooted, place: folder };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Makes `place` in `account` where the workspace's new uploads go, inside the caller's transaction
 * (which holds the workspace's storage lock, see lockWorkspaceStorage): the same place again is kept
 * (made current again when it was retired), another one takes over from the current one, which
 * keeps serving the files it holds. Returns the place's id and the one it replaced.
 */
export async function makeCurrent(tx: Tx, input: { workspaceId: string; account: StorageAccountRow; place: PlaceConfig; userId: string | null }) {
  const { workspaceId, account, place } = input;
  const [current] = await loadTargets(and(eq(workspaceStorage.workspaceId, workspaceId), ne(workspaceStorage.status, "disconnected")), tx);
  const samePlace = (config: PlaceConfig) => (config.folderId ?? null) === (place.folderId ?? null);
  if (current && current.storageAccountId === account.id && samePlace(current.config)) return { id: current.id, replaced: null };
  if (current) await tx.update(workspaceStorage).set({ status: "disconnected" }).where(eq(workspaceStorage.id, current.id));
  const earlier = (
    await tx
      .select()
      .from(workspaceStorage)
      .where(and(eq(workspaceStorage.workspaceId, workspaceId), eq(workspaceStorage.storageAccountId, account.id)))
  ).find((p) => samePlace(p.config));
  if (earlier) {
    await tx.update(workspaceStorage).set({ status: "active", config: place }).where(eq(workspaceStorage.id, earlier.id));
    return { id: earlier.id, replaced: current?.id ?? null };
  }
  const [made] = await tx
    .insert(workspaceStorage)
    .values({ workspaceId, storageAccountId: account.id, kind: account.kind, config: place, createdBy: input.userId })
    .returning({ id: workspaceStorage.id });
  return { id: made.id, replaced: current?.id ?? null };
}

/** Holds off other changes to where the workspace's uploads go until the transaction ends. */
export async function lockWorkspaceStorage(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:workspace-storage:${workspaceId}`}))`);
}

/**
 * The workspace (which the person owns) starts keeping its new uploads in their storage account,
 * in a place of its own there, after a test object went there and back. Files already stored stay
 * where they are (an owner can move them, see moves.ts). Refused while its files are being moved.
 */
export async function attachAccount(userId: string, workspaceId: string, accountId: string, { probe = true }: { probe?: boolean } = {}): Promise<void> {
  requireOwnStorage();
  await requireMembership(userId, workspaceId, "owner");
  const account = await ownAccount(userId, accountId);
  if (account.status === "disconnected") throw new StorageSettingsError("accountDisconnected");
  await refuseDuringMove(workspaceId);
  let made: Awaited<ReturnType<typeof placeFor>>;
  try {
    made = await placeFor(account, workspaceId);
  } catch (error) {
    refusal(error);
  }
  if (probe) {
    countTry(userId);
    await probeAccount(workspaceId, locationOf(made.account, made.place), openJson<StorageCredentials>(made.account.credentials), persistOn(made.account.id, made.account.credentials));
  }
  const { replaced } = await db.transaction(async (tx) => {
    await lockWorkspaceStorage(tx, workspaceId);
    await refuseDuringMove(workspaceId, tx);
    return makeCurrent(tx, { workspaceId, account: made.account, place: made.place, userId });
  });
  if (replaced) await removeRetiredStorage(replaced).catch((error) => console.warn("[storage] couldn't remove the replaced storage", error));
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.connected",
    target: { type: "storage", id: workspaceId, label: auditLabel(locationOf(made.account, made.place)) },
  });
}

/** `moveInProgress` while the workspace's files are being moved. */
export async function refuseDuringMove(workspaceId: string, reader: Pick<typeof db, "select"> = db) {
  const [open] = await reader
    .select({ id: storageMove.id })
    .from(storageMove)
    .where(and(eq(storageMove.workspaceId, workspaceId), inArray(storageMove.status, ["queued", "running"])))
    .limit(1);
  if (open) throw new StorageSettingsError("moveInProgress");
}

/**
 * A workspace someone just made (or restored) uses their default storage account from the start,
 * when own storage is on and they have one that works. Never fails the workspace: a storage that
 * can't be reached leaves it on the server's storage, said in the log.
 */
export async function attachDefaultStorage(userId: string, workspaceId: string): Promise<void> {
  if (!env.ownStorageEnabled) return;
  try {
    const [account] = await db
      .select()
      .from(storageAccount)
      .where(and(eq(storageAccount.userId, userId), eq(storageAccount.isDefault, true), eq(storageAccount.status, "active")))
      .limit(1);
    if (!account) return;
    if (await currentTarget(workspaceId)) return;
    await attachAccount(userId, workspaceId, account.id, { probe: false });
  } catch (error) {
    console.warn(`[storage] workspace ${workspaceId} stays on the server's storage: its creator's default storage didn't take it`, error instanceof Error ? error.message : error);
  }
}
