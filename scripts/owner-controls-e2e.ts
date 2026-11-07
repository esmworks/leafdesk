/**
 * End-to-end check against the database of what owners can keep to themselves (Settings →
 * Security): exporting (`exportBy`), connected apps (`connectedAppsBy`) and deleting for good
 * (`deleteForever`), and the notice they get when someone else trashes many rows of a database
 * (server/mass-trash.ts). The member here has full access to the database, as members of a
 * teamspace giving full access do. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/owner-controls-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No server needed.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseProperty, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { requirePageAccess, workspacesHiddenFromApp } = await import("@/server/access");
const { runAsConnectedApp } = await import("@/server/connected-app");
const { assertExportAllowed } = await import("@/server/export");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { archivePage, archiveRows, deletePagePermanently, listTrash, restorePage } = await import("@/server/pages");
const { addProperty, deleteProperty, purgeProperty } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { exportAllowed, updateWorkspaceSettings } = await import("@/server/workspaces");
const { MASS_TRASH_ROWS } = await import("@/lib/mass-trash");

const RUN = `owner-controls-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab(
  new Proxy({}, { get: () => async () => undefined }) as unknown as Parameters<typeof registerCollab>[0],
);

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
const code = (error: unknown) => (error as { code?: string } | undefined)?.code;
const refused = async (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

const ids = { owner: `${RUN}-owner`, other: `${RUN}-owner2`, admin: `${RUN}-admin`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const { owner, other, admin, bob } = ids;

/** A database of `rows` rows at the top of the workspace, everyone in it with full access. */
async function database(name: string, rows: number) {
  const id = `${RUN}-${name}`;
  await db.insert(page).values({ id, workspaceId, parentId: null, title: name, kind: "database", position: 1, createdBy: owner });
  await db.insert(page).values(
    Array.from({ length: rows }, (_, i) => ({ id: `${id}-r${i}`, workspaceId, parentId: id, title: `Customer ${i}`, position: i, createdBy: owner })),
  );
  await setPagePermission(owner, id, owner, "full");
  await setPagePermission(owner, id, null, "full");
  return { id, rowIds: Array.from({ length: rows }, (_, i) => `${id}-r${i}`) };
}

async function notices(databaseId: string) {
  return db
    .select({ userId: notification.userId, actorId: notification.actorId, message: notification.message })
    .from(notification)
    .where(and(eq(notification.kind, "mass_trash"), eq(notification.pageId, databaseId)));
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: other, role: "owner" },
    { workspaceId, userId: admin, role: "membership_admin" },
    { workspaceId, userId: bob, role: "member" },
  ]);
  const customers = await database("customers", 30);

  // Export
  check((await exportAllowed(workspaceId, bob)) && (await exportAllowed(workspaceId, owner)), "everyone may export by default");
  await updateWorkspaceSettings(owner, workspaceId, { exportBy: "owners" });
  check(!(await exportAllowed(workspaceId, bob)) && !(await exportAllowed(workspaceId, admin)), "only owners: members and membership admins may not");
  check(await exportAllowed(workspaceId, owner), "…owners still may");
  check(code(await refused(assertExportAllowed(workspaceId, bob))) === "disabled", "…the export routes refuse the member");
  check((await getPageHeaderInfo(bob, customers.id)).exportable === false, "…whose page menu offers no export");
  check((await getPageHeaderInfo(owner, customers.id)).exportable === true, "…while the owner's does");
  await updateWorkspaceSettings(owner, workspaceId, { export: false });
  check(!(await exportAllowed(workspaceId, owner)), "export off holds owners too");
  await updateWorkspaceSettings(owner, workspaceId, { export: true, exportBy: "everyone" });
  check(await exportAllowed(workspaceId, bob), "back to everyone");

  // Connected apps
  const asApp = (userId: string) => runAsConnectedApp({ userId }, () => requirePageAccess(userId, customers.id, "view"));
  check((await asApp(bob)).id === customers.id, "a member's app reaches the workspace by default");
  await updateWorkspaceSettings(owner, workspaceId, { connectedAppsBy: "owners" });
  check((await refused(asApp(bob))) instanceof Error, "only owners' apps: the member's app finds the database hidden");
  check((await runAsConnectedApp({ userId: bob }, () => workspacesHiddenFromApp(bob))).has(workspaceId), "…and the workspace left out of its lists");
  check((await asApp(owner)).id === customers.id, "…the owner's app still reaches it");
  check(!(await runAsConnectedApp({ userId: owner }, () => workspacesHiddenFromApp(owner))).has(workspaceId), "…and lists it");
  check((await requirePageAccess(bob, customers.id, "view")).id === customers.id, "the member still opens it in the app itself");
  await updateWorkspaceSettings(owner, workspaceId, { connectedAppsBy: "everyone" });

  // Deleting for good
  const row = customers.rowIds[0];
  await archivePage(bob, row);
  check((await listTrash(bob, workspaceId)).find((t) => t.id === row)?.mayDeleteForever === true, "full access deletes for good by default");
  await updateWorkspaceSettings(owner, workspaceId, { deleteForever: "owners" });
  check((await listTrash(bob, workspaceId)).find((t) => t.id === row)?.mayDeleteForever === false, "only owners: the trash offers the member no Delete forever");
  check((await getPageHeaderInfo(bob, row)).deletesForever === false, "…nor does the trashed row's page");
  check(code(await refused(deletePagePermanently(bob, row))) === "deleteForeverOwners", "…and deleting it for good is refused");
  check((await db.select({ id: page.id }).from(page).where(eq(page.id, row))).length === 1, "…so the row is still there");
  check((await getPageHeaderInfo(owner, row)).deletesForever === true, "the owner is offered it");
  await restorePage(bob, row);
  check((await db.select({ a: page.archivedAt }).from(page).where(eq(page.id, row)))[0]?.a === null, "the member still restores from the trash");

  // A deleted property's values go for good the same way.
  const phone = await addProperty(owner, customers.id, { name: "Phone", type: "text" } as Parameters<typeof addProperty>[2]);
  await deleteProperty(bob, phone.id);
  check(code(await refused(purgeProperty(bob, phone.id))) === "deleteForeverOwners", "a deleted property's values aren't purged by the member");
  await purgeProperty(owner, phone.id);
  check((await db.select({ id: databaseProperty.id }).from(databaseProperty).where(eq(databaseProperty.id, phone.id))).length === 0, "…the owner purges them");

  // Rows trashed in bulk
  const few = customers.rowIds.slice(1, MASS_TRASH_ROWS - 1);
  await archiveRows(bob, customers.id, few);
  check((await notices(customers.id)).length === 0, `fewer than ${MASS_TRASH_ROWS} rows: owners aren't told`);
  await archivePage(bob, customers.rowIds[MASS_TRASH_ROWS - 1]);
  await archivePage(bob, customers.rowIds[MASS_TRASH_ROWS]);
  const told = await notices(customers.id);
  check(
    told.length === 2 && told.every((n) => n.actorId === bob && n.message === `rows:${MASS_TRASH_ROWS}`) && told.map((n) => n.userId).sort().join() === [owner, other].sort().join(),
    "the twentieth row, one by one, tells both owners",
    told,
  );
  await archiveRows(bob, customers.id, customers.rowIds.slice(MASS_TRASH_ROWS + 1));
  check((await notices(customers.id)).length === 2, "…once an hour per person and database");

  const ownersOwn = await database("owners-own", 25);
  await archiveRows(owner, ownersOwn.id, ownersOwn.rowIds);
  check((await notices(ownersOwn.id)).length === 0, "an owner's own trashing isn't told");

  const whole = await database("whole", 25);
  await archivePage(bob, whole.id);
  const wholeTold = await notices(whole.id);
  check(wholeTold.length === 2 && wholeTold.every((n) => n.message === "database:25"), "a database trashed with its rows tells the owners", wholeTold);

  const small = await database("small", 5);
  await archivePage(bob, small.id);
  check((await notices(small.id)).length === 0, "…not a small one");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
