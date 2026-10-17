/**
 * End-to-end check of deleting stored files against the database: whatever removes file rows
 * queues their objects in the same transaction (`storage_deletion`), so an object storage refuses to
 * delete, or one a restart cut short, is deleted later by the file cleanup instead of being left
 * behind with no row pointing at it. Covers deleting a workspace while storage fails, the retry
 * delay, the cleanup run (one server at a time), and the orphan cleanup. Creates its own users,
 * workspaces and files (in a temporary upload directory) and deletes them afterwards.
 *
 *   pnpm tsx scripts/storage-deletion-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, like } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, storageDeletion, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const files = await import("@/server/files");
const { setStorage } = await import("@/server/storage");
const { localDriver } = await import("@/server/storage/local");
const { deleteWorkspace } = await import("@/server/workspace-deletion");

const RUN = `storage-deletion-e2e-${Date.now().toString(36)}`;
const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-storage-deletion-"));
const local = localDriver(uploadDir);
// Storage that refuses deletions while `refusing` is set.
let refusing = false;
setStorage({
  ...local,
  async delete(key) {
    if (refusing) throw new Error("storage is unavailable");
    await local.delete(key);
  },
});

registerCollab({
  broadcast() {},
  openPageIds: () => [],
  async disconnectWorkspace() {},
} as unknown as Parameters<typeof registerCollab>[0]);

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

async function eventually(condition: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(false, label, "timed out");
}

async function stored(key: string) {
  const body = await local.get(key);
  if (!body) return false;
  await body.cancel();
  return true;
}

async function queued(keys: string[]) {
  return db.select().from(storageDeletion).where(inArray(storageDeletion.storageKey, keys));
}

let fileCount = 0;
/** A file row in `workspaceId` and its object in storage. */
async function addFile(workspaceId: string, pageId: string | null = null) {
  const id = `${RUN}-f${++fileCount}`;
  const storageKey = `${workspaceId}/${id}`;
  await local.put(storageKey, Readable.from([Buffer.from("bytes")]), { size: 5, contentType: "text/plain" });
  await db.insert(file).values({ id, workspaceId, pageId, storageKey, name: "a.txt", contentType: "text/plain", size: 5, referencedAt: new Date() });
  return storageKey;
}

const owner = `${RUN}-owner`;
const ws = { doomed: `${RUN}-doomed`, other: `${RUN}-other` };

try {
  await db.insert(user).values({ id: owner, name: "Owner", email: `${owner}@example.test` });
  await db.insert(workspace).values([
    { id: ws.doomed, name: "Doomed" },
    { id: ws.other, name: "Other" },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws.doomed, userId: owner, role: "owner" },
    { workspaceId: ws.other, userId: owner, role: "owner" },
  ]);

  // ── Queued with the rows ────────────────────────────────────────────────────────────────
  const rolledBack = await addFile(ws.other);
  await db
    .transaction(async (tx) => {
      await tx.delete(file).where(eq(file.storageKey, rolledBack));
      await files.queueStorageDeletion(tx, [rolledBack]);
      throw new Error("rollback");
    })
    .catch(() => {});
  check((await queued([rolledBack])).length === 0, "a deletion that rolls back queues nothing");
  check(await stored(rolledBack), "…and leaves the object alone");

  // ── Deleting a workspace while storage refuses ──────────────────────────────────────────
  const keys = [await addFile(ws.doomed), await addFile(ws.doomed), await addFile(ws.doomed)];
  refusing = true;
  await deleteWorkspace(
    { user: { id: owner, name: "Owner", email: `${owner}@example.test` }, session: { id: `${RUN}-s`, createdAt: new Date() } },
    ws.doomed,
    { confirmation: "Doomed", proof: {} },
  );
  check(!(await db.select().from(workspace).where(eq(workspace.id, ws.doomed))).length, "the workspace is deleted");
  check(!(await db.select().from(file).where(eq(file.workspaceId, ws.doomed))).length, "…with its file rows");
  // The deletion from storage runs in the background.
  await eventually(async () => (await queued(keys)).every((q) => q.attempts === 1), "failed deletions are recorded");
  const failed = await queued(keys);
  check(failed.length === 3, "every object storage refused stays queued", failed);
  check(
    failed.every((q) => q.lastError?.includes("storage is unavailable") && q.nextAttemptAt.getTime() > Date.now() + 30_000),
    "…with the error, to be tried again in about a minute",
    failed,
  );
  check((await Promise.all(keys.map(stored))).every(Boolean), "…and the objects are still there");

  // ── The cleanup ─────────────────────────────────────────────────────────────────────────
  refusing = false;
  const early = await files.drainStorageDeletions();
  check(early !== null && (await queued(keys)).length === 3, "the cleanup leaves deletions that aren't due yet", early);

  await db.update(storageDeletion).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(inArray(storageDeletion.storageKey, keys));
  refusing = true;
  check((await files.drainStorageDeletions())?.failed === 3, "a deletion that fails again is counted…");
  const again = await queued(keys);
  check(
    again.every((q) => q.attempts === 2 && q.nextAttemptAt.getTime() > Date.now() + 90_000),
    "…and waits twice as long",
    again,
  );

  await db.update(storageDeletion).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(inArray(storageDeletion.storageKey, keys));
  refusing = false;
  const reserved = await db.$client.reserve();
  try {
    await reserved`select pg_advisory_lock(hashtext('leafdesk:storage-deletion'))`;
    check((await files.drainStorageDeletions()) === null, "only one server runs the cleanup at a time");
    await reserved`select pg_advisory_unlock(hashtext('leafdesk:storage-deletion'))`;
  } finally {
    reserved.release();
  }
  const drained = await files.drainStorageDeletions();
  check(drained !== null && drained.deleted >= 3 && drained.failed === 0, "once storage works, the cleanup deletes them", drained);
  check((await queued(keys)).length === 0, "…empties the queue");
  check((await Promise.all(keys.map(stored))).every((s) => !s), "…and the objects are gone");

  // ── Orphaned files ──────────────────────────────────────────────────────────────────────
  const orphan = await addFile(ws.other);
  check((await files.purgeOrphanFiles(ws.other)) === 2, "the orphan cleanup removes files no page holds");
  check(!(await stored(orphan)) && !(await stored(rolledBack)), "…from storage right away");
  check((await queued([orphan, rolledBack])).length === 0, "…leaving nothing queued");

  const refused = await addFile(ws.other);
  refusing = true;
  check((await files.purgeOrphanFiles(ws.other)) === 1, "an orphan storage refuses to delete loses its row…");
  check((await queued([refused])).length === 1 && (await stored(refused)), "…and stays queued with its object");
  refusing = false;

  console.log(`\n${passed} checks passed`);
} finally {
  refusing = false;
  await db.delete(workspace).where(inArray(workspace.id, Object.values(ws)));
  await db.delete(user).where(eq(user.id, owner));
  await db.delete(storageDeletion).where(like(storageDeletion.storageKey, `${RUN}-%`));
  await rm(uploadDir, { recursive: true, force: true });
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
