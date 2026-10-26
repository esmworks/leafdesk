/**
 * End-to-end check of My tasks and of turning a page into a teamspace, against the database.
 *
 * My tasks (server/assigned.ts): rows a person property names the viewer in, across databases,
 * only where the viewer may open the row (rows of databases they can't open never appear, a row
 * shared on its own does, without its database's name), done rows left out, grouped by due date,
 * marking a row done from the list (the first "done" option) and putting it back, and who may.
 *
 * Turning a page into a teamspace (server/teamspace-from-page.ts): who may, what the dialog is
 * told, the page and the pages under it becoming the teamspace's top-level pages (trashed ones
 * staying under the page), who joins as owner or member, nobody named on the page losing or
 * gaining access, how open the teamspace is, the audit log and the sidebar.
 *
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/my-tasks-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, page, teamspace, teamspaceGroup, teamspaceMember, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { createPage, getSidebar } = await import("@/server/pages");
const { addProperty, createRows, getProperties, updateRowProperties } = await import("@/server/databases");
const { setPagePermission, setPageGroupPermission } = await import("@/server/permissions");
const { createGroup } = await import("@/server/groups");
const { createTeamspace, TeamspaceError, updateTeamspace } = await import("@/server/teamspaces");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { AssignedRowError, assignedRows, markAssignedDone, MY_TASKS_LIMIT } = await import("@/server/assigned");
const { previewTeamspaceFromPage, turnPageIntoTeamspace } = await import("@/server/teamspace-from-page");

const RUN = `my-tasks-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
const broadcasts: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast(room: string, what: string) {
    broadcasts.push(`${room}:${what}`);
  },
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
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

async function rejects(fn: () => Promise<unknown>, test: (error: unknown) => boolean, label: string) {
  try {
    await fn();
  } catch (error) {
    check(test(error), label, String(error));
    return;
  }
  check(false, label, "did not throw");
}

const isCode = (code: string) => (error: unknown) => error instanceof TeamspaceError && error.code === code;
const isAccessError = (error: unknown) => error instanceof AccessError;

async function levels(pageId: string, ...userIds: string[]) {
  return (await Promise.all(userIds.map(async (id) => (await resolvePageAccess(id, pageId)).level))).join();
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  dave: `${RUN}-dave`,
  erin: `${RUN}-erin`,
  guest: `${RUN}-guest`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const { owner, alice, bob, carol, dave, erin, guest } = ids;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: dave, role: "member" },
    { workspaceId, userId: erin, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
  ]);

  // ── My tasks ───────────────────────────────────────────────────────────────────────────────
  // Tasks: in the General teamspace, open to every member.
  const tasks = await createPage({ userId: owner }, { workspaceId, kind: "database", title: `${RUN} Tasks` });
  await addProperty(owner, tasks.id, { name: "Due", type: "date" });
  await addProperty(owner, tasks.id, { name: "Owner", type: "person" });
  await addProperty(owner, tasks.id, { name: "Reviewer", type: "person" });
  const props = await getProperties(tasks.id);
  const byName = (name: string) => props.find((p) => p.name === name)!;
  const status = byName("Status");
  const option = (group: string) => status.options.options!.find((o) => o.group === group)!.id;
  const [due, ownerProp, reviewer] = [byName("Due").id, byName("Owner").id, byName("Reviewer").id];
  const [overdue, dueToday, done, bobs, undated, closedOff] = await createRows(owner, tasks.id, [
    { title: "Overdue", properties: { [ownerProp]: [alice], [status.id]: option("todo"), [due]: day(-2) } },
    { title: "Due today", properties: { [reviewer]: [alice], [status.id]: option("in_progress"), [due]: today } },
    { title: "Done already", properties: { [ownerProp]: [alice], [status.id]: option("done"), [due]: day(-1) } },
    { title: "Bob's", properties: { [ownerProp]: [bob], [due]: today } },
    { title: "Undated", properties: { [ownerProp]: [alice, bob] } },
    { title: "Closed off", properties: { [ownerProp]: [alice] } },
  ]).then((rows) => rows.map((r) => r.id));
  // A row closed to everyone but those named on it: alice isn't, so it isn't hers to see.
  await setPagePermission(owner, closedOff, owner, "full");
  await setPagePermission(owner, closedOff, null, "none");

  // Bob's private database: alice can't open it, so its rows never show, unless one is shared with her.
  const secret = await createPage({ userId: bob }, { workspaceId, kind: "database", title: `${RUN} Secret`, teamspaceId: null });
  await addProperty(bob, secret.id, { name: "Owner", type: "person" });
  const secretOwner = (await getProperties(secret.id)).find((p) => p.name === "Owner")!.id;
  const [hidden, shared] = await createRows(bob, secret.id, [
    { title: "Hidden", properties: { [secretOwner]: [alice] } },
    { title: "Shared row", properties: { [secretOwner]: [alice, guest] } },
  ]).then((rows) => rows.map((r) => r.id));
  await setPagePermission(bob, shared, alice, "view");
  await setPagePermission(bob, shared, guest, "view");

  // Notes: a database without a status, so nothing marks its rows done.
  const notes = await createPage({ userId: owner }, { workspaceId, kind: "database", title: `${RUN} Notes` });
  await addProperty(owner, notes.id, { name: "Who", type: "person" });
  const notesStatus = (await getProperties(notes.id)).find((p) => p.type === "status");
  if (notesStatus) {
    const { deleteProperty } = await import("@/server/databases");
    await deleteProperty(owner, notesStatus.id);
  }
  const who = (await getProperties(notes.id)).find((p) => p.name === "Who")!.id;
  const [note] = await createRows(owner, notes.id, [{ title: "A note", properties: { [who]: [alice] } }]).then((rows) => rows.map((r) => r.id));

  const mine = await assignedRows(alice, workspaceId, today, "UTC", MY_TASKS_LIMIT);
  const listed = mine.groups.flatMap((g) => g.rows).filter((r) => r.type === "row");
  const listedIds = new Set(listed.map((r) => r.id));
  check(listedIds.has(overdue) && listedIds.has(dueToday) && listedIds.has(undated) && listedIds.has(note), "rows naming alice in any person property are listed", [...listedIds]);
  check(!listedIds.has(done), "done rows are left out");
  check(!listedIds.has(bobs), "rows naming only someone else are left out");
  check(!listedIds.has(closedOff), "a row closed to alice is left out though it names her");
  check(!listedIds.has(hidden), "rows of a database alice can't open never appear");
  check(listedIds.has(shared), "…but a row of it shared with her does");
  check(listed.find((r) => r.id === shared)?.databaseTitle === null, "…without its database's name");
  check(mine.total === listed.length, "the total counts what is listed when nothing is cut", mine.total);
  check(
    JSON.stringify(mine.groups.map((g) => [g.key, g.rows.map((r) => r.id)])) ===
      JSON.stringify([["overdue", [overdue]], ["today", [dueToday]], ["none", mine.groups.find((g) => g.key === "none")!.rows.map((r) => r.id)]]) &&
      mine.groups.find((g) => g.key === "none")!.rows.length === 3,
    "grouped by due date: overdue, today, then the rows without a date",
    mine.groups.map((g) => [g.key, g.rows.map((r) => (r.type === "row" ? r.title : r.text))]),
  );
  const markable = new Map(listed.map((r) => [r.id, r.markable]));
  check(markable.get(overdue) && markable.get(dueToday) && markable.get(undated), "rows alice may edit with a status can be marked done");
  check(markable.get(shared) === false, "…not a row she may only view");
  check(markable.get(note) === false, "…nor one without a status");
  check(listed.find((r) => r.id === dueToday)?.status?.id === option("in_progress"), "a row's status comes along");
  check(listed.find((r) => r.id === overdue)?.date === day(-2), "…and its first date");
  const capped = await assignedRows(alice, workspaceId, today, "UTC", 2);
  check(capped.groups.flatMap((g) => g.rows).length === 2 && capped.total === listed.length, "a cap keeps the rows due first and says how many there are", capped);
  check(capped.groups.flatMap((g) => g.rows.map((r) => r.id)).join() === [overdue, dueToday].join(), "…the overdue and today's");

  const marked = await markAssignedDone(alice, overdue);
  const [afterMark] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, overdue));
  check(afterMark.properties[status.id] === option("done"), "marking done sets the status to the first option of the done group", afterMark.properties);
  check(marked.propertyId === status.id && marked.previous === option("todo"), "…and says what it was, to put it back", marked);
  check(!(await assignedRows(alice, workspaceId, today)).groups.flatMap((g) => g.rows).some((r) => r.id === overdue), "…and the row leaves the list");
  await updateRowProperties(alice, overdue, { [marked.propertyId]: marked.previous });
  check((await assignedRows(alice, workspaceId, today)).groups.flatMap((g) => g.rows).some((r) => r.id === overdue), "putting the status back brings it back");
  const reviewed = await markAssignedDone(alice, dueToday);
  check(reviewed.previous === option("in_progress"), "a row naming her as reviewer is marked done the same way");
  await rejects(() => markAssignedDone(alice, shared), isAccessError, "a row she may only view can't be marked done");
  await rejects(() => markAssignedDone(alice, hidden), isAccessError, "…nor one she can't open");
  await rejects(() => markAssignedDone(alice, note), (e) => e instanceof AssignedRowError, "…nor one without a status");
  const guestList = (await assignedRows(guest, workspaceId, today)).groups.flatMap((g) => g.rows).filter((r) => r.type === "row");
  check(guestList.length === 1 && guestList[0].id === shared, "a guest sees the rows shared with them that name them", guestList.map((r) => r.title));
  await rejects(() => assignedRows(`${RUN}-nobody`, workspaceId, today), () => true, "someone outside the workspace gets nothing");

  // ── Turning a page into a teamspace ────────────────────────────────────────────────────────
  const project = await createPage({ userId: owner }, { workspaceId, title: `${RUN} Launch`, icon: "🚀", teamspaceId: null });
  const brief = await createPage({ userId: owner }, { workspaceId, parentId: project.id, title: `${RUN} Brief` });
  const plan = await createPage({ userId: owner }, { workspaceId, parentId: project.id, title: `${RUN} Plan` });
  const step = await createPage({ userId: owner }, { workspaceId, parentId: plan.id, title: `${RUN} Step` });
  const board = await createPage({ userId: owner }, { workspaceId, parentId: project.id, kind: "database", title: `${RUN} Board` });
  const old = await createPage({ userId: owner }, { workspaceId, parentId: project.id, title: `${RUN} Old` });
  const { archivePage } = await import("@/server/pages");
  await archivePage(owner, old.id);
  const group = await createGroup(owner, workspaceId, `${RUN} Writers`, [erin]);
  await setPagePermission(owner, project.id, bob, "full");
  await setPagePermission(owner, project.id, carol, "edit");
  await setPagePermission(owner, project.id, dave, "view");
  await setPagePermission(owner, project.id, guest, "comment");
  await setPageGroupPermission(owner, project.id, group.id, "edit");
  const before = await levels(step.id, owner, bob, carol, dave, guest, erin, alice);
  check(before === "full,full,edit,view,comment,edit,none", "the private page is shared by name and with a group", before);

  check((await getPageHeaderInfo(owner, project.id)).teamspace, "the page menu offers it to someone with full access");
  check(!(await getPageHeaderInfo(carol, project.id)).teamspace, "…not to someone who may only edit");
  check(!(await getPageHeaderInfo(owner, board.id)).teamspace, "…not on a database");
  check(!(await getPageHeaderInfo(owner, overdue)).teamspace, "…nor on a row");
  await rejects(() => turnPageIntoTeamspace(alice, project.id), isAccessError, "someone who can't open the page can't turn it");
  await rejects(() => turnPageIntoTeamspace(carol, project.id), isAccessError, "…nor someone who may only edit it");
  await rejects(() => turnPageIntoTeamspace(guest, project.id), isAccessError, "…nor a guest");
  await rejects(() => turnPageIntoTeamspace(owner, board.id), isCode("notConvertible"), "a database can't become a teamspace");
  await rejects(() => turnPageIntoTeamspace(owner, overdue), isCode("notConvertible"), "…nor a row");
  await updateWorkspaceSettings(owner, workspaceId, { teamspaceCreation: "owners" });
  await rejects(() => turnPageIntoTeamspace(bob, project.id), isCode("creationRestricted"), "with teamspaces for owners only, a member can't");
  check(!(await getPageHeaderInfo(bob, project.id)).teamspace, "…and the menu doesn't offer it");
  await updateWorkspaceSettings(owner, workspaceId, { teamspaceCreation: "members" });

  const preview = await previewTeamspaceFromPage(owner, project.id);
  check(
    preview.name === project.title &&
      preview.icon === "🚀" &&
      preview.access === "private" &&
      preview.pages === 4 &&
      preview.owners.join() === [owner, bob].join() &&
      preview.members.join() === carol &&
      preview.groups === 1 &&
      preview.kept === 2,
    "the dialog is told the pages that move, who joins as what, who keeps their access and how open it is",
    preview,
  );

  broadcasts.length = 0;
  const created = await turnPageIntoTeamspace(owner, project.id);
  const [space] = await db.select().from(teamspace).where(eq(teamspace.id, created.id));
  check(space.name === project.title && space.icon === "🚀", "the teamspace is named after the page, with its icon");
  check(space.access === "private" && space.memberLevel === "edit", "a private page makes a private teamspace whose members may edit", space);
  const people = await db.select({ userId: teamspaceMember.userId, role: teamspaceMember.role }).from(teamspaceMember).where(eq(teamspaceMember.teamspaceId, created.id));
  const roles = new Map(people.map((p) => [p.userId, p.role]));
  check(roles.get(owner) === "owner" && roles.get(bob) === "owner", "whoever turned it and those with full access own it", [...roles]);
  check(roles.get(carol) === "member" && roles.size === 3, "those who could edit are members; viewers, commenters and guests aren't in it", [...roles]);
  const groups = await db.select().from(teamspaceGroup).where(eq(teamspaceGroup.teamspaceId, created.id));
  check(groups.length === 1 && groups[0].groupId === group.id, "a group that could edit joins it");
  const placed = await db
    .select({ id: page.id, parentId: page.parentId, teamspaceId: page.teamspaceId })
    .from(page)
    .where(inArray(page.id, [project.id, brief.id, plan.id, board.id, step.id, old.id]));
  const at = new Map(placed.map((p) => [p.id, p]));
  check(
    [project.id, brief.id, plan.id, board.id].every((id) => at.get(id)!.parentId === null && at.get(id)!.teamspaceId === created.id),
    "the page and the pages right under it are the teamspace's top-level pages",
    placed,
  );
  check(at.get(step.id)!.parentId === plan.id && at.get(step.id)!.teamspaceId === created.id, "pages further down stay where they are, in the teamspace");
  check(at.get(old.id)!.parentId === project.id && at.get(old.id)!.teamspaceId === created.id, "a trashed page stays under the page, to come back there");
  for (const id of [project.id, plan.id, step.id]) {
    const after = await levels(id, owner, bob, carol, dave, guest, erin, alice);
    check(after === before, `nobody named on the page gains or loses access (${id === project.id ? "the page" : id === plan.id ? "a page moved up" : "a page below"})`, after);
  }
  check((await levels(brief.id, alice)) === "none", "someone not named on it still can't open it");
  const sidebar = await getSidebar(carol, workspaceId);
  check(sidebar.teamspaces.some((t) => t.id === created.id), "the teamspace is in its members' sidebars");
  check(sidebar.tree.some((n) => n.id === plan.id && n.parentId === null), "…with the pages at its top");
  check(!(await getSidebar(alice, workspaceId)).teamspaces.some((t) => t.id === created.id), "a private teamspace isn't in anyone else's");
  check(broadcasts.includes(`ws:${workspaceId}:tree`), "open sidebars hear about it");
  const events = await db
    .select({ action: auditEvent.action, targetId: auditEvent.targetId, details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["teamspace.created_from_page", "teamspace.member_added", "teamspace.group_added", "page.moved"])));
  check(
    events.some((e) => e.action === "teamspace.created_from_page" && e.targetId === created.id && e.details.source === project.title),
    "the audit log says which page became the teamspace",
  );
  check(events.some((e) => e.action === "teamspace.member_added" && (e.details.names as string[]).includes(bob)), "…who joined");
  check(events.filter((e) => e.action === "page.moved").length === 4, "…and each page that moved", events.map((e) => e.action));

  // From an open teamspace: an open one, so those not named keep reading it.
  const open = await createTeamspace(owner, workspaceId, { name: `${RUN} Open`, access: "open" });
  const wiki = await createPage({ userId: owner }, { workspaceId, title: `${RUN} Wiki`, teamspaceId: open.id });
  const wikiChild = await createPage({ userId: owner }, { workspaceId, parentId: wiki.id, title: `${RUN} Wiki child` });
  check((await levels(wikiChild.id, alice)) === "comment", "an open teamspace's page: those not in it read and comment");
  const fromOpen = await turnPageIntoTeamspace(owner, wiki.id, "  Handbook  ");
  const [openSpace] = await db.select().from(teamspace).where(eq(teamspace.id, fromOpen.id));
  check(openSpace.access === "open" && openSpace.name === "Handbook", "a page of an open teamspace makes an open one, under the name given");
  check((await levels(wikiChild.id, alice, owner)) === "comment,full", "…and those not in it still read it");

  // Sub-pages someone else closed stay closed: the new teamspace doesn't open them, not even to
  // whoever turns the page, and the dialog doesn't count those they can't see.
  const memo = await createPage({ userId: owner }, { workspaceId, title: `${RUN} Memo`, teamspaceId: open.id });
  const closed = await createPage({ userId: owner }, { workspaceId, parentId: memo.id, title: `${RUN} Closed` });
  const sealed = await createPage({ userId: owner }, { workspaceId, parentId: memo.id, title: `${RUN} Sealed` });
  await setPagePermission(owner, memo.id, bob, "full");
  for (const [id, bobLevel] of [[closed.id, "view"], [sealed.id, "none"]] as const) {
    await setPagePermission(owner, id, owner, "full");
    await setPagePermission(owner, id, bob, bobLevel);
    await setPagePermission(owner, id, null, "none");
  }
  const closedBefore = await levels(closed.id, owner, bob, alice);
  check(closedBefore === "full,view,none" && (await levels(sealed.id, bob)) === "none", "sub-pages closed to all but their owner, bob viewing one", closedBefore);
  check((await previewTeamspaceFromPage(bob, memo.id)).pages === 2, "the dialog counts the page and the sub-page bob sees, not the one he doesn't");
  await turnPageIntoTeamspace(bob, memo.id);
  check((await levels(closed.id, owner, bob, alice)) === closedBefore, "a closed sub-page stays closed: bob doesn't get more, nor those not in it", await levels(closed.id, owner, bob, alice));
  check((await levels(sealed.id, owner, bob, alice)) === "full,none,none", "…and one he couldn't open stays out of his reach");

  // A teamspace whose top level is locked: only who may arrange it turns one of its top-level pages.
  const pinned = await createPage({ userId: owner }, { workspaceId, title: `${RUN} Pinned`, teamspaceId: open.id });
  await setPagePermission(owner, pinned.id, bob, "full");
  await updateTeamspace(owner, open.id, { topLevelLocked: true });
  check(!(await getPageHeaderInfo(bob, pinned.id)).teamspace, "the menu doesn't offer it on a locked top level");
  await rejects(() => turnPageIntoTeamspace(bob, pinned.id), isCode("topLevelLocked"), "…and turning it is refused");
  check(Boolean((await getPageHeaderInfo(owner, pinned.id)).teamspace), "the teamspace's owner still can");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
