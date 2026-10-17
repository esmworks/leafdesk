/**
 * End-to-end check of the workspace check against the database: links to pages in the trash and
 * deleted for good (and none to pages the reader can't open), orphans and the page that could link
 * them, empty and untouched pages, duplicates by meaning (with a fake embeddings server), relations
 * to rows in the trash or deleted, who may run it, and the fixes it offers. Creates its own users
 * and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/workspace-check-e2e.ts
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
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { archivePage, createPage, deletePagePermanently, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { linkUnlinkedMention } = await import("@/server/mentions");
const { checkWorkspace, removeRelationTarget } = await import("@/server/workspace-check");
const { AccessError } = await import("@/server/access");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
const index = await import("@/server/semantic-index");

const RUN = `wscheck-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
const EMBEDDINGS = { AI_EMBEDDINGS_MODEL: "fake-embed", AI_EMBEDDINGS_BASE_URL: fake.baseUrl, AI_EMBEDDINGS_API_KEY: "local-test" };

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

async function settle(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (index.indexBusy() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  await index.whenIndexIdle();
}

async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof AccessError;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-other`;
const owner = { userId: ids.owner };
const link = (pageId: string) => `[x](/w/${workspaceId}/p/${pageId})`;
const now = new Date();

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  // Without a teamspace pages are private: the member gets them through the page's own sharing.
  const share = async (pageId: string, level: "view" | "edit" = "edit") => setPagePermission(ids.owner, pageId, ids.member, level);

  const home = await createPage(owner, { workspaceId, title: "Home" });
  const notes = await createPage(owner, { workspaceId, parentId: home.id, title: "Meeting notes" });
  const plan = await createPage(owner, { workspaceId, title: "Old plan" });
  const gone = await createPage(owner, { workspaceId, title: "Gone" });
  const secret = await createPage(owner, { workspaceId, title: "Secret" });
  const loose = await createPage(owner, { workspaceId, title: "Hiring pipeline" });
  const blank = await createPage(owner, { workspaceId, title: "Blank idea" });
  const untitled = await createPage(owner, { workspaceId, title: "" });
  const old = await createPage(owner, { workspaceId, parentId: home.id, title: "Q1 offsite" });
  const skill = await createPage(owner, { workspaceId, title: "Review checklist" });
  const fleetA = await createPage(owner, { workspaceId, parentId: home.id, title: "Fleet budget" });
  const fleetB = await createPage(owner, { workspaceId, parentId: home.id, title: "Vehicle spending" });
  const template = await createPage(owner, { workspaceId, title: "Template" });
  for (const p of [home, notes, plan, gone, loose, blank, untitled, old, skill, fleetA, fleetB]) await share(p.id);

  await getCollab().replaceContent(
    notes.id,
    `Follow up on ${link(plan.id)}, ${link(gone.id)} and ${link(secret.id)}.\n\nThe hiring pipeline needs owners.\n\n\`\`\`\n${link(gone.id)}\n\`\`\``,
    owner,
  );
  await getCollab().replaceContent(loose.id, "Candidates and interviews.", owner);
  await getCollab().replaceContent(old.id, "Where we went.", owner);
  await getCollab().replaceContent(skill.id, "Check the tests.", owner);
  await getCollab().replaceContent(home.id, "Start here.", owner);
  await getCollab().replaceContent(fleetA.id, "Our car budget for the fleet: money for vehicles, fuel and repairs this year.", owner);
  await getCollab().replaceContent(fleetB.id, "The automobile spending of the fleet: cash for cars, fuel and repairs this year.", owner);
  await getCollab().replaceContent(template.id, "", owner);
  await db.update(page).set({ isSkill: true }).where(eq(page.id, skill.id));
  await db.update(page).set({ inTemplate: true }).where(eq(page.id, template.id));
  await db.update(page).set({ updatedAt: new Date("2024-01-15T00:00:00Z") }).where(eq(page.id, old.id));
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  await archivePage(ids.owner, plan.id);
  await archivePage(ids.owner, secret.id);
  await archivePage(ids.owner, gone.id);
  await deletePagePermanently(ids.owner, gone.id);

  // A relation to a row in the trash and to one deleted for good.
  const people = await createPage(owner, { workspaceId, kind: "database", title: "People" });
  const projects = await createPage(owner, { workspaceId, kind: "database", title: "Projects" });
  await share(people.id);
  await share(projects.id);
  await databases.addProperty(ids.owner, projects.id, { name: "Team", type: "relation", relation: { databaseId: people.id } });
  const ada = await createPage(owner, { workspaceId, parentId: people.id, title: "Ada" });
  const left = await createPage(owner, { workspaceId, parentId: people.id, title: "Left the team" });
  const removed = await createPage(owner, { workspaceId, parentId: people.id, title: "Removed" });
  const launch = await createPage(owner, {
    workspaceId,
    parentId: projects.id,
    title: "Launch",
    properties: { Team: [ada.id, left.id, removed.id] },
  });
  const team = (await databases.getDatabase(ids.owner, projects.id)).properties.find((p) => p.name === "Team")!;
  await archivePage(ids.owner, left.id);
  await archivePage(ids.owner, removed.id);
  await deletePagePermanently(ids.owner, removed.id);

  const other = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Elsewhere" });
  await getCollab().replaceContent(other.id, `${link(plan.id)}`, { userId: ids.outsider });

  // ---- The owner's check
  setAiEnv({});
  const first = await checkWorkspace(ids.owner, workspaceId, { now });
  const linkTargets = first.brokenLinks.items.map((f) => [f.source.id, f.target.id, f.target.status]);
  check(
    JSON.stringify(linkTargets) === JSON.stringify([[notes.id, plan.id, "trash"], [notes.id, gone.id, "deleted"], [notes.id, secret.id, "trash"]]),
    "links to pages in the trash and deleted for good are broken (not the copy in fenced code)",
    linkTargets,
  );
  const toPlan = first.brokenLinks.items[0].target;
  check(toPlan.status === "trash" && toPlan.title === "Old plan" && toPlan.canRestore, "…a page in the trash is named and can be restored");
  check(!JSON.stringify(first).includes(other.id), "pages of other workspaces aren't checked");

  const orphanIds = first.orphans.items.map((p) => p.id);
  check(orphanIds.includes(loose.id), "a top-level page nothing links to is an orphan", first.orphans);
  check(
    ![home.id, notes.id, blank.id, untitled.id, skill.id, people.id, template.id].some((id) => orphanIds.includes(id)),
    "…not a page with pages inside, a page under another, an empty page, a skill, a database or a template",
    first.orphans,
  );
  const looseFinding = first.orphans.items.find((p) => p.id === loose.id);
  check(looseFinding?.linkFrom?.id === notes.id, "…and the page that writes its title is offered to link it", looseFinding);

  check(
    first.empty.items.map((p) => p.id).join() === blank.id,
    "a page with a title and no body is empty; an untitled one and database rows aren't",
    first.empty,
  );
  check(
    first.stale.items.map((p) => p.id).join() === old.id && first.staleMonths === 6,
    "a page nobody edited for six months is untouched",
    first.stale,
  );
  check(
    (await checkWorkspace(ids.owner, workspaceId, { now: new Date("2024-03-01T00:00:00Z"), staleMonths: 3 })).stale.total === 0,
    "…counted from now, by the months asked",
  );

  const relationTargets = first.brokenRelations.items.map((f) => [f.row.id, f.property.name, f.target.id, f.target.status, f.canFix]);
  check(
    JSON.stringify(relationTargets) === JSON.stringify([[launch.id, "Team", left.id, "trash", true], [launch.id, "Team", removed.id, "deleted", true]]),
    "relations to a row in the trash and one deleted for good are broken",
    relationTargets,
  );
  check(first.duplicates.status === "skipped" && first.duplicates.reason === "noEmbeddings", "without embeddings, duplicates aren't checked");

  // ---- Duplicates by meaning
  setAiEnv(EMBEDDINGS);
  for (const p of [home, notes, loose, old, skill, fleetA, fleetB]) await index.indexPage(p.id);
  const withEmbeddings = await checkWorkspace(ids.owner, workspaceId, { now, minSimilarity: 0.8 });
  check(withEmbeddings.duplicates.status === "done", "with embeddings, duplicates are checked", withEmbeddings.duplicates);
  const pairs = withEmbeddings.duplicates.items.map((d) => [d.a.id, d.b.id].sort().join());
  check(pairs.includes([fleetA.id, fleetB.id].sort().join()), "two pages saying nearly the same thing are a pair", withEmbeddings.duplicates);
  check(pairs.length === 1, "…and only those", withEmbeddings.duplicates);
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: false });
  const aiOff = await checkWorkspace(ids.owner, workspaceId, { now });
  check(aiOff.duplicates.status === "skipped" && aiOff.duplicates.reason === "aiOff", "with AI off in the workspace, they aren't");
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: true });

  // ---- Other people
  const asMember = await checkWorkspace(ids.member, workspaceId, { now });
  check(!JSON.stringify(asMember).includes(secret.id), "a member never hears of a page they can't open, not even as a broken link", asMember.brokenLinks);
  check(asMember.brokenLinks.total === 2, "…the other broken links are theirs too", asMember.brokenLinks);
  check(
    await refused(() => checkWorkspace(ids.guest, workspaceId)),
    "guests can't check the workspace",
  );
  check(await refused(() => checkWorkspace(ids.outsider, workspaceId)), "nor can someone outside it");

  // ---- Fixes, with the person's own access
  // Members get pages outside teamspaces in full unless the page says otherwise.
  await setPagePermission(ids.owner, notes.id, ids.owner, "full");
  await setPagePermission(ids.owner, notes.id, null, "none");
  await share(notes.id, "view");
  check(await refused(() => linkUnlinkedMention(ids.member, notes.id, loose.id)), "linking needs edit access to the page that writes the title");
  check(await linkUnlinkedMention(ids.owner, notes.id, loose.id), "the orphan is linked where its title is written");
  await restorePage(ids.owner, plan.id);
  check(await removeRelationTarget(ids.owner, launch.id, team.id, removed.id), "a deleted row leaves the relation");
  check(!(await removeRelationTarget(ids.owner, launch.id, team.id, removed.id)), "…once");
  const [launchAfter] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, launch.id));
  check(
    JSON.stringify(launchAfter.properties[team.id]) === JSON.stringify([ada.id, left.id]),
    "…keeping the relation's other rows, the one in the trash too",
    launchAfter.properties,
  );
  const after = await checkWorkspace(ids.owner, workspaceId, { now });
  check(!after.orphans.items.some((p) => p.id === loose.id), "after the fixes the orphan is linked", after.orphans);
  check(
    after.brokenLinks.items.map((f) => f.target.id).join() === [gone.id, secret.id].join(),
    "…the restored page's link isn't broken any more",
    after.brokenLinks,
  );
  check(after.brokenRelations.items.map((f) => f.target.id).join() === left.id, "…and the deleted row is out of the relation", after.brokenRelations);

  console.log(`\n${passed} checks passed`);
} finally {
  // Edits above queue pages for indexing: let that finish before their workspace goes.
  await settle().catch(() => {});
  setAiEnv({});
  await fake.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
