/**
 * End-to-end check of a workspace bringing its own S3-compatible storage, against the database and
 * a real S3-compatible server (MinIO, say): an owner connects a bucket after a test file went there
 * and back; that workspace's uploads go there, are read (whole and in ranges) and deleted there,
 * and count against no quota, while another workspace keeps the instance's storage and its quota;
 * a storage that refuses shows up as broken and recovers; disconnecting or switching buckets
 * leaves files readable where they are; deleting the workspace deletes its files from the bucket
 * and then forgets the bucket. A private or loopback endpoint is refused unless it is on
 * STORAGE_ALLOWED_HOSTS.
 *
 *   pnpm tsx scripts/workspace-storage-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present; migrations applied), and the S3 server:
 * STORAGE_E2E_ENDPOINT (default http://127.0.0.1:9100), STORAGE_E2E_ACCESS_KEY,
 * STORAGE_E2E_SECRET_KEY, and two empty buckets STORAGE_E2E_BUCKET (default ws-files) and
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

// The instance's own storage: a scratch directory, with a small quota.
const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-workspace-storage-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_MAX_FILE_MB = String(25_000 / 1024 / 1024);
process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(30_000 / 1024 / 1024);
delete process.env.STORAGE_ALLOWED_HOSTS;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, file, session, storageDeletion, user, workspace, workspaceMember, workspaceStorage } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { AccessError } = await import("@/server/access");
const files = await import("@/server/files");
const { sealJson } = await import("@/server/secret-box");
const { s3Driver } = await import("@/server/storage/s3");
const { removeRetiredStorage } = await import("@/server/storage/workspace");
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
    throw error;
  }
}

/** The buckets as the S3 server has them, read without Leafdesk's guard. */
const raw = (name: string) => s3Driver({ bucket: name, endpoint, region: "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: true });
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
const targetsOf = (workspaceId: string) => db.select().from(workspaceStorage).where(eq(workspaceStorage.workspaceId, workspaceId));
const s3Input = (over: Record<string, unknown> = {}) => ({ endpoint, region: "us-east-1", bucket, prefix: "leafdesk", accessKeyId, secretAccessKey, forcePathStyle: true, ...over });

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, other: `${RUN}-other` };
const own = `${RUN}-own`;
const plain = `${RUN}-plain`;
const created: string[] = [];

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: own, name: "Own storage" },
    { id: plain, name: "Instance storage" },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: own, userId: ids.owner, role: "owner" },
    { workspaceId: own, userId: ids.member, role: "member" },
    { workspaceId: plain, userId: ids.other, role: "owner" },
  ]);
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session`, token, userId: ids.owner, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
  const getFile = (id: string, headers: Record<string, string> = {}) =>
    fileRoute.GET(new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie, ...headers } }), { params: Promise.resolve({ id }) });

  const doc = await createPage({ userId: ids.owner }, { workspaceId: own, title: "Doc" });
  const otherDoc = await createPage({ userId: ids.other }, { workspaceId: plain, title: "Doc" });

  // Connecting: private addresses refused, owners only, tried before it is kept.
  const plainHttp = await failure(() => settings.connectStorage(ids.owner, own, "s3", s3Input()));
  check(plainHttp?.startsWith("refused") && /https/.test(plainHttp), "a plain http endpoint is refused", plainHttp);
  const loopback = await failure(() => settings.connectStorage(ids.owner, own, "s3", s3Input({ endpoint: `https://127.0.0.1:${new URL(endpoint).port}` })));
  check(loopback?.startsWith("refused") && /private address/.test(loopback), "a loopback endpoint is refused", loopback);
  const local = await failure(() => settings.testStorage(ids.owner, own, "s3", s3Input({ endpoint: "https://minio.internal" })));
  check(local?.startsWith("refused") && /local host name/.test(local), "a local host name is refused", local);
  const metadata = await failure(() => settings.testStorage(ids.owner, own, "s3", s3Input({ endpoint: "https://169.254.169.254" })));
  check(metadata?.startsWith("refused") && /private address/.test(metadata), "the cloud metadata address is refused", metadata);
  check((await targetsOf(own)).length === 0, "…and nothing is kept");

  process.env.STORAGE_ALLOWED_HOSTS = endpointHost;
  check((await failure(() => settings.connectStorage(ids.member, own, "s3", s3Input()))) === "access", "members can't connect storage");
  check((await failure(() => settings.connectStorage(ids.owner, own, "gdrive", s3Input()))) === "unavailable", "kinds that aren't available yet are refused");
  const wrongKey = await failure(() => settings.connectStorage(ids.owner, own, "s3", s3Input({ secretAccessKey: "not-the-secret" })));
  check(wrongKey?.startsWith("refused: S3 PUT failed: 403"), "wrong keys are refused with what the storage said", wrongKey);
  check((await failure(() => settings.testStorage(ids.owner, own, "s3", s3Input()))) === null, "a host on STORAGE_ALLOWED_HOSTS can be tested");
  const connected = await settings.connectStorage(ids.owner, own, "s3", s3Input());
  check(connected.current?.status === "active" && connected.current.config.bucket === bucket, "an owner connects the bucket", connected.current);
  check(!JSON.stringify(connected).includes(secretAccessKey), "the settings never show the keys");
  const [target] = await targetsOf(own);
  check(target.credentials.startsWith("sb1.") && !target.credentials.includes(secretAccessKey), "the keys are stored sealed");
  const audited = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, own), eq(auditEvent.action, "storage.connected")));
  check(audited.length === 1, "connecting is in the audit log");

  // Storing: the workspace's own storage, no quota; the other workspace keeps the instance's.
  const big = bytes(20_000, 3);
  const first = await upload(ids.owner, doc.id, "first.bin", big);
  const second = await upload(ids.owner, doc.id, "second.bin", bytes(20_000, 5));
  const firstRow = await fileRow(first.id);
  check(firstRow?.storageId === target.id, "the upload records the workspace's storage", firstRow);
  check((await inBucket(bucket, `leafdesk/${firstRow.storageKey}`))?.equals(big), "its bytes are in the bucket, under the folder");
  check(!(await onDisk(firstRow.storageKey)), "…and not on this server");
  check((await fileRow(second.id))?.storageId === target.id, "past the instance's quota, the workspace's own storage takes more");
  check((await files.workspaceUsage(own)) === 0, "files in its own storage don't count against the instance's quota");

  const kept = await upload(ids.other, otherDoc.id, "kept.bin", bytes(20_000));
  const keptRow = await fileRow(kept.id);
  check(keptRow?.storageId === null && (await onDisk(keptRow.storageKey)), "another workspace still stores on this server");
  check(!(await inBucket(bucket, `leafdesk/${keptRow.storageKey}`)), "…and nothing of it reaches the bucket");
  check((await failure(() => upload(ids.other, otherDoc.id, "more.bin", bytes(20_000)))) === "quotaExceeded", "…within the instance's quota");

  // Reading, through the files route, whole and in ranges.
  const whole = await getFile(first.id);
  check(whole.status === 200 && Buffer.from(await whole.arrayBuffer()).equals(big), "the file is served from the bucket");
  const part = await getFile(first.id, { range: "bytes=100-199" });
  check(part.status === 206 && Buffer.from(await part.arrayBuffer()).equals(big.subarray(100, 200)), "…and in byte ranges");
  check((await files.readStored(firstRow))?.equals(big), "readStored reads it from there too");

  // A storage that refuses: broken, with why; uploads fail rather than land on this server.
  await db.update(workspaceStorage).set({ credentials: sealJson({ accessKeyId, secretAccessKey: "revoked" }) }).where(eq(workspaceStorage.id, target.id));
  check((await getFile(first.id)).status === 502, "a file whose storage refuses answers 502");
  const broken = (await targetsOf(own))[0];
  check(broken.status === "broken" && /403/.test(broken.lastError ?? ""), "the storage is marked broken, with what it said", broken);
  check((await failure(() => upload(ids.owner, doc.id, "lost.bin", bytes(10)))) === "storageFailed", "an upload to it fails…");
  check((await db.select().from(file).where(and(eq(file.workspaceId, own), eq(file.name, "lost.bin")))).length === 0, "…leaving no row");
  check((await files.workspaceUsage(own)) === 0, "…and nothing on this server");
  const retest = await failure(() => settings.retestStorage(ids.owner, own));
  check(retest?.startsWith("refused"), "testing it again says it still fails", retest);
  await db.update(workspaceStorage).set({ credentials: target.credentials }).where(eq(workspaceStorage.id, target.id));
  check((await getFile(first.id)).status === 200, "with working keys it serves again…");
  check((await targetsOf(own))[0].status === "active", "…and is active again");

  // Deleting: through the queue, from the bucket, also after a failure.
  await db.update(file).set({ createdAt: sql`now() - interval '2 days'` }).where(inArray(file.id, [first.id, second.id]));
  const secondRow = (await fileRow(second.id))!;
  await db.update(workspaceStorage).set({ credentials: sealJson({ accessKeyId, secretAccessKey: "revoked" }) }).where(eq(workspaceStorage.id, target.id));
  check((await files.purgeUnusedUploads({ workspaceId: own })) === 2, "unused uploads lose their rows");
  const queued = await db.select().from(storageDeletion).where(eq(storageDeletion.storageId, target.id));
  check(
    queued.length === 2 && queued.some((q) => q.storageKey === secondRow.storageKey) && queued.every((q) => q.attempts === 1),
    "deletions the bucket refuses stay queued with their storage",
    queued,
  );
  check(Boolean(await inBucket(bucket, `leafdesk/${secondRow.storageKey}`)), "…and its object stays meanwhile");
  check((await removeRetiredStorage(target.id)) === 0, "a storage in use is never forgotten");
  await db.update(workspaceStorage).set({ credentials: target.credentials }).where(eq(workspaceStorage.id, target.id));
  await db.update(storageDeletion).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(storageDeletion.storageId, target.id));
  const drained = await files.drainStorageDeletions();
  check(drained !== null && drained.deleted >= 2, "the cleanup deletes it through the workspace's storage", drained);
  check(!(await inBucket(bucket, `leafdesk/${secondRow.storageKey}`)) && !(await inBucket(bucket, `leafdesk/${firstRow.storageKey}`)), "both objects are gone from the bucket");
  check((await db.select().from(storageDeletion).where(eq(storageDeletion.storageId, target.id))).length === 0, "…and from the queue");

  // New keys for the same bucket keep the connection; another bucket takes over.
  const third = await upload(ids.owner, doc.id, "third.bin", bytes(500, 7));
  const same = await settings.connectStorage(ids.owner, own, "s3", s3Input({ accessKeyId: "", secretAccessKey: "", forcePathStyle: true }));
  check(same.current?.id === target.id, "connecting the same bucket again (keys kept) changes the connection in place");
  const switched = await settings.connectStorage(ids.owner, own, "s3", s3Input({ bucket: otherBucket, prefix: "" }));
  check(switched.current?.id !== target.id && switched.current?.config.bucket === otherBucket, "another bucket takes over");
  check(switched.retired.length === 1 && switched.retired[0].id === target.id && switched.retired[0].files === 1, "the earlier one is listed with the file it holds", switched.retired);
  check((await getFile(third.id)).status === 200, "…which is still served from there");
  const fourth = await upload(ids.owner, doc.id, "fourth.bin", bytes(500, 9));
  const fourthRow = (await fileRow(fourth.id))!;
  check(fourthRow.storageId === switched.current!.id && Boolean(await inBucket(otherBucket, fourthRow.storageKey)), "new uploads go to the new bucket");

  // Disconnecting: new uploads come back to this server; files stay where they are.
  const disconnected = await settings.disconnectStorage(ids.owner, own);
  check(disconnected.current === null && disconnected.retired.length === 2, "disconnecting keeps both buckets for the files they hold", disconnected.retired);
  const fifth = await upload(ids.owner, doc.id, "fifth.bin", bytes(500, 11));
  const fifthRow = (await fileRow(fifth.id))!;
  check(fifthRow.storageId === null && (await onDisk(fifthRow.storageKey)), "after disconnecting, uploads go to this server");
  check((await getFile(fourth.id)).status === 200 && (await getFile(third.id)).status === 200, "files in the disconnected buckets are still served");

  // Deleting the workspace deletes its files where they are, then forgets the buckets.
  const thirdRow = (await fileRow(third.id))!;
  await deleteWorkspace(
    { user: { id: ids.owner, name: "Owner", email: `${ids.owner}@example.test` }, session: { id: `${RUN}-s`, createdAt: new Date() } },
    own,
    { confirmation: "Own storage", proof: {} },
  );
  const orphaned = await db.select().from(workspaceStorage).where(inArray(workspaceStorage.id, [target.id, switched.current!.id]));
  created.push(...orphaned.map((t) => t.id));
  check(orphaned.length === 2 && orphaned.every((t) => t.workspaceId === null), "the buckets outlive the workspace while they may hold its files");
  // The deletion from storage runs in the background.
  await eventually(async () => (await db.select().from(storageDeletion).where(inArray(storageDeletion.storageId, created))).length === 0, "the queued deletions");
  check(!(await inBucket(bucket, `leafdesk/${thirdRow.storageKey}`)) && !(await inBucket(otherBucket, fourthRow.storageKey)), "its files are deleted from both buckets");
  check(!(await onDisk(fifthRow.storageKey)), "…and from this server");
  check((await removeRetiredStorage()) >= 2, "then the buckets are forgotten");
  check((await db.select().from(workspaceStorage).where(inArray(workspaceStorage.id, created))).length === 0, "…keys and all");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(file).where(inArray(file.workspaceId, [own, plain]));
  await db.delete(storageDeletion).where(sql`${storageDeletion.storageKey} like ${`${RUN}-%`}`);
  await db.delete(workspace).where(inArray(workspace.id, [own, plain]));
  if (created.length) {
    await db.delete(storageDeletion).where(inArray(storageDeletion.storageId, created));
    await db.delete(workspaceStorage).where(inArray(workspaceStorage.id, created));
  }
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
