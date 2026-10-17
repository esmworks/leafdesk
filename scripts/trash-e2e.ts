/**
 * End-to-end check of the trash against the database: restoring brings back only what was trashed
 * together, and the sidebar tree and trash list carry the user's access level so the UI only offers
 * what the server allows. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/trash-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { archivePage, createPage, getTree, listTrash, lockLiveParent, movePage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");

const RUN = `trash-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

async function archived(...pageIds: string[]) {
  const rows = await db.select({ id: page.id, archivedAt: page.archivedAt }).from(page).where(inArray(page.id, pageIds));
  return pageIds.map((id) => rows.find((r) => r.id === id)?.archivedAt !== null);
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.bob, role: "member" },
  ]);
  // A ─ B ─ C, A ─ D
  const P = (id: string, parentId: string | null, position: number) => ({
    id: `${RUN}-${id}`,
    workspaceId,
    parentId: parentId && `${RUN}-${parentId}`,
    title: id,
    position,
  });
  await db.insert(page).values([P("A", null, 1)]);
  await db.insert(page).values([P("B", "A", 1), P("D", "A", 2)]);
  await db.insert(page).values([P("C", "B", 1)]);
  const [A, B, C, D] = ["A", "B", "C", "D"].map((name) => `${RUN}-${name}`);
  const { owner, bob } = ids;

  // Restore only brings back what was trashed together
  await archivePage(owner, B);
  // Timestamps must differ for the two trash entries.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await archivePage(owner, A);
  check((await archived(A, B, C, D)).join() === "true,true,true,true", "the whole tree is in the trash");
  check(
    (await listTrash(owner, workspaceId)).map((r) => r.id).join() === [A, B].join(),
    "the earlier-trashed subpage is its own trash entry",
  );
  await restorePage(owner, A);
  check(
    (await archived(A, B, C, D)).join() === "false,true,true,false",
    "restoring the parent leaves the separately trashed subpage in the trash",
  );
  check((await listTrash(owner, workspaceId)).map((r) => r.id).join() === B, "…where it is still listed");
  await restorePage(owner, B);
  check((await archived(A, B, C, D)).join() === "false,false,false,false", "restoring it brings back its own subpages");

  // Access levels in the tree and the trash
  await setPagePermission(owner, A, owner, "full");
  await setPagePermission(owner, A, null, "edit");
  await setPagePermission(owner, D, null, "view");
  const tree = new Map((await getTree(bob, workspaceId)).map((n) => [n.id, n.level]));
  check(tree.get(A) === "edit" && tree.get(C) === "edit" && tree.get(D) === "view", "tree nodes carry the level", [
    ...tree,
  ]);
  check((await getTree(owner, workspaceId)).every((n) => n.level === "full"), "…full for the owner");
  await archivePage(owner, D);
  await archivePage(owner, B);
  const trash = new Map((await listTrash(bob, workspaceId)).map((r) => [r.id, r.level]));
  check(trash.get(B) === "edit" && trash.get(D) === "view", "trash entries carry the level", [...trash]);

  // Nothing goes under a page in the trash: it would be hidden there, and deleted with it
  const code = (error: unknown) => (error as { code?: string }).code;
  await restorePage(owner, D);
  check(code(await movePage(owner, D, B).catch((e) => e)) === "parentInTrash", "a page can't be moved under a page in the trash");
  check(code(await movePage(owner, D, C).catch((e) => e)) === "parentInTrash", "…nor under a page trashed with it");
  check(code(await createPage({ userId: owner }, { workspaceId, parentId: C, title: "New" }).catch((e) => e)) === "parentInTrash", "…and none is added there");
  check((await archived(D)).join() === "false" && (await db.select().from(page).where(eq(page.id, D)))[0].parentId === A, "…so it stays where it was");
  // A move that holds its new parent while that parent goes to the trash: the trash takes it along.
  await restorePage(owner, B);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const moving = db.transaction(async (tx) => {
    await lockLiveParent(tx, C);
    await tx.update(page).set({ parentId: C }).where(eq(page.id, D));
    await held;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const trashing = archivePage(owner, B);
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await Promise.all([moving, trashing]);
  check((await archived(B, C, D)).join() === "true,true,true", "a page moved under one while it goes to the trash goes along", await archived(B, C, D));
  await restorePage(owner, B);
  check((await archived(B, C, D)).join() === "false,false,false", "…and comes back with it");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
