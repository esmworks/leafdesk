/**
 * End-to-end check of personal views (databaseView.ownerId) against the database: someone who may
 * only read a database makes views of their own, which nobody else sees, changes or finds in the
 * sidebar, and which a locked database doesn't hold; shared views stay the editors'; a personal
 * view is never published or copied with the database, can't be a form, can be shared with everyone
 * by someone who may change the views, and goes when its person leaves the workspace. Creates its
 * own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/personal-views-e2e.ts
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
const { databaseView, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { createPage, getTree } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { readableViews } = await import("@/server/publication");
const { removeMember } = await import("@/server/workspaces");

const RUN = `personal-views-e2e-${Date.now().toString(36)}`;
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

/** "resolved", or the error's code (its class name without one). */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).constructor.name;
  }
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, reader: `${RUN}-reader` };
const workspaceId = `${RUN}-ws`;
const viewNames = async (userId: string, databaseId: string) => (await databases.getDatabase(userId, databaseId)).views.map((v) => v.name);

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.reader, role: "member" },
  ]);
  const tasks = await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Tasks" });
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "none");
  await setPagePermission(ids.owner, tasks.id, ids.editor, "edit");
  await setPagePermission(ids.owner, tasks.id, ids.reader, "view");
  const [shared] = (await databases.getDatabase(ids.owner, tasks.id)).views;

  // Someone who may only read the database makes views of their own.
  check((await outcome(() => databases.addView(ids.reader, tasks.id, { name: "Team", type: "board" }))) === "AccessError", "a reader can't add a shared view");
  const mine = await databases.addView(ids.reader, tasks.id, { name: "Mine", type: "table", personal: true });
  check(mine.ownerId === ids.reader, "a reader adds a personal view");
  check(
    (await outcome(() => databases.addView(ids.reader, tasks.id, { name: "Ask", type: "form", personal: true }))) === "unsupportedViewType",
    "a personal view can't be a form",
  );
  check((await viewNames(ids.reader, tasks.id)).includes("Mine"), "its person sees it");
  check(!(await viewNames(ids.editor, tasks.id)).includes("Mine") && !(await viewNames(ids.owner, tasks.id)).includes("Mine"), "nobody else sees it");
  const readerTree = JSON.stringify(await getTree(ids.reader, workspaceId));
  const editorTree = JSON.stringify(await getTree(ids.editor, workspaceId));
  check(readerTree.includes(mine.id) && !editorTree.includes(mine.id), "only its person finds it in the sidebar");

  // Its person changes it; nobody else can, and the shared views stay the editors'.
  await databases.updateView(ids.reader, mine.id, { name: "My open tasks", config: { sorts: [{ propertyId: "title", direction: "asc" }] } });
  check((await viewNames(ids.reader, tasks.id)).includes("My open tasks"), "its person renames and sets it up");
  check((await outcome(() => databases.updateView(ids.editor, mine.id, { name: "Taken" }))) === "AccessError", "an editor can't change someone's personal view");
  check((await outcome(() => databases.deleteView(ids.owner, mine.id))) === "AccessError", "an owner can't delete someone's personal view");
  check((await outcome(() => databases.updateView(ids.reader, shared.id, { name: "Changed" }))) === "AccessError", "a reader still can't change a shared view");

  // A locked database holds the shared views, not the personal ones.
  await databases.setDatabaseLocked(ids.owner, tasks.id, true);
  check((await outcome(() => databases.addView(ids.editor, tasks.id, { name: "Locked", type: "table" }))) === "databaseLocked", "a locked database takes no new shared view");
  const second = await databases.addView(ids.reader, tasks.id, { name: "Scratch", type: "list", personal: true });
  await databases.updateView(ids.reader, second.id, { name: "Scratch 2" });
  check((await viewNames(ids.reader, tasks.id)).includes("Scratch 2"), "personal views are added and renamed on a locked database");
  await databases.setDatabaseLocked(ids.owner, tasks.id, false);

  // The last shared view stays, whatever personal views there are; personal ones go freely.
  check((await outcome(() => databases.deleteView(ids.owner, shared.id))) === "lastView", "the last shared view can't be deleted");
  await databases.deleteView(ids.reader, second.id);
  check(!(await viewNames(ids.reader, tasks.id)).includes("Scratch 2"), "a personal view is deleted by its person");

  // Never published or copied with the database.
  check(!(await readableViews(tasks.id)).some((v) => v.id === mine.id), "a personal view is never published");
  const copy = await duplicatePage({ userId: ids.owner }, tasks.id);
  const copied = await db.select().from(databaseView).where(eq(databaseView.databaseId, copy.id));
  check(copied.length === 1 && copied.every((v) => v.ownerId === null), "a copy of the database gets the shared views only", copied.map((v) => v.name));

  // Shared with everyone by someone who may change the views.
  const draft = await databases.addView(ids.editor, tasks.id, { name: "Draft", type: "board", personal: true });
  check((await outcome(() => databases.updateView(ids.reader, mine.id, { personal: false }))) === "AccessError", "a reader can't share their view");
  await databases.updateView(ids.editor, draft.id, { personal: false });
  check((await viewNames(ids.owner, tasks.id)).includes("Draft") && (await viewNames(ids.reader, tasks.id)).includes("Draft"), "an editor shares a personal view with everyone");

  // Leaving the workspace takes them along.
  await removeMember(ids.owner, workspaceId, ids.reader);
  check((await db.select().from(databaseView).where(eq(databaseView.id, mine.id))).length === 0, "personal views go when their person leaves");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
