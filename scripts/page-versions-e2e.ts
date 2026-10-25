/**
 * End-to-end check of named page versions (server/page-versions.ts): saving the page as a version
 * with a name or without, naming the newest version instead of saving a copy when nothing changed,
 * renaming and clearing a name, the list of named versions only, the name where history is read by
 * apps (list_page_history, get_page_version), and who may save and name: people who can edit the
 * page, a locked page included, not one in the trash. Creates its own users and workspace and
 * deletes them afterwards.
 *
 *   pnpm tsx scripts/page-versions-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No app server needed.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
const { MAX_VERSION_NAME } = await import("@/lib/page-versions");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, listSnapshots, restorePage, setPageLocked } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { AccessError } = await import("@/server/access");
const { renameVersion, saveVersion, versionSaveState } = await import("@/server/page-versions");
const ops = await import("@/server/operations");

const RUN = `versions-e2e-${Date.now().toString(36)}`;

// The real collab service: versions are saved from the live document as the app's are.
const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError) return "access";
    return String((error as { code?: unknown }).code ?? (error as Error).message);
  }
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer` };
const workspaceId = `${RUN}-ws`;

async function versionsOf(pageId: string) {
  return db
    .select({ id: pageSnapshot.id, reason: pageSnapshot.reason, name: pageSnapshot.name, createdBy: pageSnapshot.createdBy })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.pageId, pageId));
}

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);
  const owner = { userId: ids.owner };
  const editor = { userId: ids.editor };

  const plan = await createPage(owner, { workspaceId, title: "Plan" });
  await setPagePermission(ids.owner, plan.id, ids.owner, "full");
  await setPagePermission(ids.owner, plan.id, null, "none");
  await setPagePermission(ids.owner, plan.id, ids.editor, "edit");
  await setPagePermission(ids.owner, plan.id, ids.viewer, "view");
  await service.replaceContent(plan.id, "# Goals\n\nShip it.", owner);
  // The write was saved as an autosave version, which is the page as it is now.
  const [autosave] = await versionsOf(plan.id);
  const fresh = await versionSaveState(ids.editor, plan.id);
  check(autosave && !fresh.changed && fresh.latest?.id === autosave.id && fresh.latest.name === null, "the newest version, an autosave, is the page as it is: offered for naming", fresh);

  // Saving
  await service.appendContent(plan.id, "Then celebrate.", owner);
  const before = (await versionsOf(plan.id)).length;
  check((await versionSaveState(ids.editor, plan.id)).changed, "after a change, saving keeps a new version");
  const first = await saveVersion(editor, plan.id, "  Sent\nfor review ");
  check(!first.renamed && first.name === "Sent for review", "saving with a name keeps a new version under the name, tidied", first);
  const saved = (await versionsOf(plan.id)).find((v) => v.id === first.id);
  check(saved?.reason === "manual" && saved.name === "Sent for review" && saved.createdBy === ids.editor, "…as a saved version by who saved it", saved);
  check((await versionsOf(plan.id)).length === before + 1, "…and only that one");

  // Nothing changed since: the newest version is named instead of copied
  const state = await versionSaveState(ids.editor, plan.id);
  check(!state.changed && state.latest?.id === first.id && state.latest.name === "Sent for review", "with nothing changed, the newest version is offered for naming", state);
  const again = await saveVersion(editor, plan.id, "Approved");
  check(again.renamed && again.id === first.id, "saving again without changes names the newest version instead", again);
  check((await versionsOf(plan.id)).length === before + 1, "…without saving a copy");
  check((await versionsOf(plan.id)).find((v) => v.id === first.id)?.name === "Approved", "…which now has the new name");

  // A change since: a new version, unnamed when the name is empty
  await service.appendContent(plan.id, "More to do.", owner);
  const unnamed = await saveVersion(editor, plan.id, "   ");
  check(!unnamed.renamed && unnamed.id !== first.id && unnamed.name === null, "after a change, an empty name saves a new unnamed version", unnamed);

  // Renaming and clearing
  const renamed = await renameVersion(ids.editor, unnamed.id, "Draft 2");
  check(renamed.name === "Draft 2", "an editor names any saved version", renamed);
  check((await renameVersion(ids.owner, first.id, "")).name === null, "an empty name clears a version's name");
  check((await failure(() => renameVersion(ids.editor, unnamed.id, "x".repeat(MAX_VERSION_NAME + 1)))) === "invalidVersionName", "a name too long is refused");
  check((await failure(() => saveVersion(editor, plan.id, 42))) === "invalidVersionName", "…as is a name that isn't text");

  // Lists and apps
  const all = await listSnapshots(ids.viewer, plan.id);
  check(all.find((v) => v.id === unnamed.id)?.name === "Draft 2", "the history lists the name, to anyone who can view the page");
  const named = await listSnapshots(ids.viewer, plan.id, { named: true });
  check(named.length === 1 && named[0].id === unnamed.id, "the named list holds only named versions", named);
  const ctx = { userId: ids.viewer } as Parameters<typeof ops.listPageHistory>[0];
  const history = await ops.listPageHistory(ctx, { page_id: plan.id });
  const listed = history.versions.find((v) => v.id === unnamed.id);
  check(listed && "name" in listed && listed.name === "Draft 2", "list_page_history gives a version's name", listed);
  check(history.versions.filter((v) => "name" in v).length === 1, "…and none for unnamed versions");
  const read = await ops.getPageVersion(ctx, { version_id: unnamed.id, offset: 0 });
  check("name" in read && read.name === "Draft 2", "get_page_version gives it too", read);

  // Who may save and name
  check((await failure(() => saveVersion({ userId: ids.viewer }, plan.id, "Mine"))) === "access", "someone who may only view can't save a version");
  check((await failure(() => renameVersion(ids.viewer, unnamed.id, "Mine"))) === "access", "…nor name one");
  check((await failure(() => versionSaveState(ids.viewer, plan.id))) === "access", "…nor ask what saving would do");
  await setPageLocked(ids.owner, plan.id, true);
  check((await renameVersion(ids.editor, unnamed.id, "Frozen")).name === "Frozen", "a locked page's versions can be named");
  const lockedSave = await saveVersion(editor, plan.id, "Locked");
  check(lockedSave.renamed && lockedSave.id === unnamed.id && lockedSave.name === "Locked", "…and saved, here naming the newest as nothing changed", lockedSave);
  await setPageLocked(ids.owner, plan.id, false);
  await archivePage(ids.owner, plan.id);
  check((await failure(() => saveVersion(editor, plan.id, "Trashed"))) === "pageInTrash", "a page in the trash can't be saved as a version");
  check((await failure(() => renameVersion(ids.editor, unnamed.id, "Trashed"))) === "pageInTrash", "…nor its versions named");
  await restorePage(ids.owner, plan.id);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(page).where(eq(page.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await hocuspocus.closeConnections?.();
  process.exit(process.exitCode ?? 0);
}
