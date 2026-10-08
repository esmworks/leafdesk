/**
 * End-to-end check of the status, checklist, email and phone properties, number formats, and of
 * the system properties (created time, last edited time, last edited by) against the database:
 * values are validated and stored, statuses keep their groups and group boards, number formats
 * leave values as they are, and "last edited" follows property changes and body edits alike while
 * never being writable.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/property-types-e2e.ts
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
const { createCollab } = await import("@/server/collab/service");
const {
  addProperty,
  addView,
  deleteProperty,
  ensureOption,
  getDatabaseSnapshot,
  getProperties,
  listRows,
  updateProperty,
  updateRowProperties,
  updateRowsProperties,
} = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `property-types-e2e-${Date.now().toString(36)}`;

// The real collab service, so body edits go through the same save path as the editor's.
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

async function rejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof PropertyValueError && error.code === code;
  }
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

async function stored(rowId: string) {
  const [row] = await db
    .select({ properties: page.properties, updatedAt: page.updatedAt, updatedBy: page.updatedBy })
    .from(page)
    .where(eq(page.id, rowId));
  return row;
}

async function snapshotRow(databaseId: string, rowId: string, userId = ids.owner) {
  return (await getDatabaseSnapshot(userId, databaseId)).rows.find((r) => r.id === rowId)!;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  // Start without the default Status select and Tags, so the status is the only groupable property.
  for (const prop of await getProperties(tasks.id)) await deleteProperty(ids.owner, prop.id);

  // Status: default options in groups, values by name, boards group by it
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "status" });
  const groups = stage.options.options!.map((o) => `${o.name}:${o.group}`).join();
  check(groups === "Not started:todo,In progress:in_progress,Done:done", "a new status gets grouped default options", groups);
  const [notStarted, inProgress, done] = stage.options.options!;
  const board = await addView(ids.owner, tasks.id, { name: "Board", type: "board" });
  check(board.config.groupBy === stage.id, "a new board groups by the status property", board.config);
  const r1 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r1", properties: { Stage: "in progress" } });
  const r2 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r2", properties: { [stage.id]: done.id } });
  const r3 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r3", properties: { [stage.id]: notStarted.id } });
  check((await stored(r1.id)).properties[stage.id] === inProgress.id, "a status is set by option name and stored as its id");
  check(await rejects(() => updateRowProperties(ids.owner, r1.id, { Stage: "Someday" }), "unknownOption"), "an unknown status is rejected");
  const byStage = await listRows(ids.owner, tasks.id, { sorts: [{ propertyId: stage.id, direction: "desc" }] });
  check(byStage.map((r) => r.title).join() === "r2,r1,r3", "rows sort by status group", byStage.map((r) => r.title));
  const column = await ensureOption(ids.owner, stage.id, "Blocked");
  check(column.group === "todo", "a status option added by name (new board column) starts as to do", column);
  // Moving an option to another group keeps the options in group order.
  const moved = [notStarted, inProgress, done, { ...column, group: "in_progress" as const }];
  await updateProperty(ids.owner, stage.id, { options: moved });
  const order = (await getDatabaseSnapshot(ids.owner, tasks.id)).properties.find((p) => p.id === stage.id)!.options.options!;
  check(
    order.map((o) => o.name).join() === "Not started,In progress,Blocked,Done",
    "status options are saved in group order",
    order.map((o) => o.name),
  );
  await updateProperty(ids.owner, stage.id, { options: [notStarted, inProgress, column] });
  check(!(stage.id in (await stored(r2.id)).properties), "a deleted status option is cleared from its rows");

  // Checklist: items with ids, progress-based sorting
  const todo = await addProperty(ids.owner, tasks.id, { name: "Todo", type: "checklist" });
  await updateRowProperties(ids.owner, r1.id, { Todo: ["Write", { text: "Review", checked: true }, "  "] });
  const items = (await stored(r1.id)).properties[todo.id] as { id: string; text: string; checked: boolean }[];
  check(
    items.length === 2 && items.every((i) => i.id) && items[1].checked && !items[0].checked,
    "checklist items are stored with ids and blank items are dropped",
    items,
  );
  await updateRowProperties(ids.owner, r2.id, { Todo: [{ text: "Ship", checked: true }] });
  const byProgress = await listRows(ids.owner, tasks.id, { sorts: [{ propertyId: todo.id, direction: "desc" }] });
  check(byProgress.map((r) => r.title).join() === "r2,r1,r3", "rows sort by checklist completion", byProgress.map((r) => r.title));
  const open = await listRows(ids.owner, tasks.id, { filters: [{ propertyId: todo.id, op: "is_empty" }] });
  check(open.map((r) => r.title).join() === "r3", "an empty checklist matches is empty", open.map((r) => r.title));
  check(await rejects(() => updateRowProperties(ids.owner, r1.id, { Todo: "Write" }), "invalidChecklist"), "a checklist needs a list");

  // Email and phone: loose validation
  await addProperty(ids.owner, tasks.id, { name: "Email", type: "email" });
  const phone = await addProperty(ids.owner, tasks.id, { name: "Phone", type: "phone" });
  const written = await updateRowProperties(ids.owner, r1.id, { Email: "mailto:ada@example.com", Phone: " +90 212 555 01 23 " });
  check(written[phone.id] === "+90 212 555 01 23", "a phone number is trimmed and kept", written);
  check(await rejects(() => updateRowProperties(ids.owner, r1.id, { Email: "ada@" }), "invalidEmail"), "an invalid email is rejected");
  check(await rejects(() => updateRowProperties(ids.owner, r1.id, { Phone: "call me" }), "invalidPhone"), "an invalid phone is rejected");

  // Numbers: formats change how values show, never the stored values
  const price = await addProperty(ids.owner, tasks.id, { name: "Price", type: "number", number: { format: "currency", currency: "try" } });
  check(
    JSON.stringify(price.options.number) === JSON.stringify({ format: "currency", currency: "TRY" }),
    "a number property is added with a currency format",
    price.options,
  );
  check(
    await rejects(() => updateProperty(ids.owner, price.id, { number: { format: "currency", currency: "XYZ" } }), "invalidNumberFormat"),
    "an unknown currency is rejected",
  );
  check(
    await rejects(() => updateProperty(ids.owner, todo.id, { number: { format: "percent" } }), "invalidNumberFormat"),
    "only number properties take a number format",
  );
  await updateProperty(ids.owner, price.id, { number: { format: "percent", decimals: 1 } });
  await updateRowProperties(ids.owner, r1.id, { Price: 0.15 });
  await updateRowProperties(ids.owner, r2.id, { Price: 0.5 });
  check((await stored(r1.id)).properties[price.id] === 0.15, "a percentage is stored as its fraction");
  const over = await listRows(ids.owner, tasks.id, { filters: [{ propertyId: price.id, op: "gt", value: 20 }] });
  check(over.map((r) => r.title).join() === "r2", "a percent filter compares percent points", over.map((r) => r.title));
  await updateProperty(ids.owner, price.id, { number: null });
  const plain = (await getProperties(tasks.id)).find((p) => p.id === price.id)!;
  check(!("number" in plain.options) && (await stored(r1.id)).properties[price.id] === 0.15, "clearing the format keeps the values", plain.options);

  // System properties: computed, read-only, and moving with property and body edits
  const created = await addProperty(ids.owner, tasks.id, { name: "Created", type: "created_time" });
  const edited = await addProperty(ids.owner, tasks.id, { name: "Edited", type: "last_edited_time" });
  const editor = await addProperty(ids.owner, tasks.id, { name: "Edited by", type: "last_edited_by" });
  const before = await snapshotRow(tasks.id, r3.id);
  check(
    before.properties[created.id] === before.createdAt.toISOString() &&
      before.properties[edited.id] === before.updatedAt.toISOString() &&
      JSON.stringify(before.properties[editor.id]) === JSON.stringify([ids.owner]),
    "created time, last edited time and last edited by are filled in",
    before.properties,
  );
  check(!(created.id in (await stored(r3.id)).properties), "system values are not stored on the row");
  for (const prop of [created, edited, editor]) {
    check(
      await rejects(() => updateRowProperties(ids.owner, r3.id, { [prop.id]: null }), "readOnlyProperty"),
      `${prop.type} can't be written`,
    );
  }

  await tick();
  await updateRowProperties(ids.editor, r3.id, { Todo: ["One more"] });
  const afterProperty = await snapshotRow(tasks.id, r3.id);
  check(
    JSON.stringify(afterProperty.properties[editor.id]) === JSON.stringify([ids.editor]) &&
      String(afterProperty.properties[edited.id]) > String(before.properties[edited.id]) &&
      afterProperty.properties[created.id] === before.properties[created.id],
    "a property change moves last edited time and by, not created time",
    afterProperty.properties,
  );
  const people = (await getDatabaseSnapshot(ids.owner, tasks.id)).people.map((p) => p.id);
  check(people.includes(ids.editor), "the last editor is among the people the database can show", people);

  await tick();
  await service.replaceContent(r1.id, "Body written by the owner", { userId: ids.owner });
  await service.replaceContent(r2.id, "Body written by the editor", { userId: ids.editor });
  const afterBody = await snapshotRow(tasks.id, r2.id);
  check(
    JSON.stringify(afterBody.properties[editor.id]) === JSON.stringify([ids.editor]) &&
      String(afterBody.properties[edited.id]) > String(afterProperty.properties[edited.id]),
    "a body edit moves last edited time and by",
    afterBody.properties,
  );

  const mine = await listRows(ids.editor, tasks.id, { filters: [{ propertyId: editor.id, op: "contains", value: "me" }] });
  check(mine.map((r) => r.title).sort().join() === "r2,r3", "last edited by filters on me", mine.map((r) => r.title));
  const recent = await listRows(ids.owner, tasks.id, { sorts: [{ propertyId: edited.id, direction: "desc" }] });
  check(recent[0].title === "r2", "rows sort by last edited time", recent.map((r) => r.title));
  // Past 1 day includes yesterday, so this holds when the run crosses midnight.
  const fresh = await listRows(ids.owner, tasks.id, {
    filters: [{ propertyId: created.id, op: "is_within", value: "past_n_days", days: 1 }],
  });
  check(fresh.length === 3, "created time filters by relative dates", fresh.map((r) => r.title));
  const bulk = await updateRowsProperties(ids.editor, tasks.id, [r1.id], { Stage: "Blocked" });
  const afterBulk = (await listRows(ids.owner, tasks.id)).find((r) => r.id === r1.id)!;
  check(
    bulk.done.length === 1 &&
      afterBulk.properties[stage.id] === column.id &&
      JSON.stringify(afterBulk.properties[editor.id]) === JSON.stringify([ids.editor]),
    "a bulk status edit sets the status and the last editor",
    afterBulk.properties,
  );
  const untouched = (await stored(r1.id)).updatedAt.getTime();
  await tick();
  const email = (await getProperties(tasks.id)).find((p) => p.type === "email")!;
  await deleteProperty(ids.owner, email.id);
  check(
    (await stored(r1.id)).updatedAt.getTime() === untouched,
    "deleting a property doesn't count as editing its rows",
    [untouched, (await stored(r1.id)).updatedAt],
  );
  const editorBoard = await addView(ids.owner, tasks.id, { name: "By editor", type: "board" });
  check(editorBoard.config.groupBy === stage.id, "boards still default to the status, not a system property");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
