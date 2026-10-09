/**
 * End-to-end check of the home page's "Assigned to you" list against the database: rows a person
 * property assigns to the viewer, grouped by date, without done rows, the trash, templates, rows
 * they can't open or values hidden from them (a hidden person property doesn't count, a hidden
 * status or date neither shows nor decides), the name of a database they can't open, and the cap.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/assigned-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { dayString, localDay } = await import("@/lib/time-zone");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty } = await import("@/server/databases");
const { loadProperties } = await import("@/server/derived");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { createRowTemplate, saveAsTemplate } = await import("@/server/templates");
const { ASSIGNED_LIMIT, assignedRows } = await import("@/server/assigned");
const { AccessError } = await import("@/server/access");

const RUN = `assigned-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-other`;
const owner = { userId: ids.owner };
// One instant for every date, so a run across midnight still agrees with itself.
const todayNumber = localDay(Date.now(), "UTC");
const today = dayString(todayNumber);
const day = (offset: number) => dayString(todayNumber + offset);

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  const empty = await assignedRows(ids.member, workspaceId, today);
  check(empty.groups.length === 0 && empty.total === 0, "a workspace without person properties lists nothing", empty);

  // Tasks: Assignee and Reviewer (people), Due (date) and the default Status.
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  await addProperty(ids.owner, tasks.id, { name: "Reviewer", type: "person" });
  await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const row = (title: string, properties: Record<string, unknown>) =>
    createPage(owner, { workspaceId, parentId: tasks.id, title, properties });
  const mine = { Assignee: [ids.member] };

  const overdue = await row("Overdue", { ...mine, Due: day(-1), Status: "Not started" });
  const dueToday = await row("Today", { ...mine, Due: today, Status: "In progress" });
  const soon = await row("Soon", { ...mine, Due: day(3) });
  const later = await row("Later", { ...mine, Due: day(30) });
  const undated = await row("Undated", mine);
  const reviewing = await row("Reviewing", { Reviewer: [ids.member], Assignee: [ids.owner] });
  await row("Done", { ...mine, Status: "Done", Due: day(-2) });
  await row("Someone else's", { Assignee: [ids.owner], Due: today });
  const trashed = await row("Trashed", { ...mine, Due: today });
  await archivePage(ids.owner, trashed.id);
  const closed = await row("Closed to the member", { ...mine, Due: today });
  await setPagePermission(ids.owner, closed.id, ids.owner, "full");
  await setPagePermission(ids.owner, closed.id, null, "none");
  await createRowTemplate(owner, tasks.id, { title: "Row template", properties: mine });

  const asMember = await assignedRows(ids.member, workspaceId, today);
  const titles = (r: typeof asMember) => r.groups.map((g) => [g.key, g.rows.map((x) => x.title)]);
  check(
    JSON.stringify(titles(asMember)) ===
      JSON.stringify([
        ["overdue", ["Overdue"]],
        ["today", ["Today"]],
        ["next7", ["Soon"]],
        ["later", ["Later"]],
        // Undated rows: the one edited last first.
        ["none", ["Reviewing", "Undated"]],
      ]),
    "rows assigned through any person property, grouped by date; done, trashed, closed and template rows left out",
    titles(asMember),
  );
  check(asMember.total === 6, "the total counts the open rows", asMember.total);
  const first = asMember.groups[0].rows[0];
  check(
    first.id === overdue.id && first.date === day(-1) && first.status?.name === "Not started" && first.databaseTitle === "Tasks",
    "a row carries its date, status and database",
    first,
  );
  check(
    asMember.groups.flatMap((g) => g.rows).every((r) => [overdue, dueToday, soon, later, undated, reviewing].some((p) => p.id === r.id)),
    "nothing else is listed",
  );

  const asOwner = await assignedRows(ids.owner, workspaceId, today);
  check(
    JSON.stringify(titles(asOwner)) === JSON.stringify([["today", ["Someone else's"]], ["none", ["Reviewing"]]]),
    "the owner gets the rows assigned to them, not the member's",
    titles(asOwner),
  );

  // A template copy of the database keeps its rows (and their people) out of the list.
  await saveAsTemplate(owner, tasks.id);
  check((await assignedRows(ids.member, workspaceId, today)).total === 6, "a database saved as a template adds nothing");

  // Hidden values: a person property the member may not see doesn't assign them; a status or date
  // hidden from them neither leaves a done row out nor shows.
  const hidden = await createPage(owner, { workspaceId, kind: "database", title: "Hidden values" });
  const hiddenPerson = await addProperty(ids.owner, hidden.id, { name: "Owner", type: "person" });
  await addProperty(ids.owner, hidden.id, { name: "Assignee", type: "person" });
  const hiddenDate = await addProperty(ids.owner, hidden.id, { name: "Due", type: "date" });
  await createPage(owner, { workspaceId, parentId: hidden.id, title: "Named in a hidden property", properties: { Owner: [ids.member] } });
  const doneHidden = await createPage(owner, {
    workspaceId,
    parentId: hidden.id,
    title: "Done, status hidden",
    properties: { Assignee: [ids.member], Status: "Done", Due: today },
  });
  // Full access is never restricted: the member may only edit this database.
  await setPagePermission(ids.owner, hidden.id, ids.owner, "full");
  await setPagePermission(ids.owner, hidden.id, ids.member, "edit");
  await setPagePermission(ids.owner, hidden.id, null, "none");
  await setPropertyAccess(ids.owner, hiddenPerson.id, { everyone: "none", exceptions: [] });
  const statusProp = ((await loadProperties([hidden.id])).get(hidden.id) ?? []).find((p) => p.type === "status")!;
  await setPropertyAccess(ids.owner, statusProp.id, { everyone: "none", exceptions: [] });
  await setPropertyAccess(ids.owner, hiddenDate.id, { everyone: "none", exceptions: [] });

  const withHidden = await assignedRows(ids.member, workspaceId, today);
  const all = withHidden.groups.flatMap((g) => g.rows);
  check(!all.some((r) => r.title === "Named in a hidden property"), "a hidden person property assigns nobody", titles(withHidden));
  const shownDone = all.find((r) => r.id === doneHidden.id);
  check(
    shownDone && shownDone.status === null && shownDone.date === null && withHidden.groups.find((g) => g.key === "none")?.rows.includes(shownDone),
    "a hidden status doesn't leave the row out, and a hidden status and date don't show",
    shownDone,
  );
  const ownerSees = (await assignedRows(ids.owner, workspaceId, today)).groups.flatMap((g) => g.rows);
  check(!ownerSees.some((r) => r.id === doneHidden.id), "…while for full access the row is done");

  // A row shared on its own: listed, without the name of the database the member can't open.
  const secret = await createPage(owner, { workspaceId, kind: "database", title: "Secret database" });
  await addProperty(ids.owner, secret.id, { name: "Assignee", type: "person" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const sharedRow = await createPage(owner, { workspaceId, parentId: secret.id, title: "Shared row", properties: { Assignee: [ids.member] } });
  await setPagePermission(ids.owner, sharedRow.id, ids.member, "view");
  const shared = (await assignedRows(ids.member, workspaceId, today)).groups.flatMap((g) => g.rows).find((r) => r.id === sharedRow.id);
  check(shared && shared.databaseTitle === null, "a row shared on its own shows without its database's name", shared);

  // The cap: the first rows in group order, with the total of all.
  const many = await createPage(owner, { workspaceId, kind: "database", title: "Many" });
  await addProperty(ids.owner, many.id, { name: "Assignee", type: "person" });
  for (let i = 0; i < ASSIGNED_LIMIT; i++) {
    await createPage(owner, { workspaceId, parentId: many.id, title: `Many ${i}`, properties: { Assignee: [ids.member] } });
  }
  const capped = await assignedRows(ids.member, workspaceId, today);
  const cappedRows = capped.groups.flatMap((g) => g.rows);
  check(cappedRows.length === ASSIGNED_LIMIT && capped.total === ASSIGNED_LIMIT + 8, "past the cap the list is cut and the total kept", {
    shown: cappedRows.length,
    total: capped.total,
  });
  check(cappedRows[0].id === overdue.id && cappedRows.some((r) => r.id === later.id), "…keeping the dated rows first");

  let refused = false;
  try {
    await assignedRows(ids.outsider, workspaceId, today);
  } catch (error) {
    refused = error instanceof AccessError;
  }
  check(refused, "someone outside the workspace gets nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
