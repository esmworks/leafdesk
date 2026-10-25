/**
 * End-to-end check of data retention against the database: owners set how long pages stay in the
 * trash, the trash says when each page goes, and the daily cleanup deletes the pages whose time is
 * up (their subpages and files too) while leaving the rest, workspaces that keep their trash and
 * workspaces outside the run alone. It also prunes page history by age and count, keeping restore
 * points and saved versions longer, named versions and the newest version of every page for good, and only one cleanup runs
 * at a time. Creates its own users and workspaces and deletes them afterwards; the cleanup only
 * ever runs against those workspaces.
 *
 *   pnpm tsx scripts/retention-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { Readable } from "node:stream";

export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { file, page, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
type SnapshotReason = import("@/db/schema").SnapshotReason;
const { HISTORY_RETENTION } = await import("@/lib/retention");
const { registerCollab } = await import("@/server/collab/bridge");
const { storeFile } = await import("@/server/files");
const { deleteTrashedPages, listTrash } = await import("@/server/pages");
const { runRetention } = await import("@/server/retention");
const { instanceStorage } = await import("@/server/storage");
const { updateWorkspaceSettings, workspaceSettings, WorkspaceError } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");

const RUN = `retention-e2e-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({ async pagesTrashed() {}, broadcast() {}, async disconnectLostAccess() {} } as unknown as Parameters<typeof registerCollab>[0]);

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

async function rejects(fn: () => Promise<unknown>, test: (error: unknown) => boolean, label: string) {
  try {
    await fn();
  } catch (error) {
    check(test(error), label, String(error));
    return;
  }
  check(false, label, "did not throw");
}

const ids = { owner: `${RUN}-owner`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
// A: 7 days. Keep: 0 (kept forever). Default: no setting (30 days). Outside: 7 days, but never
// named in a run, standing in for everyone else's workspaces.
const ws = { a: `${RUN}-a`, keep: `${RUN}-keep`, dflt: `${RUN}-default`, outside: `${RUN}-outside` };
const workspaceIds = Object.values(ws);
const inRun = [ws.a, ws.keep, ws.dflt];
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);

async function existing(...pageIds: string[]) {
  const rows = await db.select({ id: page.id }).from(page).where(inArray(page.id, pageIds));
  return pageIds.map((id) => rows.some((r) => r.id === id));
}

async function stored(key: string) {
  const body = await instanceStorage().get(key);
  if (!body) return false;
  await body.cancel();
  return true;
}

const emptyDoc = Y.encodeStateAsUpdate(new Y.Doc());
function snap(pageId: string, reason: SnapshotReason, createdAt: Date, name: string | null = null) {
  return { pageId, reason, createdAt, title: "v", ydoc: emptyDoc, name };
}
async function snapshotsOf(pageId: string) {
  return db
    .select({ id: pageSnapshot.id, reason: pageSnapshot.reason, name: pageSnapshot.name, createdAt: pageSnapshot.createdAt })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.pageId, pageId));
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values(workspaceIds.map((id) => ({ id, name: id })));
  await db.insert(workspaceMember).values(
    workspaceIds.flatMap((workspaceId) => [
      { workspaceId, userId: ids.owner, role: "owner" as const },
      { workspaceId, userId: ids.bob, role: "member" as const },
    ]),
  );
  const { owner, bob } = ids;

  // ── The setting ──────────────────────────────────────────────────────────────────────────────
  check((await workspaceSettings(ws.a)).trashRetentionDays === 30, "the trash keeps pages 30 days by default");
  await rejects(
    () => updateWorkspaceSettings(bob, ws.a, { trashRetentionDays: 7 }),
    (e) => e instanceof AccessError,
    "members can't change how long the trash keeps pages",
  );
  await rejects(
    () => updateWorkspaceSettings(owner, ws.a, { trashRetentionDays: 5 }),
    (e) => e instanceof WorkspaceError && e.code === "invalidSetting",
    "only the offered durations are accepted",
  );
  await rejects(
    () => updateWorkspaceSettings(owner, ws.a, { trashRetentionDays: "7" as unknown as number }),
    (e) => e instanceof WorkspaceError && e.code === "invalidSetting",
    "…as numbers",
  );
  await updateWorkspaceSettings(owner, ws.a, { trashRetentionDays: 7 });
  await updateWorkspaceSettings(owner, ws.keep, { trashRetentionDays: 0 });
  await updateWorkspaceSettings(owner, ws.outside, { trashRetentionDays: 7 });
  check((await workspaceSettings(ws.a)).trashRetentionDays === 7, "owners set it");

  // ── Trash ────────────────────────────────────────────────────────────────────────────────────
  const P = (name: string, workspaceId: string, archivedAt: Date | null, parent?: string) => ({
    id: `${RUN}-${name}`,
    workspaceId,
    parentId: parent ? `${RUN}-${parent}` : null,
    title: name,
    archivedAt,
  });
  // A: expired (with a subpage trashed together and a file), not expired yet, a live page, a
  // subpage trashed on its own before its parent (expired while the parent isn't), and a page
  // exactly at its deletion time.
  await db.insert(page).values([
    P("expired", ws.a, ago(10)),
    P("fresh", ws.a, ago(3)),
    P("live", ws.a, null),
    P("parent", ws.a, ago(2)),
    P("due", ws.a, ago(7)),
  ]);
  await db.insert(page).values([P("expiredChild", ws.a, ago(10), "expired"), P("earlyChild", ws.a, ago(20), "parent")]);
  // Keep: very old trash. Default: either side of 30 days. Outside: long expired.
  await db.insert(page).values([
    P("ancient", ws.keep, ago(400)),
    P("old31", ws.dflt, ago(31)),
    P("new29", ws.dflt, ago(29)),
    P("outsider", ws.outside, ago(100)),
  ]);
  const id = (name: string) => `${RUN}-${name}`;
  const upload = (pageId: string, workspaceId: string) =>
    storeFile(
      { workspaceId, pageId, uploadedBy: owner },
      { name: "note.txt", contentType: "text/plain", body: Readable.from([Buffer.from("retention")]), declaredSize: 9 },
    );
  const expiredFile = await upload(id("expired"), ws.a);
  const freshFile = await upload(id("fresh"), ws.a);
  const expiredKey = `${ws.a}/${expiredFile.id}`;
  const freshKey = `${ws.a}/${freshFile.id}`;
  check((await stored(expiredKey)) && (await stored(freshKey)), "files are stored on the trashed pages");

  const trashA = new Map((await listTrash(owner, ws.a)).map((r) => [r.id, r]));
  const fresh = trashA.get(id("fresh"));
  check(
    fresh?.deletesAt?.getTime() === new Date(fresh!.archived_at).getTime() + 7 * DAY,
    "the trash says when each page is deleted",
    fresh,
  );
  check(!trashA.has(id("expiredChild")), "…per trash entry, not per subpage trashed with it");
  check(
    (await listTrash(owner, ws.keep)).every((r) => r.deletesAt === null),
    "…and nothing when the workspace keeps its trash",
  );

  check((await deleteTrashedPages(ws.a, [id("live")])).length === 0, "the cleanup's delete leaves pages outside the trash alone");
  check((await deleteTrashedPages(ws.keep, [id("fresh")])).length === 0, "…and pages of another workspace");
  check((await existing(id("live"), id("fresh"))).every(Boolean), "…both still there");

  // Only one cleanup at a time: another connection holding the lock makes this run skip.
  const holder = await db.$client.reserve();
  try {
    await holder`select pg_advisory_lock(hashtext('leafdesk:retention'))`;
    check((await runRetention({ now, workspaceIds: inRun })) === null, "a cleanup doesn't start while another one runs");
    await holder`select pg_advisory_unlock(hashtext('leafdesk:retention'))`;
  } finally {
    holder.release();
  }
  check((await existing(id("expired"))).every(Boolean), "…and deleted nothing");

  // ── History ──────────────────────────────────────────────────────────────────────────────────
  const hours = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);
  const { maxPerPage, maxAgeDays, keptAgeDays } = HISTORY_RETENTION;
  // "live": more recent autosaves than the limit, an old app edit, and restore points and saved
  // versions either side of their longer limit. Named versions: newer than all the autosaves (they
  // would push some out if they counted toward the limit), and past every limit.
  await db.insert(pageSnapshot).values([
    ...Array.from({ length: maxPerPage + 5 }, (_, i) => snap(id("live"), "auto", hours(i + 1))),
    snap(id("live"), "before_mcp_write", ago(maxAgeDays + 10)),
    snap(id("live"), "manual", ago(maxAgeDays + 10)),
    snap(id("live"), "manual", ago(keptAgeDays + 10)),
    snap(id("live"), "before_restore", ago(keptAgeDays - 10)),
    snap(id("live"), "before_restore", ago(keptAgeDays + 5)),
    ...[1, 2, 3].map((n) => snap(id("live"), "auto", hours(n / 10), `Draft ${n}`)),
    snap(id("live"), "auto", ago(keptAgeDays + 100), "Kickoff"),
    snap(id("live"), "manual", ago(keptAgeDays + 10), "Signed off"),
    snap(id("live"), "before_mcp_write", ago(maxAgeDays + 10), "Before the rewrite"),
  ]);
  // "fresh" (in A too): a lone very old version, kept as the page's newest. "new29": two old ones.
  await db.insert(pageSnapshot).values([
    snap(id("fresh"), "auto", ago(500)),
    snap(id("new29"), "auto", ago(500)),
    snap(id("new29"), "before_ai_edit", ago(400)),
    snap(id("outsider"), "auto", ago(500)),
    snap(id("outsider"), "auto", ago(400)),
  ]);

  // ── The run ──────────────────────────────────────────────────────────────────────────────────
  const result = await runRetention({ now, workspaceIds: inRun });
  check(result !== null, "the cleanup runs", result);
  check(
    (await existing(id("expired"), id("expiredChild"), id("earlyChild"), id("due"))).every((e) => !e),
    "pages trashed longer than the workspace keeps them are deleted, with their subpages",
  );
  check(
    (await existing(id("fresh"), id("parent"), id("live"))).every(Boolean),
    "pages still within their time, their parents and live pages stay",
  );
  const [expiredRow] = await db.select().from(file).where(eq(file.id, expiredFile.id));
  check(!expiredRow && !(await stored(expiredKey)), "the deleted page's file is gone, from storage too");
  const [freshRow] = await db.select().from(file).where(eq(file.id, freshFile.id));
  check(freshRow && (await stored(freshKey)), "the file of a page still in the trash stays");
  check((await existing(id("ancient"))).every(Boolean), "a workspace set to keep its trash keeps even very old pages");
  check(
    (await existing(id("old31"), id("new29"))).join() === "false,true",
    "the default of 30 days applies where nothing is set",
  );
  check((await existing(id("outsider"))).every(Boolean), "workspaces outside the run are untouched");
  check(result.trashedPages === 4 && result.workspaces === 2, "the run counts the trash entries it deleted", result);

  const liveAll = await snapshotsOf(id("live"));
  const live = liveAll.filter((s) => s.name === null);
  const count = (reason: SnapshotReason) => live.filter((s) => s.reason === reason).length;
  check(count("auto") === maxPerPage, `only the newest ${maxPerPage} autosaves of a page stay`, count("auto"));
  const named = liveAll.filter((s) => s.name !== null).map((s) => s.name).sort();
  check(
    named.join() === "Before the rewrite,Draft 1,Draft 2,Draft 3,Kickoff,Signed off",
    "named versions stay however old, and don't count toward the limit",
    named,
  );
  const oldestAuto = Math.min(...live.filter((s) => s.reason === "auto").map((s) => s.createdAt.getTime()));
  check(oldestAuto === hours(maxPerPage).getTime(), "…the oldest ones go");
  check(count("before_mcp_write") === 0, `versions older than ${maxAgeDays} days go`);
  check(count("manual") === 1, `saved versions stay up to ${keptAgeDays} days, not beyond`, live);
  check(count("before_restore") === 1, "…and so do restore points", live);
  check((await snapshotsOf(id("fresh"))).length === 1, "the only version of a page stays however old");
  const new29 = await snapshotsOf(id("new29"));
  check(new29.length === 1 && new29[0].reason === "before_ai_edit", "…as does the newest of old ones", new29);
  check((await snapshotsOf(id("outsider"))).length === 2, "history outside the run is untouched");
  check(result.snapshots === 5 + 1 + 1 + 1 + 1, "the run counts the versions it pruned", result);

  const again = await runRetention({ now, workspaceIds: inRun });
  check(again?.trashedPages === 0 && again.snapshots === 0, "a second run the same day finds nothing to do", again);
  check(
    (await runRetention({ now: new Date(now.getTime() + 400 * DAY), workspaceIds: [] }))?.trashedPages === 0,
    "a run over no workspaces touches nothing",
  );
  check((await existing(id("fresh"), id("outsider"))).every(Boolean), "…really nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  // The files table goes with the workspaces; their bytes don't.
  const left = await db.select({ key: file.storageKey }).from(file).where(inArray(file.workspaceId, workspaceIds));
  for (const { key } of left) await instanceStorage().delete(key).catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
