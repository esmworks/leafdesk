/**
 * End-to-end check of archived pages against the database: the pages under an archived page count
 * as archived, lists and search leave them out unless asked, database rows follow their database
 * or are archived one by one, only full access archives, and the trash, moves and duplicates keep
 * the state right. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-archive-e2e.ts
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
const { archivePage, fullTextSearch, getTree, listChildren, movePage, restorePage } = await import("@/server/pages");
const { getDatabaseSnapshot, listRows } = await import("@/server/databases");
const { mentionCandidates } = await import("@/server/mentions");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { outdatedState, setPageOutdated } = await import("@/server/page-outdated");

const RUN = `archive-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectLostAccess() {},
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

const ids = { owner: `${RUN}-owner`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
// A word only this run's pages carry, for search.
const token = `zq${Date.now().toString(36)}`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.bob, role: "member" },
  ]);
  // A ─ B ─ C, L, database D with rows r1 and r2, template T
  const P = (id: string, parentId: string | null, position: number, extra: Partial<typeof page.$inferInsert> = {}) => ({
    id: `${RUN}-${id}`,
    workspaceId,
    parentId: parentId && `${RUN}-${parentId}`,
    title: `${id} ${token}`,
    position,
    ...extra,
  });
  await db.insert(page).values([P("A", null, 1), P("L", null, 2), P("D", null, 3, { kind: "database" }), P("T", null, 4, { isTemplate: true })]);
  await db.insert(page).values([P("B", "A", 1), P("r1", "D", 1), P("r2", "D", 2)]);
  await db.insert(page).values([P("C", "B", 1)]);
  const [A, B, C, L, D, r1, r2, T] = ["A", "B", "C", "L", "D", "r1", "r2", "T"].map((name) => `${RUN}-${name}`);
  const { owner, bob } = ids;
  const treeIds = async () => new Set((await getTree(owner, workspaceId)).map((n) => n.id));
  const found = async (includeOutdated = false) =>
    new Map((await fullTextSearch(owner, token, { workspaceId, includeOutdated, limit: 50 })).map((h) => [h.id, h.outdated]));
  const edited = async (id: string) => (await db.select({ at: page.updatedAt }).from(page).where(eq(page.id, id)))[0].at.getTime();

  // Archiving a page takes the pages under it along
  const editedBefore = await edited(A);
  await setPageOutdated(owner, A, true);
  const own = await outdatedState(owner, A);
  check(own?.own === true && own.pageId === A && own.by === owner, "the page archived knows who archived it", own);
  const inherited = await outdatedState(owner, C);
  check(inherited?.own === false && inherited.pageId === A && inherited.title === `A ${token}`, "a page two levels down counts as archived through it", inherited);
  check((await outdatedState(owner, L)) === null, "…and a page beside it doesn't");
  check((await edited(A)) === editedBefore, "archiving isn't an edit");

  let tree = await treeIds();
  check(![A, B, C].some((id) => tree.has(id)) && tree.has(L), "the sidebar leaves out the archived page and the pages under it", [...tree]);
  let hits = await found();
  check(![A, B, C].some((id) => hits.has(id)) && hits.get(L) === false, "search leaves them out", [...hits]);
  hits = await found(true);
  check([A, B, C].every((id) => hits.get(id) === true) && hits.get(L) === false, "…and finds them, marked, when asked", [...hits]);
  const picker = (await mentionCandidates(owner, L, token)).pages.map((p) => p.id);
  check(![A, B, C].some((id) => picker.includes(id)) && picker.includes(D), "the mention picker leaves them out", picker);
  const top = (await listChildren(owner, workspaceId, null)).map((p) => p.id);
  check(!top.includes(A) && top.includes(L), "the top-level listing leaves the archived page out", top);
  const topAll = await listChildren(owner, workspaceId, null, { includeOutdated: true });
  check(topAll.find((p) => p.id === A)?.outdated === true, "…and lists it, marked, when asked");
  const under = (await listChildren(owner, workspaceId, A)).map((p) => p.id);
  check(under.join() === B, "the archived page still lists its own subpages", under);

  // Database rows: one by one, or with their database
  await setPageOutdated(owner, r2, true);
  let rows = (await listRows(owner, D)).map((r) => r.id);
  check(rows.join() === r1, "a row archived on its own leaves the database's views", rows);
  rows = (await listRows(owner, D, { showOutdated: true })).map((r) => r.id).sort();
  check(rows.join() === [r1, r2].sort().join(), "…unless the view shows archived rows", rows);
  const snapshot = await getDatabaseSnapshot(owner, D);
  check(snapshot.rows.find((r) => r.id === r2)?.outdated === true && snapshot.rows.find((r) => r.id === r1)?.outdated === false, "the snapshot marks it");
  await setPageOutdated(owner, D, true);
  rows = (await listRows(owner, D)).map((r) => r.id);
  check(rows.join() === r1, "an archived database still shows its live rows in its own views", rows);
  check((await outdatedState(owner, r1))?.pageId === D, "…which count as archived through it");
  check(!(await treeIds()).has(D), "…and the database leaves the sidebar");
  await setPageOutdated(owner, D, false);
  await setPageOutdated(owner, r2, false);

  // Who may archive
  await setPagePermission(owner, L, owner, "full");
  await setPagePermission(owner, L, null, "edit");
  await setPagePermission(owner, A, owner, "full");
  await setPagePermission(owner, A, null, "edit");
  const bobTried = await setPageOutdated(bob, L, true).catch((e) => e);
  check(bobTried instanceof Error && bobTried.name === "AccessError", "edit access can't archive a page", String(bobTried));
  await setPagePermission(owner, L, bob, "full");
  await setPageOutdated(bob, L, true);
  check((await outdatedState(bob, L))?.canUnarchive === true, "full access can, and may unarchive it");
  check((await outdatedState(bob, B))?.canUnarchive === false, "…but not a page above it bob can only edit");
  await setPageOutdated(bob, L, false);
  const templateTried = await setPageOutdated(owner, T, true).catch((e) => e);
  check((templateTried as { code?: string }).code === "template", "a template can't be archived", String(templateTried));

  // Unarchiving brings the pages under it back
  await setPageOutdated(owner, A, false);
  tree = await treeIds();
  check([A, B, C].every((id) => tree.has(id)), "unarchiving brings the subpages back", [...tree]);
  check((await outdatedState(owner, C)) === null, "…as live pages");

  // Unarchiving a page archived through a page above it does nothing
  await setPageOutdated(owner, A, true);
  await setPageOutdated(owner, B, false);
  check((await outdatedState(owner, B))?.pageId === A, "a subpage stays archived while its parent is");

  // The trash keeps it archived
  await archivePage(owner, A);
  const inTrash = await setPageOutdated(owner, A, false).catch((e) => e);
  check((inTrash as { code?: string }).code === "inTrash", "a page in the trash can't be unarchived there");
  await restorePage(owner, A);
  check((await outdatedState(owner, A))?.own === true, "restored from the trash, it is still archived");

  // Moving into and out of an archived page
  await movePage(owner, L, A);
  check((await outdatedState(owner, L))?.pageId === A, "a page moved under an archived page counts as archived");
  check(!(await treeIds()).has(L), "…and leaves the sidebar");
  await movePage(owner, L, null);
  check((await outdatedState(owner, L)) === null && (await treeIds()).has(L), "moved back out, it is live again");

  // A copy of an archived page is archived too
  const copy = await duplicatePage({ userId: owner }, A, " (copy)");
  const [copied] = await db.select({ at: page.outdatedAt, by: page.outdatedBy }).from(page).where(eq(page.id, copy.id));
  check(copied.at !== null && copied.by === owner, "a copy of an archived page is archived", copied);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
