/**
 * End-to-end checks that moving a workspace's files between storages never loses or strands one,
 * against the database and a real S3-compatible server (MinIO, say):
 *
 * - A queued deletion never removes an object a file is stored as now: neither a copy a move left
 *   behind once the file came back to the same place, nor a destination copy a worker that lost
 *   its move tries to clean up.
 * - Two workers on one move (the first one's lease ran out) don't copy every file twice: the first
 *   gives the move up, and every file arrives whole.
 * - A copy whose row couldn't be pointed at it is deleted again, not left in the storage.
 * - Files never move onto the server's storage past the workspace's quota there, also when more
 *   are uploaded while the move waits.
 * - Trying a move again never sends the files to storage of someone no longer in the workspace.
 * - A storage sign-in can only be finished, or looked up, by the person who began it.
 *
 *   pnpm tsx scripts/storage-move-safety-e2e.ts
 *
 * Env as for scripts/workspace-storage-e2e.ts: DATABASE_URL (read from .env when present;
 * migrations applied), STORAGE_E2E_ENDPOINT (default http://127.0.0.1:9100),
 * STORAGE_E2E_ACCESS_KEY, STORAGE_E2E_SECRET_KEY, STORAGE_E2E_BUCKET (default ws-files) and
 * STORAGE_E2E_OTHER_BUCKET (default other-files).
 */
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

process.env.OWN_STORAGE_ENABLED = "true";
process.env.STORAGE_ALLOWED_HOSTS = new URL(endpoint).host;
process.env.UPLOAD_MAX_FILE_MB = String(25_000 / 1024 / 1024);
process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(1_000_000 / 1024 / 1024);
process.env.STORAGE_DROPBOX_CLIENT_ID = "e2e-app";
process.env.STORAGE_DROPBOX_CLIENT_SECRET = "e2e-secret";
delete process.env.STORAGE_GDRIVE_CLIENT_ID;
delete process.env.STORAGE_GDRIVE_CLIENT_SECRET;

const { and, eq, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, session, storageDeletion, storageMove, storageOauth, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const files = await import("@/server/files");
const { setStorage } = await import("@/server/storage/index");
const { s3Driver } = await import("@/server/storage/s3");
const { currentTarget, removeRetiredStorage } = await import("@/server/storage/workspace");
const accounts = await import("@/server/storage/accounts");
const moves = await import("@/server/storage/moves");
const fileRoute = await import("@/app/api/files/[id]/route");
type StorageDriver = import("@/server/storage/driver").StorageDriver;

const RUN = `move-safety-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);

// Every check runs, so a run on unfixed code shows each problem at once.
let passed = 0;
const failed: string[] = [];
function check(condition: unknown, label: string, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`ok    ${label}`);
    return;
  }
  failed.push(label);
  console.error(`FAIL  ${label}`);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const raw = (name: string, prefix?: string) => s3Driver({ bucket: name, prefix, endpoint, region: "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: true });

// The server's storage: S3 (the other bucket, under this run's folder), so files may move onto it.
// Its puts can be slowed down and are counted.
const serverPrefix = `${RUN}-server`;
const serverInner = raw(otherBucket, serverPrefix);
const serverStore = { delayMs: 0, puts: 0 };
const server: StorageDriver = {
  kind: "s3",
  async put(key, body, info) {
    serverStore.puts++;
    if (serverStore.delayMs) await sleep(serverStore.delayMs);
    return serverInner.put(key, body, info);
  },
  get: (ref, range) => serverInner.get(ref, range),
  delete: (ref) => serverInner.delete(ref),
};
setStorage(server);
const onServer = async (key: string) => Boolean(await serverInner.get(key));

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const upload = (userId: string, pageId: string, name: string, body: Buffer) =>
  files.uploadFile(userId, pageId, { name, contentType: "application/octet-stream", body: Readable.from([body]), declaredSize: body.length });
const fileRow = async (id: string) => (await db.select().from(file).where(eq(file.id, id)))[0] ?? null;
const lastMove = async (workspaceId: string) => (await db.select().from(storageMove).where(eq(storageMove.workspaceId, workspaceId)).orderBy(storageMove.createdAt)).at(-1) ?? null;
const s3Input = (prefix: string) => ({ endpoint, region: "us-east-1", bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle: true });
const quotaBytes = (n: number) => {
  process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(n / 1024 / 1024);
};

async function settle() {
  moves.kickMoves();
  await moves.settleMoves();
  await files.drainStorageDeletions();
  await removeRetiredStorage();
}

const ids = { ann: `${RUN}-ann`, bob: `${RUN}-bob`, cid: `${RUN}-cid` };
const ws = { back: `${RUN}-back`, again: `${RUN}-again`, race: `${RUN}-race`, quota: `${RUN}-quota`, leak: `${RUN}-leak`, retry: `${RUN}-retry`, oauth: `${RUN}-oauth` };
const trigger = `move_safety_fail_${Date.now().toString(36)}`;

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values(Object.entries(ws).map(([name, id]) => ({ id, name })));
  await db.insert(workspaceMember).values([
    ...Object.values(ws).map((id) => ({ workspaceId: id, userId: ids.ann, role: "owner" as const })),
    { workspaceId: ws.retry, userId: ids.cid, role: "owner" as const },
  ]);
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${ids.bob}-session`, token, userId: ids.bob, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  // Bob reads the files, as a member of every workspace.
  await db.insert(workspaceMember).values(Object.values(ws).map((id) => ({ workspaceId: id, userId: ids.bob, role: "member" as const })));
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
  const served = async (id: string, body: Buffer) => {
    const response = await fileRoute.GET(new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
    return response.status === 200 && Buffer.from(await response.arrayBuffer()).equals(body);
  };
  const doc = async (workspaceId: string) => createPage({ userId: ids.ann }, { workspaceId, title: "Doc" });

  // Ann's bucket, her default, used by the workspaces it is attached to.
  const anns = await accounts.connectS3Account(ids.ann, s3Input(`${RUN}-ann`));

  // ------------------------------------------------------------------ A queued deletion of where a file is now
  {
    await accounts.attachAccount(ids.ann, ws.back, anns.id);
    const page = await doc(ws.back);
    const body = bytes(3_000, 11);
    const up = await upload(ids.ann, page.id, "back.bin", body);
    const row = (await fileRow(up.id))!;
    // A move away left this deletion behind, it failed for now, and the file came back to the same place.
    await db.insert(storageDeletion).values({ storageId: row.storageId, storageKey: row.storageKey });
    await files.drainStorageDeletions();
    check(await served(up.id, body), "a deletion left behind by a move doesn't remove the file once it is back in the same storage");

    // The same on the server's storage.
    const onServerBody = bytes(2_000, 12);
    await db.update(file).set({ storageId: null }).where(eq(file.id, up.id));
    await server.put(row.storageKey, Readable.from([onServerBody]), { size: onServerBody.length, contentType: "application/octet-stream" });
    await db.update(file).set({ size: onServerBody.length }).where(eq(file.id, up.id));
    await db.insert(storageDeletion).values({ storageId: null, storageKey: row.storageKey });
    await files.drainStorageDeletions();
    check(await served(up.id, onServerBody), "…nor once it is back on the server's storage");
    await db.update(file).set({ storageId: row.storageId, size: body.length }).where(eq(file.id, up.id));
    await raw(bucket, `${RUN}-ann`).put(row.storageKey, Readable.from([body]), { size: body.length, contentType: "application/octet-stream" });

    // A worker that lost the move cleans up its copy at the destination, where the winner's row points.
    await files.removeStored([{ storageId: row.storageId, key: row.storageKey }]);
    check(await served(up.id, body), "a losing worker's clean-up of its copy doesn't remove the copy the file is stored as");
  }

  // ------------------------------------------------------------------ The same bucket connected again, as a new account
  {
    await accounts.attachAccount(ids.ann, ws.again, anns.id);
    const page = await doc(ws.again);
    const body = bytes(2_500, 13);
    const up = await upload(ids.ann, page.id, "again.bin", body);
    const before = (await fileRow(up.id))!;
    // The account is disconnected (its place stays while a deletion names it), and the same bucket is
    // connected again: a new account and place over the same objects.
    // A deletion of the old copy, failed for now and due again later.
    await db.insert(storageDeletion).values({ storageId: before.storageId, storageKey: before.storageKey, nextAttemptAt: new Date(Date.now() + 3_600_000) });
    await db.execute(sql`update storage_account set status = 'disconnected', is_default = false where id = ${anns.id}`);
    await db.execute(sql`update workspace_storage set status = 'disconnected' where storage_account_id = ${anns.id}`);
    const again = await accounts.connectS3Account(ids.ann, s3Input(`${RUN}-ann`), ws.again);
    const place = await currentTarget(ws.again);
    check(again.id !== anns.id && place?.storageAccountId === again.id && place.id !== before.storageId, "the bucket connected again is a new account and place");
    await db.update(file).set({ storageId: place!.id }).where(eq(file.id, up.id));
    await db.execute(sql`update storage_deletion set next_attempt_at = now() where storage_id = ${before.storageId} and storage_key = ${before.storageKey}`);
    await files.drainStorageDeletions();
    check(await served(up.id, body), "a deletion through the old account doesn't remove the object the new one stores the file as");
    // Ann's first account works again for the rest.
    await db.execute(sql`update storage_account set status = 'disconnected', is_default = false where id = ${again.id}`);
    await db.execute(sql`update storage_account set status = 'active', is_default = true where id = ${anns.id}`);
  }

  // ------------------------------------------------------------------ Two workers on one move
  {
    await accounts.attachAccount(ids.ann, ws.race, anns.id);
    const page = await doc(ws.race);
    const bodies = new Map<string, Buffer>();
    for (let i = 0; i < 6; i++) {
      const body = bytes(4_000 + i, 20 + i);
      bodies.set((await upload(ids.ann, page.id, `race-${i}.bin`, body)).id, body);
    }
    // Queued as an owner's move to the server would be; the workers below take it.
    await db.insert(storageMove).values({ workspaceId: ws.race, toServer: true, reason: "manual", startedBy: ids.ann });
    serverStore.delayMs = 250;
    serverStore.puts = 0;
    const first = moves.runDueMoves();
    for (let i = 0; i < 100 && serverStore.puts < 2; i++) await sleep(20);
    // The first worker's lease runs out (a slow batch) and a second takes the move.
    await db.update(storageMove).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(storageMove.workspaceId, ws.race));
    const second = moves.runDueMoves();
    await Promise.all([first, second]);
    serverStore.delayMs = 0;
    await files.drainStorageDeletions();
    let whole = 0;
    for (const [id, body] of bodies) if (await served(id, body)) whole++;
    check(whole === bodies.size, "with two workers on one move, every file arrives whole", { whole, of: bodies.size });
    check(serverStore.puts <= bodies.size + 1, "…and the first gives the move up rather than copy every file again", { puts: serverStore.puts, files: bodies.size });
    check((await lastMove(ws.race))?.status === "done", "…and the move is done");
  }

  // ------------------------------------------------------------------ A copy whose row can't be pointed at it
  {
    await accounts.attachAccount(ids.ann, ws.leak, anns.id);
    const page = await doc(ws.leak);
    const body = bytes(1_500, 31);
    const up = await upload(ids.ann, page.id, "leak.bin", body);
    const row = (await fileRow(up.id))!;
    await db.execute(
      sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'pointing refused for the test'; end $$`),
    );
    await db.execute(
      sql.raw(`create trigger ${trigger} before update of storage_id on file for each row when (old.id = '${up.id}' and new.storage_id is distinct from old.storage_id) execute function ${trigger}()`),
    );
    await moves.startManualMove(ids.ann, ws.leak, { server: true });
    await settle();
    check((await lastMove(ws.leak))?.status === "failed", "a move whose row update fails doesn't finish");
    check(!(await onServer(row.storageKey)), "…and the copy it made isn't left in the destination", { key: row.storageKey });
    check(await served(up.id, body), "…while the file is still served from where it was");
    await db.execute(sql.raw(`drop trigger ${trigger} on file`));
    await db.execute(sql.raw(`drop function ${trigger}()`));
  }

  // ------------------------------------------------------------------ The server's quota
  {
    await accounts.attachAccount(ids.ann, ws.quota, anns.id);
    const page = await doc(ws.quota);
    quotaBytes(30_000);
    const first = [bytes(10_000, 41), bytes(10_000, 42)];
    const ups = [];
    for (const [i, body] of first.entries()) ups.push({ id: (await upload(ids.ann, page.id, `q${i}.bin`, body)).id, body });
    // 20 000 of 30 000 bytes fit, so an owner's move to the server is queued; before it runs, more is
    // uploaded (to Ann's bucket, still where uploads go), and the move takes those too.
    await db.insert(storageMove).values({ workspaceId: ws.quota, toServer: true, reason: "manual", startedBy: ids.ann });
    for (const [i, body] of [bytes(10_000, 43), bytes(10_000, 44)].entries()) ups.push({ id: (await upload(ids.ann, page.id, `q${i + 2}.bin`, body)).id, body });
    await settle();
    const usage = await files.workspaceUsage(ws.quota);
    check(usage <= 30_000, "files don't move onto the server's storage past the workspace's quota", { usage });
    let readable = 0;
    for (const { id, body } of ups) if (await served(id, body)) readable++;
    check(readable === ups.length, "…and every file stays readable, wherever it is", { readable });
    check((await lastMove(ws.quota))?.status === "failed", "…and the move says it couldn't take them all");
    quotaBytes(1_000_000);
  }

  // ------------------------------------------------------------------ Trying a move again after its destination's owner left
  {
    const cids = await accounts.connectS3Account(ids.cid, s3Input(`${RUN}-cid`));
    const page = await doc(ws.retry);
    const body = bytes(1_200, 51);
    const up = await upload(ids.ann, page.id, "retry.bin", body);
    const [failedMove] = await db
      .insert(storageMove)
      .values({ workspaceId: ws.retry, toAccountId: cids.id, reason: "manual", startedBy: ids.cid, status: "failed", lastError: "Drive said no", finishedAt: new Date() })
      .returning();
    // Cid isn't in the workspace any more.
    await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, ws.retry), eq(workspaceMember.userId, ids.cid)));
    await moves.retryMove(ids.ann, ws.retry, failedMove.id).catch(() => undefined);
    await settle();
    const target = await currentTarget(ws.retry);
    check(target?.storageAccountId !== cids.id, "trying a move again never sends the files to storage of someone who left", { account: target?.storageAccountId });
    check(await served(up.id, body), "…and the file stays readable");
  }

  // ------------------------------------------------------------------ A storage sign-in someone else finishes
  {
    const { url } = await accounts.beginStorageOAuth(ids.ann, "dropbox", ws.oauth);
    const state = new URL(url).searchParams.get("state")!;
    check((await accounts.storageOAuthReturnOf(state, ids.bob)) === null, "someone else can't look up where a sign-in was begun from");
    await accounts.completeStorageOAuth(ids.bob, { state, code: "x" }).catch(() => undefined);
    const [kept] = await db.select().from(storageOauth).where(eq(storageOauth.state, state));
    check(Boolean(kept), "someone else finishing a sign-in doesn't use it up for the person who began it");
    check((await accounts.storageOAuthReturnOf(state, ids.ann))?.workspaceId === ws.oauth, "…who still finds where they began it");
  }
} finally {
  await db.execute(sql.raw(`drop trigger if exists ${trigger} on file`)).catch(() => undefined);
  await db.execute(sql.raw(`drop function if exists ${trigger}()`)).catch(() => undefined);
  await settle().catch(() => undefined);
  await db.delete(workspace).where(sql`${workspace.id} like ${`${RUN}-%`}`);
  await settle().catch(() => undefined);
  await db.delete(storageOauth).where(sql`${storageOauth.userId} like ${`${RUN}-%`}`);
  await db.execute(sql`delete from storage_deletion where storage_id in (select ws.id from workspace_storage ws join storage_account a on a.id = ws.storage_account_id where a.user_id like ${`${RUN}-%`})`);
  await db.execute(sql`delete from workspace_storage where storage_account_id in (select id from storage_account where user_id like ${`${RUN}-%`})`);
  await db.execute(sql`delete from storage_account where user_id like ${`${RUN}-%`}`);
  await db.delete(user).where(sql`${user.id} like ${`${RUN}-%`}`);
  await hocuspocus.closeConnections?.();
}

console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} failed:\n  ${failed.join("\n  ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
