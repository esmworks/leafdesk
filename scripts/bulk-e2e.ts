/**
 * End-to-end check of bulk row actions against the database: editing a property of many rows,
 * duplicating them and moving them to the trash. Access is checked per row: rows the user can't
 * see, may only view, or that aren't rows of the database are skipped and reported, never
 * changed; a bad value changes nothing. Bulk edits keep two-way relations in sync and tell newly
 * assigned people once per row. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/bulk-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, asc, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, pendingAssignmentEmail, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, MAX_BULK_ROWS, updateRowsProperties } = await import("@/server/databases");
const { duplicateRows } = await import("@/server/duplicate");
const { pasteRows } = await import("@/server/paste");
const { databaseProperty } = await import("@/db/schema");
const { listInbox } = await import("@/server/notifications");
const { archiveRows, createPage, listTrash, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setAssignmentMailer } = await import("@/server/assignments");
const { AccessError } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `bulk-e2e-${Date.now().toString(36)}`;

// Writes notify open views through the collab service, which only runs inside the app server.
// Broadcasts are recorded: a bulk action tells each database's views once.
const broadcasts: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast: (channel: string, event: string) => void broadcasts.push(`${channel} ${event}`),
  async setTitle() {},
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);
// Assignment emails are captured, never sent.
setAssignmentMailer(async () => {});

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

async function rejects(write: Promise<unknown>, test: (error: unknown) => boolean) {
  return write.then(
    () => false,
    (error: unknown) => test(error),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function row(rowId: string) {
  const [found] = await db
    .select({
      title: page.title,
      properties: page.properties,
      archivedAt: page.archivedAt,
      updatedBy: page.updatedBy,
      position: page.position,
    })
    .from(page)
    .where(eq(page.id, rowId));
  return found;
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const clients = await createPage(actor, { workspaceId, kind: "database", title: "Clients" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["A", "B"] });
  const amount = await addProperty(ids.owner, tasks.id, { name: "Amount", type: "number" });
  const assignee = await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const client = await addProperty(ids.owner, tasks.id, {
    name: "Client",
    type: "relation",
    relation: { databaseId: clients.id, twoWay: true, pairedName: "Tasks" },
  });
  const pairedId = client.options.relation!.pairedPropertyId!;
  const [a, b] = stage.options.options!;

  const rows = [];
  for (const [i, title] of ["r1", "r2", "r3", "r4"].entries()) {
    rows.push(await createPage(actor, { workspaceId, parentId: tasks.id, title, properties: { [amount.id]: i + 1 } }));
  }
  const [r1, r2, r3, r4] = rows;
  const sub = await createPage(actor, { workspaceId, parentId: r1.id, title: "r1 notes" });
  const c1 = await createPage(actor, { workspaceId, parentId: clients.id, title: "c1" });
  // The member can't see r3 and may only view r4 (the owner keeps full access to both); the
  // guest may only view the database.
  for (const [restricted, level] of [
    [r3.id, "none"],
    [r4.id, "view"],
  ] as const) {
    await setPagePermission(ids.owner, restricted, ids.owner, "full");
    await setPagePermission(ids.owner, restricted, null, level);
  }
  await setPagePermission(ids.owner, tasks.id, ids.guest, "view");

  // Edit a property of many rows
  broadcasts.length = 0;
  const edit = await updateRowsProperties(ids.member, tasks.id, [r1.id, r2.id, r3.id, r4.id, c1.id, "nope", r1.id], {
    Stage: "A",
  });
  check(same(edit.done, [r1.id, r2.id]), "a bulk edit changes the rows the user may edit", edit);
  check(
    same(edit.skipped, [r3.id, r4.id, c1.id, "nope"]),
    "…and reports hidden, view-only, foreign and unknown rows as skipped, each once",
    edit,
  );
  const [v1, v2, v3, v4] = await Promise.all(rows.map((r) => row(r.id)));
  check(
    v1.properties[stage.id] === a.id && v2.properties[stage.id] === a.id,
    "the value is stored as the option id on every edited row",
    [v1, v2],
  );
  check(!(stage.id in v3.properties) && !(stage.id in v4.properties), "skipped rows keep their values", [v3, v4]);
  check(
    v1.properties[amount.id] === 1 && v2.properties[amount.id] === 2,
    "other properties of the edited rows are left as they are",
    [v1, v2],
  );
  check(v1.updatedBy === ids.member, "edited rows record who changed them", v1);
  check(
    broadcasts.filter((x) => x === `db:${tasks.id} rows`).length === 1,
    "open views of the database hear about the edit once",
    broadcasts,
  );

  const bad = await rejects(updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { Stage: "B", Amount: "lots" }), (e) => {
    return e instanceof PropertyValueError && e.code === "invalidNumber";
  });
  check(bad, "a bad value is refused…");
  check((await row(r1.id)).properties[stage.id] === a.id, "…and changes nothing, not even the valid values");

  await updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { [amount.id]: null, [stage.id]: b.id });
  const [c1v1, c1v2] = [await row(r1.id), await row(r2.id)];
  check(
    !(amount.id in c1v1.properties) && !(amount.id in c1v2.properties) && c1v1.properties[stage.id] === b.id,
    "null clears a property in bulk while another is set",
    [c1v1, c1v2],
  );

  const viewerEdit = await updateRowsProperties(ids.guest, tasks.id, [r1.id, r2.id], { Stage: "A" });
  check(
    same(viewerEdit, { done: [], skipped: [r1.id, r2.id] }) && (await row(r1.id)).properties[stage.id] === b.id,
    "a viewer's bulk edit changes nothing and reports every row as skipped",
    viewerEdit,
  );
  const outsider = await rejects(updateRowsProperties(ids.guest, clients.id, [c1.id], { Tasks: [] }), (e) => e instanceof AccessError);
  check(outsider, "a database the user can't see is refused outright");
  const tooMany = Array.from({ length: MAX_BULK_ROWS + 1 }, (_, i) => `x-${i}`);
  check(
    await rejects(updateRowsProperties(ids.owner, tasks.id, tooMany, { Stage: "A" }), (e) => {
      return e instanceof PropertyValueError && e.code === "tooManyRows";
    }),
    `more than ${MAX_BULK_ROWS} rows are refused`,
  );
  check(
    await rejects(updateRowsProperties(ids.owner, tasks.id, [r1.id], { Nope: 1 }), (e) => {
      return e instanceof PropertyValueError && e.code === "unknownProperty";
    }),
    "unknown properties are refused",
  );

  // Two-way relations and assignments
  await updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { Client: [c1.id] });
  check(same((await row(c1.id)).properties[pairedId], [r1.id, r2.id]), "a bulk relation edit links back from the related row", await row(c1.id));
  await updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { Client: null });
  check(!(pairedId in (await row(c1.id)).properties), "…and clearing it removes the links back", await row(c1.id));

  await updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { Assignee: [ids.member] });
  const inbox = (await listInbox(ids.member, workspaceId)).filter((n) => n.pageId === r1.id || n.pageId === r2.id);
  check(inbox.length === 2, "each newly assigned row lands in the assignee's inbox", inbox);
  const queued = await db
    .select()
    .from(pendingAssignmentEmail)
    .where(and(inArray(pendingAssignmentEmail.rowId, [r1.id, r2.id]), eq(pendingAssignmentEmail.userId, ids.member)));
  check(queued.length === 2, "…and gets its assignment email queued", queued);
  await updateRowsProperties(ids.owner, tasks.id, [r1.id, r2.id], { Assignee: [ids.member] });
  check(
    (await listInbox(ids.member, workspaceId)).filter((n) => n.pageId === r1.id || n.pageId === r2.id).length === 2,
    "setting the same people again tells no one twice",
  );
  check(same((await row(r1.id)).properties[assignee.id], [ids.member]), "people are stored by user id");

  // Duplicate
  broadcasts.length = 0;
  const copies = await duplicateRows(actor, tasks.id, [r2.id, r1.id, "nope"], " (copy)");
  check(copies.done.length === 2 && same(copies.skipped, ["nope"]), "duplicating copies every visible row", copies);
  const [copy2, copy1] = await Promise.all(copies.done.map(row));
  check(copy2.title === "r2 (copy)" && copy1.title === "r1 (copy)", "copies are named like page duplicates", [copy1, copy2]);
  check(
    copy2.properties[stage.id] === b.id && same(copy2.properties[assignee.id], [ids.member]),
    "copies keep the values",
    copy2,
  );
  const order = await db
    .select({ title: page.title })
    .from(page)
    .where(and(eq(page.parentId, tasks.id), inArray(page.title, ["r1", "r1 (copy)", "r2", "r2 (copy)"])))
    .orderBy(asc(page.position));
  check(
    same(order.map((r) => r.title), ["r1", "r1 (copy)", "r2", "r2 (copy)"]),
    "each copy sits right after its original",
    order,
  );
  check(
    broadcasts.filter((x) => x === `db:${tasks.id} rows`).length === 1,
    "open views hear about all copies once",
    broadcasts,
  );
  const hiddenCopy = await duplicateRows({ userId: ids.member }, tasks.id, [r3.id], " (copy)");
  check(same(hiddenCopy, { done: [], skipped: [r3.id] }), "rows the user can't see aren't copied");
  check(
    await rejects(duplicateRows({ userId: ids.guest }, tasks.id, [r1.id], " (copy)"), (e) => e instanceof AccessError),
    "viewers of the database can't duplicate rows",
  );

  // Move to the trash
  broadcasts.length = 0;
  const trashed = await archiveRows(ids.member, tasks.id, [r1.id, r2.id, r3.id, r4.id]);
  check(same(trashed, { done: [r1.id, r2.id], skipped: [r3.id, r4.id] }), "the trash takes the rows the user may edit", trashed);
  const [t1, t2, t3, t4, tsub] = await Promise.all([r1.id, r2.id, r3.id, r4.id, sub.id].map(row));
  check(t1.archivedAt && t2.archivedAt && tsub.archivedAt, "trashed rows take their subpages along", [t1, t2, tsub]);
  check(!t3.archivedAt && !t4.archivedAt, "hidden and view-only rows stay", [t3, t4]);
  const entries = (await listTrash(ids.owner, workspaceId)).map((e) => e.id);
  check(
    entries.includes(r1.id) && entries.includes(r2.id) && !entries.includes(sub.id),
    "each trashed row is its own trash entry",
    entries,
  );
  check(
    broadcasts.filter((x) => x === `db:${tasks.id} rows`).length === 1,
    "open views hear about the trashed rows once",
    broadcasts,
  );
  await restorePage(ids.owner, r1.id);
  const [back1, back2, backSub] = await Promise.all([r1.id, r2.id, sub.id].map(row));
  check(!back1.archivedAt && !backSub.archivedAt && back2.archivedAt, "restoring one brings back just that row and its subpages", [
    back1,
    back2,
    backSub,
  ]);
  const again = await archiveRows(ids.owner, tasks.id, [r2.id]);
  check(same(again, { done: [], skipped: [r2.id] }), "rows already in the trash are skipped");
  const fromCopy = await updateRowsProperties(ids.owner, tasks.id, [r2.id], { Stage: "A" });
  check(same(fromCopy.skipped, [r2.id]), "…and so are bulk edits of them");
  const viewerTrash = await archiveRows(ids.guest, tasks.id, [r1.id]);
  check(same(viewerTrash, { done: [], skipped: [r1.id] }) && !(await row(r1.id)).archivedAt, "viewers can't trash rows");

  // Pasting cells adds the options they name only for people who may edit the database
  const stageOptions = async () =>
    ((await db.select({ options: databaseProperty.options }).from(databaseProperty).where(eq(databaseProperty.id, stage.id)))[0].options.options ?? []).map(
      (o) => o.name,
    );
  const before = await stageOptions();
  const viewOnly = await pasteRows({ userId: ids.guest }, tasks.id, { updates: [{ rowId: r1.id, values: { [stage.id]: "Pasted by a viewer" } }], newRows: [] });
  check(viewOnly.updated.length === 0 && same(await stageOptions(), before), "someone who may only view the database adds no options by pasting", await stageOptions());
  await setPagePermission(ids.owner, r1.id, ids.guest, "edit");
  const rowOnly = await pasteRows({ userId: ids.guest }, tasks.id, {
    updates: [{ rowId: r1.id, values: { [stage.id]: "Pasted by a row editor", [amount.id]: 42 } }],
    newRows: [],
  });
  check(same(await stageOptions(), before), "…nor someone who may edit only some of its rows", await stageOptions());
  check(rowOnly.invalid === 1 && (await row(r1.id)).properties[amount.id] === 42, "…whose other values still land, the option counted as left out", rowOnly);
  await pasteRows({ userId: ids.member }, tasks.id, { updates: [{ rowId: r1.id, values: { [stage.id]: "Pasted by an editor" } }], newRows: [] });
  check((await stageOptions()).includes("Pasted by an editor"), "someone who may edit the database does");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
