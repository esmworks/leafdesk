/**
 * End-to-end check of workspaces keeping their files in their owners' own storage, against the
 * database and a real S3-compatible server (MinIO, say).
 *
 * - With OWN_STORAGE_ENABLED off nothing new can be connected or attached and no storage kind is
 *   offered, while a workspace connected before keeps storing and serving its files.
 * - Turned on, S3 is offered and Drive and Dropbox only once the server has their apps (named to
 *   instance admins). Private addresses and wrong keys are refused.
 * - A bucket connected once to one's account serves two workspaces, each under its own folder,
 *   and is used by a new workspace from the start; only its owner can attach it.
 * - A storage that refuses is broken, and recovers.
 * - When its owner leaves, the files move: never onto the server's disk (leaving is refused), onto
 *   the server's S3 storage when they fit its quota, or to another owner's default storage. Every
 *   file arrives whole, the old copies are deleted only once all are across, and a move that
 *   couldn't copy a file holds them and can be tried again. Someone removed leaves a blocked move
 *   owners can try again once there is somewhere to go.
 * - Disconnecting a storage account, and deleting one's Leafdesk account, move the files too
 *   (deleting is refused while they have nowhere to go).
 *
 *   pnpm tsx scripts/workspace-storage-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present; migrations applied), and the S3 server:
 * STORAGE_E2E_ENDPOINT (default http://127.0.0.1:9100), STORAGE_E2E_ACCESS_KEY,
 * STORAGE_E2E_SECRET_KEY, and two buckets STORAGE_E2E_BUCKET (default ws-files) and
 * STORAGE_E2E_OTHER_BUCKET (default other-files). For example:
 *
 *   docker run -d -p 127.0.0.1:9100:9000 -e MINIO_ROOT_USER=… -e MINIO_ROOT_PASSWORD=… <minio image> server /data
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

export {};

try {
  process.loadEnvFile();
} catch {}

const endpoint = process.env.STORAGE_E2E_ENDPOINT ?? "http://127.0.0.1:9100";
const accessKeyId = process.env.STORAGE_E2E_ACCESS_KEY ?? "";
const secretAccessKey = process.env.STORAGE_E2E_SECRET_KEY ?? "";
const bucket = process.env.STORAGE_E2E_BUCKET ?? "ws-files";
const otherBucket = process.env.STORAGE_E2E_OTHER_BUCKET ?? "other-files";
if (!accessKeyId || !secretAccessKey) throw new Error("Set STORAGE_E2E_ACCESS_KEY and STORAGE_E2E_SECRET_KEY");
const endpointHost = new URL(endpoint).host;

// The instance's own storage: a scratch directory to begin with (later the other bucket), with a small quota.
const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-workspace-storage-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_MAX_FILE_MB = String(25_000 / 1024 / 1024);
process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(30_000 / 1024 / 1024);
delete process.env.STORAGE_ALLOWED_HOSTS;
delete process.env.OWN_STORAGE_ENABLED;
for (const name of ["STORAGE_GDRIVE_CLIENT_ID", "STORAGE_GDRIVE_CLIENT_SECRET", "STORAGE_DROPBOX_CLIENT_ID", "STORAGE_DROPBOX_CLIENT_SECRET"]) delete process.env[name];

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNotNull, notInArray, or, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const schema = await import("@/db/schema");
const { auditEvent, file, session, storageAccount, storageDeletion, storageMove, user, workspace, workspaceMember, workspaceStorage } = schema;
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { AccessError } = await import("@/server/access");
const { AccountError, deleteAccount, deletionPlanFor } = await import("@/server/account");
const { createPersonalWorkspace, removeMember, WorkspaceError } = await import("@/server/workspaces");
const files = await import("@/server/files");
const { sealJson } = await import("@/server/secret-box");
const { setStorage } = await import("@/server/storage/index");
const { s3Driver } = await import("@/server/storage/s3");
const { currentTarget, removeRetiredStorage } = await import("@/server/storage/workspace");
const accounts = await import("@/server/storage/accounts");
const moves = await import("@/server/storage/moves");
const settings = await import("@/server/storage/settings");
const { deleteWorkspace } = await import("@/server/workspace-deletion");
const fileRoute = await import("@/app/api/files/[id]/route");

const RUN = `workspace-storage-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function eventually(condition: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(false, `${what} (timed out)`);
}

/** The error code a call fails with, or null when it works. */
async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError) return "access";
    if (error instanceof files.FileError) return error.code;
    if (error instanceof settings.StorageSettingsError) return error.detail ? `${error.code}: ${error.detail}` : error.code;
    if (error instanceof WorkspaceError) return error.code;
    if (error instanceof AccountError) return error.workspaces.length ? `${error.code}: ${error.workspaces.join(", ")}` : error.code;
    throw error;
  }
}

const own = (on: boolean) => {
  if (on) process.env.OWN_STORAGE_ENABLED = "true";
  else delete process.env.OWN_STORAGE_ENABLED;
};
const quotaBytes = (n: number) => {
  process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(n / 1024 / 1024);
};

/** The buckets as the S3 server has them, read without Leafdesk's guard. */
const raw = (name: string, prefix?: string) => s3Driver({ bucket: name, prefix, endpoint, region: "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: true });
const inBucket = async (name: string, key: string) => {
  const body = await raw(name).get(key);
  return body ? Buffer.from(await new Response(body).arrayBuffer()) : null;
};
const onDisk = async (key: string) => {
  const [ws, id] = key.split("/");
  return (await readdir(join(uploadDir, ws)).catch(() => [] as string[])).includes(id);
};

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const upload = (userId: string, pageId: string, name: string, body: Buffer) =>
  files.uploadFile(userId, pageId, { name, contentType: "application/octet-stream", body: Readable.from([body]), declaredSize: body.length });
const fileRow = async (id: string) => (await db.select().from(file).where(eq(file.id, id)))[0] ?? null;
const accountOf = async (id: string) => (await db.select().from(storageAccount).where(eq(storageAccount.id, id)))[0] ?? null;
const placeOf = async (id: string | null) => (id ? ((await db.select().from(workspaceStorage).where(eq(workspaceStorage.id, id)))[0] ?? null) : null);
const movesOf = (workspaceId: string) => db.select().from(storageMove).where(eq(storageMove.workspaceId, workspaceId)).orderBy(storageMove.createdAt);
const lastMove = async (workspaceId: string) => (await movesOf(workspaceId)).at(-1) ?? null;
const s3Input = (over: Record<string, unknown> = {}) => ({ endpoint, region: "us-east-1", bucket, prefix: "leafdesk", accessKeyId, secretAccessKey, forcePathStyle: true, ...over });

/** Runs the moves queued, then the deletions they let go and the storage nothing needs any more. */
async function settle() {
  moves.kickMoves();
  await moves.settleMoves();
  await files.drainStorageDeletions();
  await removeRetiredStorage();
}

const ids = { lea: `${RUN}-lea`, oli: `${RUN}-oli`, mem: `${RUN}-mem`, del: `${RUN}-del` };
const ws = { shared: `${RUN}-shared`, solo: `${RUN}-solo`, team: `${RUN}-team`, gone: `${RUN}-gone` };
const made: string[] = [];

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: ws.shared, name: "Shared" },
    { id: ws.solo, name: "Solo" },
    { id: ws.team, name: "Team" },
    { id: ws.gone, name: "Gone" },
  ]);
  // The longest-standing owner comes first when files look for somewhere to go.
  const at = (minutes: number) => new Date(Date.now() - (100 - minutes) * 60_000);
  await db.insert(workspaceMember).values([
    { workspaceId: ws.shared, userId: ids.lea, role: "owner", createdAt: at(0) },
    { workspaceId: ws.shared, userId: ids.oli, role: "owner", createdAt: at(1) },
    { workspaceId: ws.shared, userId: ids.mem, role: "member", createdAt: at(2) },
    { workspaceId: ws.solo, userId: ids.lea, role: "owner", createdAt: at(0) },
    { workspaceId: ws.team, userId: ids.lea, role: "owner", createdAt: at(0) },
    { workspaceId: ws.team, userId: ids.oli, role: "owner", createdAt: at(1) },
    { workspaceId: ws.gone, userId: ids.del, role: "owner", createdAt: at(0) },
    { workspaceId: ws.gone, userId: ids.oli, role: "owner", createdAt: at(1) },
  ]);
  const cookieFor = async (userId: string) => {
    const token = randomBytes(24).toString("hex");
    await db.insert(session).values({ id: `${userId}-session`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
    return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
  };
  const cookies = { lea: await cookieFor(ids.lea), oli: await cookieFor(ids.oli) };
  const getFile = (as: keyof typeof cookies, id: string, headers: Record<string, string> = {}) =>
    fileRoute.GET(new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie: cookies[as], ...headers } }), { params: Promise.resolve({ id }) });
  const served = async (as: keyof typeof cookies, id: string, body: Buffer) => {
    const response = await getFile(as, id);
    return response.status === 200 && Buffer.from(await response.arrayBuffer()).equals(body);
  };

  const docs = {
    shared: await createPage({ userId: ids.lea }, { workspaceId: ws.shared, title: "Doc" }),
    solo: await createPage({ userId: ids.lea }, { workspaceId: ws.solo, title: "Doc" }),
    team: await createPage({ userId: ids.lea }, { workspaceId: ws.team, title: "Doc" }),
    gone: await createPage({ userId: ids.del }, { workspaceId: ws.gone, title: "Doc" }),
  };

  // ------------------------------------------------------------------ Own storage off
  check((await failure(() => accounts.connectS3Account(ids.lea, s3Input(), ws.shared))) === "disabled", "with own storage off, nothing can be connected");
  check((await failure(() => accounts.testS3Account(ids.lea, s3Input()))) === "disabled", "…or tried");
  const off = await accounts.getStorageAccounts(ids.lea, { isAdmin: true });
  check(!off.ownStorage && off.kinds.length === 0 && off.unconfigured.length === 0 && off.accounts.length === 0, "…no kind is offered, and no admin note shown", off);
  check(!(await settings.getStorageSettings(ids.lea, ws.shared)).ownStorage, "…and Settings > Storage knows it is off");

  // ------------------------------------------------------------------ Own storage on: what is offered
  own(true);
  const offered = await accounts.getStorageAccounts(ids.lea);
  check(offered.ownStorage && offered.kinds.join() === "s3", "turned on, S3 is offered, Drive and Dropbox only once the server has their apps", offered.kinds);
  check(offered.unconfigured.length === 0, "…without naming their settings to someone who isn't an admin");
  check((await accounts.getStorageAccounts(ids.lea, { isAdmin: true })).unconfigured.join() === "gdrive,dropbox", "…while an admin is told what to set");
  process.env.STORAGE_DROPBOX_CLIENT_ID = "e2e-app";
  process.env.STORAGE_DROPBOX_CLIENT_SECRET = "e2e-secret";
  check((await accounts.getStorageAccounts(ids.lea)).kinds.join() === "s3,dropbox", "with a Dropbox app set up, Dropbox is offered too");
  delete process.env.STORAGE_DROPBOX_CLIENT_ID;
  delete process.env.STORAGE_DROPBOX_CLIENT_SECRET;
  check((await failure(() => accounts.beginStorageOAuth(ids.lea, "gdrive"))) === "notConfigured", "signing in to Drive without its app is refused");

  // ------------------------------------------------------------------ Connecting once, to one's account
  const plainHttp = await failure(() => accounts.connectS3Account(ids.lea, s3Input()));
  check(plainHttp?.startsWith("refused") && /https/.test(plainHttp), "a plain http endpoint is refused", plainHttp);
  const metadata = await failure(() => accounts.testS3Account(ids.lea, s3Input({ endpoint: "https://169.254.169.254" })));
  check(metadata?.startsWith("refused") && /private address/.test(metadata), "the cloud metadata address is refused", metadata);
  process.env.STORAGE_ALLOWED_HOSTS = endpointHost;
  check((await failure(() => accounts.connectS3Account(ids.mem, s3Input(), ws.shared))) === "access", "a member can't connect storage for the workspace");
  const wrongKey = await failure(() => accounts.connectS3Account(ids.lea, s3Input({ secretAccessKey: "not-the-secret" })));
  check(wrongKey?.startsWith("refused: S3 PUT failed: 403"), "wrong keys are refused with what the storage said", wrongKey);
  check((await db.select().from(storageAccount).where(eq(storageAccount.userId, ids.lea))).length === 0, "…and nothing is kept");

  const leas = await accounts.connectS3Account(ids.lea, s3Input({ label: "Lea's bucket" }), ws.shared);
  made.push(leas.id);
  check(leas.isDefault && leas.label === "Lea's bucket" && leas.status === "active", "an owner connects a bucket to their account, as their default", leas);
  check(leas.credentials.startsWith("sb1.") && !leas.credentials.includes(secretAccessKey), "its keys are stored sealed");
  const sharedPlace = await currentTarget(ws.shared);
  check(sharedPlace?.storageAccountId === leas.id, "the workspace it was connected from uses it");
  const view = await settings.getStorageSettings(ids.oli, ws.shared);
  check(view.current?.accountId === leas.id && !view.current.mine && view.current.ownerName === ids.lea, "another owner sees whose storage it is", view.current);
  check(!JSON.stringify(view).includes(secretAccessKey) && !JSON.stringify(await accounts.getStorageAccounts(ids.lea)).includes(secretAccessKey), "the settings never show the keys");
  check(
    (await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, ws.shared), eq(auditEvent.action, "storage.connected")))).length === 1,
    "connecting is in the workspace's audit log",
  );
  check((await failure(() => accounts.attachAccount(ids.oli, ws.shared, leas.id))) === "noAccount", "only its owner can attach a storage account to a workspace");
  check((await failure(() => accounts.attachAccount(ids.mem, ws.solo, leas.id))) === "access", "…and only to a workspace they own");

  // One bucket, two workspaces, each in its own folder.
  await accounts.attachAccount(ids.lea, ws.solo, leas.id);
  const big = bytes(20_000, 3);
  const s1 = await upload(ids.lea, docs.shared.id, "s1.bin", big);
  const s2 = await upload(ids.oli, docs.shared.id, "s2.bin", bytes(20_000, 5));
  const o1 = await upload(ids.lea, docs.solo.id, "o1.bin", bytes(700, 7));
  const [s1Row, o1Row] = [(await fileRow(s1.id))!, (await fileRow(o1.id))!];
  check(s1Row.storageId === sharedPlace!.id && o1Row.storageId !== s1Row.storageId && (await placeOf(o1Row.storageId))?.storageAccountId === leas.id, "one account serves two workspaces, each through its own place");
  check(s1Row.storageKey.startsWith(`${ws.shared}/`) && o1Row.storageKey.startsWith(`${ws.solo}/`), "…their files under each workspace's own folder");
  check((await inBucket(bucket, `leafdesk/${s1Row.storageKey}`))?.equals(big) && Boolean(await inBucket(bucket, `leafdesk/${o1Row.storageKey}`)), "…in the one bucket");
  check(!(await onDisk(s1Row.storageKey)), "…and not on this server");
  check((await files.workspaceUsage(ws.shared)) === 0 && (await fileRow(s2.id))?.storageId === sharedPlace!.id, "past the server's quota, own storage takes more, counting against nothing");
  const listed = (await accounts.listStorageAccounts(ids.lea))[0];
  check(listed.workspaces.map((w) => w.name).sort().join() === "Shared,Solo", "the account lists the workspaces using it", listed.workspaces);

  // A new workspace uses its maker's default storage from the start.
  await createPersonalWorkspace(ids.lea, "Lea");
  const [personal] = await db
    .select({ id: workspaceMember.workspaceId })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.userId, ids.lea), notInArray(workspaceMember.workspaceId, Object.values(ws))));
  check((await currentTarget(personal.id))?.storageAccountId === leas.id, "a new workspace uses its maker's default storage");
  await db.delete(workspace).where(eq(workspace.id, personal.id));

  // Reading, through the files route, whole and in ranges.
  check(await served("oli", s1.id, big), "another owner reads the file from the bucket");
  const part = await getFile("oli", s1.id, { range: "bytes=100-199" });
  check(part.status === 206 && Buffer.from(await part.arrayBuffer()).equals(big.subarray(100, 200)), "…and in byte ranges");

  // A storage that refuses is broken, says why, and recovers.
  await db.update(storageAccount).set({ credentials: sealJson({ accessKeyId, secretAccessKey: "revoked" }) }).where(eq(storageAccount.id, leas.id));
  check((await getFile("oli", s1.id)).status === 502, "a file whose storage refuses answers 502");
  const broken = await accountOf(leas.id);
  check(broken?.status === "broken" && /403/.test(broken.lastError ?? ""), "the storage account is marked broken, with what it said", broken);
  check((await failure(() => upload(ids.lea, docs.shared.id, "lost.bin", bytes(10)))) === "storageFailed", "an upload to it fails rather than land on the server");
  check((await settings.getStorageSettings(ids.oli, ws.shared)).current?.status === "broken", "owners see it broken in Settings > Storage");
  await db.update(storageAccount).set({ credentials: leas.credentials }).where(eq(storageAccount.id, leas.id));
  await settings.retestStorage(ids.oli, ws.shared);
  check((await accountOf(leas.id))?.status === "active" && (await served("oli", s1.id, big)), "tested again with working keys, it is active and serves again");

  // ------------------------------------------------------------------ Own storage off again: what was connected keeps working
  own(false);
  const s3 = await upload(ids.lea, docs.shared.id, "s3.bin", bytes(900, 9));
  check((await fileRow(s3.id))?.storageId === sharedPlace!.id && (await served("oli", s3.id, bytes(900, 9))), "turned off, a workspace connected before keeps storing and serving there");
  check((await failure(() => accounts.attachAccount(ids.lea, ws.team, leas.id))) === "disabled", "…but no workspace can start using it");
  check((await moves.countOwnStorageWorkspaces()) >= 2, "the server counts the workspaces still in own storage, for its startup line");
  own(true);

  // ------------------------------------------------------------------ Leaving, with nowhere for the files to go
  const sharedFiles = { [s1.id]: big, [s2.id]: bytes(20_000, 5), [s3.id]: bytes(900, 9) };
  check((await failure(() => removeMember(ids.lea, ws.shared, ids.lea))) === "storageNoDestination", "leaving is refused while the files have nowhere to go");
  check((await movesOf(ws.shared)).length === 0, "…and nothing is queued");
  check((await failure(() => moves.startManualMove(ids.oli, ws.shared, { server: true }))) === "serverRefused", "the server's disk never takes a workspace's files, however much room it has");
  check(!(await moves.moveDestinations(ids.oli, ws.shared)).some((d) => d.kind === "server"), "…and isn't offered as somewhere to move them");
  const plan = await deletionPlanFor(ids.lea);
  check(plan.storageStuck?.some((w) => w.name === "Shared"), "deleting the account would leave files stuck, and says where", plan.storageStuck);

  // Someone removed: the move is blocked, owners see it, the files are still read from their storage.
  await accounts.attachAccount(ids.lea, ws.team, leas.id);
  const t1 = await upload(ids.lea, docs.team.id, "t1.bin", bytes(5_000, 11));
  const t2 = await upload(ids.lea, docs.team.id, "t2.bin", bytes(5_000, 13));
  const t3 = await upload(ids.lea, docs.team.id, "t3.bin", bytes(5_000, 15));
  await removeMember(ids.oli, ws.team, ids.lea);
  const blocked = await lastMove(ws.team);
  check(blocked?.status === "blocked" && blocked.reason === "removed" && blocked.files === 3, "removing them goes ahead, with a blocked move", blocked);
  const shown = await settings.getStorageSettings(ids.oli, ws.team);
  check(shown.move?.status === "blocked" && shown.current?.accountId === leas.id, "owners see it in Settings > Storage", shown.move);
  check(((await files.readStored((await fileRow(t1.id))!)) as Buffer | null)?.equals(bytes(5_000, 11)), "…and the files are still read from the storage of the person removed");
  check((await failure(() => moves.retryMove(ids.oli, ws.team, blocked.id))) === "noDestination: Team", "trying it again while there is still nowhere says so");

  // ------------------------------------------------------------------ The server's S3 storage, when the files fit
  const instanceS3 = raw(otherBucket, "instance");
  setStorage(instanceS3);
  check((await failure(() => removeMember(ids.lea, ws.shared, ids.lea))) === "storageNoDestination", "the server's S3 storage doesn't take files past the workspace's quota");
  quotaBytes(100_000);
  check((await moves.moveDestinations(ids.oli, ws.shared)).some((d) => d.kind === "server"), "once they fit, owners may move them there");
  await removeMember(ids.lea, ws.shared, ids.lea);
  const toServer = (await lastMove(ws.shared))!;
  check(toServer.toServer && toServer.reason === "left" && toServer.status === "queued", "leaving queues a move to the server's S3 storage", toServer);
  check((await currentTarget(ws.shared))?.storageAccountId === leas.id, "…the leaver's storage serving meanwhile");
  await settle();
  check((await lastMove(ws.shared))?.status === "done", "the move finishes", await lastMove(ws.shared));
  for (const [id, body] of Object.entries(sharedFiles)) {
    const row = (await fileRow(id))!;
    check(row.storageId === null && (await inBucket(otherBucket, `instance/${row.storageKey}`))?.equals(body), `${row.name} is in the server's storage, whole`);
    check(await served("oli", id, body), `…and served from there`);
    check(!(await inBucket(bucket, `leafdesk/${row.storageKey}`)), "…its old copy deleted");
  }
  check(!(await onDisk(s1Row.storageKey)), "nothing landed on this server's disk");
  check((await currentTarget(ws.shared)) === null, "new uploads go to the server's storage");
  check((await db.select().from(workspaceStorage).where(eq(workspaceStorage.workspaceId, ws.shared))).length === 0, "the workspace's place in the leaver's storage is forgotten");

  // ------------------------------------------------------------------ Another owner's storage
  const olis = await accounts.connectS3Account(ids.oli, s3Input({ bucket: otherBucket, prefix: "", label: "Oli" }));
  made.push(olis.id);
  check(olis.isDefault, "another owner connects storage of their own, as their default");
  // One file is gone from the storage: it can't be copied, and the move holds the old copies.
  const t3Row = (await fileRow(t3.id))!;
  await raw(bucket, "leafdesk").delete({ key: t3Row.storageKey });
  await moves.retryMove(ids.oli, ws.team, blocked.id);
  await settle();
  const partly = (await lastMove(ws.team))!;
  check(partly.status === "failed" && partly.toAccountId === olis.id && partly.moved === 2 && partly.failed === 1 && /t3\.bin/.test(partly.lastError ?? ""), "a move that can't copy a file fails, saying which", partly);
  const held = await db.select().from(storageDeletion).where(eq(storageDeletion.moveId, partly.id));
  check(held.length === 2, "…the old copies of the files it moved held for now", held);
  check(Boolean(await inBucket(bucket, `leafdesk/${(await db.select().from(file).where(eq(file.id, t1.id)))[0].storageKey}`)), "…and still in the old storage");
  await db.delete(file).where(eq(file.id, t3.id));
  await moves.retryMove(ids.oli, ws.team, partly.id);
  await settle();
  const across = (await lastMove(ws.team))!;
  check(across.status === "done", "tried again, it finishes", across);
  const olisPlace = await currentTarget(ws.team);
  check(olisPlace?.storageAccountId === olis.id, "the workspace now uploads to the other owner's storage");
  for (const [id, body] of [[t1.id, bytes(5_000, 11)], [t2.id, bytes(5_000, 13)]] as const) {
    const row = (await fileRow(id))!;
    check(row.storageId === olisPlace!.id && (await inBucket(otherBucket, row.storageKey))?.equals(body), `${row.name} is in the other owner's storage, whole`);
    check(await served("oli", id, body), "…and served from there");
    check(!(await inBucket(bucket, `leafdesk/${row.storageKey}`)), "…its old copy deleted once every file was across");
  }
  check((await db.select().from(storageDeletion).where(eq(storageDeletion.moveId, across.id))).length === 0, "no deletion is held any more");

  // ------------------------------------------------------------------ Disconnecting a storage account
  const disconnectView = (await accounts.listStorageAccounts(ids.lea)).find((a) => a.id === leas.id);
  check(disconnectView?.workspaces.map((w) => w.name).join() === "Solo", "before disconnecting, the account names the workspaces still using it", disconnectView?.workspaces);
  await accounts.disconnectAccount(ids.lea, leas.id);
  const away = (await lastMove(ws.solo))!;
  check(away.reason === "disconnected" && away.toServer, "disconnecting moves the files to where they may go", away);
  check((await currentTarget(ws.solo)) === null, "…and no workspace uploads there any more");
  await settle();
  check((await lastMove(ws.solo))?.status === "done" && (await fileRow(o1.id))?.storageId === null, "the files are moved");
  check((await accountOf(leas.id)) === null, "then the account is forgotten, keys and all");

  // ------------------------------------------------------------------ Deleting one's Leafdesk account
  setStorage(null);
  const dels = await accounts.connectS3Account(ids.del, s3Input({ prefix: "deleted" }), ws.gone);
  made.push(dels.id);
  const g1 = await upload(ids.del, docs.gone.id, "g1.bin", bytes(3_000, 17));
  await accounts.setDefaultAccount(ids.oli, olis.id, false);
  const current = { user: { id: ids.del, name: ids.del, email: `${ids.del}@example.test` }, session: { id: `${ids.del}-session`, createdAt: new Date() } };
  check(
    (await failure(() => deleteAccount(current, { confirmation: current.user.email, proof: {} }))) === "storageStuck: Gone",
    "deleting one's account is refused while a workspace's files would have nowhere to go",
  );
  await accounts.setDefaultAccount(ids.oli, olis.id, true);
  check((await deletionPlanFor(ids.del)).storageMoves?.map((w) => w.name).join() === "Gone", "with somewhere to go, the deletion says the files will move");
  await deleteAccount(current, { confirmation: current.user.email, proof: {} });
  const afterDeletion = (await lastMove(ws.gone))!;
  check(afterDeletion?.reason === "accountDeleted" && afterDeletion.toAccountId === olis.id, "deleting the account queues the move, which outlives them", afterDeletion);
  await settle();
  const g1Row = (await fileRow(g1.id))!;
  check((await lastMove(ws.gone))?.status === "done" && (await inBucket(otherBucket, g1Row.storageKey))?.equals(bytes(3_000, 17)), "their files reach the other owner's storage, whole");
  check(await served("oli", g1.id, bytes(3_000, 17)), "…and are served from there");
  check((await accountOf(dels.id)) === null, "then their storage account is forgotten");

  // ------------------------------------------------------------------ Deleting a workspace
  const teamKeys = (await db.select().from(file).where(eq(file.workspaceId, ws.team))).map((f) => f.storageKey);
  check(teamKeys.length === 2, "the workspace has two files in the other owner's storage");
  await deleteWorkspace(
    { user: { id: ids.oli, name: ids.oli, email: `${ids.oli}@example.test` }, session: { id: `${ids.oli}-session`, createdAt: new Date() } },
    ws.team,
    { confirmation: "Team", proof: {} },
  );
  // The deletion from storage runs in the background.
  await eventually(async () => (await db.select().from(storageDeletion).where(eq(storageDeletion.storageId, olisPlace!.id))).length === 0, "the queued deletions");
  for (const key of teamKeys) check(!(await inBucket(otherBucket, key)), "deleting the workspace deletes its files from the storage");
  await removeRetiredStorage();
  check((await placeOf(olisPlace!.id)) === null, "…and forgets its place there");
  check((await accountOf(olis.id))?.status === "active", "…while the storage account stays its owner's");

  console.log(`\n${passed} checks passed`);
} finally {
  setStorage(null);
  const wsIds = Object.values(ws);
  const places = await db
    .select({ id: workspaceStorage.id })
    .from(workspaceStorage)
    .where(or(inArray(workspaceStorage.workspaceId, wsIds), made.length ? inArray(workspaceStorage.storageAccountId, made) : undefined));
  const placeIds = places.map((p) => p.id);
  await db.delete(file).where(inArray(file.workspaceId, wsIds));
  if (placeIds.length) await db.delete(storageDeletion).where(inArray(storageDeletion.storageId, placeIds));
  await db.delete(storageDeletion).where(sql`${storageDeletion.storageKey} like ${`${RUN}-%`}`);
  await db.delete(workspace).where(inArray(workspace.id, wsIds));
  if (placeIds.length) await db.delete(workspaceStorage).where(inArray(workspaceStorage.id, placeIds));
  if (made.length) await db.delete(storageAccount).where(inArray(storageAccount.id, made));
  await db.delete(storageAccount).where(and(isNotNull(storageAccount.userId), inArray(storageAccount.userId, Object.values(ids))));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
