/**
 * End-to-end check of button properties against the database: their label and color as kept, the
 * trigger that names one, and a click (lib/row-buttons, server/row-buttons): it runs the
 * automations made for that button on the row with whoever clicked as the actor, and is refused
 * without edit access to the row, on a row in the trash, for a button nothing is made for or one
 * clicked too often. A button holds no value, so writing one is refused.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-buttons-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take the queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { automationRun, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { runEvent } = await import("@/lib/automations");
const { PropertyValueError } = await import("@/lib/properties");
const { ROW_BUTTON_CLICKS_PER_MINUTE } = await import("@/lib/row-buttons");
const { AccessError } = await import("@/server/access");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, getProperties, updateProperty, updateRowProperties } = await import("@/server/databases");
const { archiveRows, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { pressRowButton, RowButtonError } = await import("@/server/row-buttons");

const RUN = `row-buttons-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
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

/** Whether `promise` fails with that PropertyValueError or RowButtonError code, or "access". */
async function failsWith(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) =>
      ((error instanceof PropertyValueError || error instanceof RowButtonError) && error.code === code) ||
      (code === "access" && error instanceof AccessError),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

async function values(rowId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties;
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.viewer, name: "Viewer Vera", email: `${ids.viewer}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.viewer, role: "guest" },
  ]);
  const tasks = await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Tasks" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["Todo", "Done"] });
  const closer = await addProperty(ids.owner, tasks.id, { name: "Closed by", type: "person" });
  const DONE = stage.options.options!.find((o) => o.name === "Done")!.id;

  // ------------------------------------------------------------------ the property
  const finish = await addProperty(ids.owner, tasks.id, {
    name: "Finish",
    type: "button",
    button: { label: "  Mark   done ", color: "green", extra: 1 } as never,
  });
  check(
    finish.options.button?.label === "Mark done" && finish.options.button.color === "green" && Object.keys(finish.options.button).length === 2,
    "a button keeps a one-line label and a palette color, nothing else",
    finish.options,
  );
  check(finish.options.pageVisibility === undefined, "a button shows on row pages whatever the database hides when empty", finish.options);
  await updateProperty(ids.owner, finish.id, { button: { color: "purple" as never } });
  const [stored] = (await getProperties(tasks.id)).filter((p) => p.id === finish.id);
  check(JSON.stringify(stored.options.button) === JSON.stringify({ color: "purple" }), "changing it replaces the label and color", stored.options);
  check(await failsWith(updateProperty(ids.owner, stage.id, { button: { label: "x" } }), "unsupportedType"), "only buttons take button options");
  const empty = await addProperty(ids.owner, tasks.id, { name: "Nothing yet", type: "button" });

  const [row, other] = await createRows(ids.owner, tasks.id, [{ title: "Write the report" }, { title: "Call the client" }]);
  check(await failsWith(updateRowProperties(ids.owner, row.id, { [finish.id]: true }), "readOnlyProperty"), "a button holds no value to write");

  // ------------------------------------------------------------------ the trigger
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "button_clicked", property: "Stage" }, actions: [{ type: "log", message: "x" }] }),
      "invalidAutomation",
    ),
    "a button trigger names a button property",
  );
  const done = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Finish it",
    trigger: { type: "button_clicked", property: "Finish" },
    actions: [{ type: "set_properties", values: { Stage: "Done", "Closed by": { $: "actor" } } }],
  });
  check(done.trigger.type === "button_clicked" && done.trigger.propertyId === finish.id, "…found by name and kept by id", done.trigger);

  // ------------------------------------------------------------------ clicking
  check(await failsWith(pressRowButton(ids.owner, row.id, empty.id), "noAutomation"), "a button nothing is made for says so");
  check(await failsWith(pressRowButton(ids.owner, row.id, stage.id), "notFound"), "a property that isn't a button can't be clicked");
  check(await failsWith(pressRowButton(ids.owner, tasks.id, finish.id), "notFound"), "…nor a database itself");

  await setPagePermission(ids.owner, tasks.id, ids.viewer, "view");
  check(await failsWith(pressRowButton(ids.viewer, row.id, finish.id), "access"), "clicking takes edit access to the row");

  const pressed = await pressRowButton(ids.member, row.id, finish.id);
  check(pressed.started === 1, "a click starts the automation made for the button", pressed);
  await flushAutomations();
  const after = await values(row.id);
  check(after[stage.id] === DONE, "…which sets the row's values", after);
  check(JSON.stringify(after[closer.id]) === JSON.stringify([ids.member]), "…with whoever clicked as the actor", after);
  check((await values(other.id))[stage.id] === undefined, "…on that row only");
  const runs = await db.select().from(automationRun).where(eq(automationRun.automationId, done.id));
  check(
    runs.length === 1 && runs[0].rowId === row.id && runs[0].origin === "button" && runs[0].actorId === ids.member && runEvent(runs[0]) === "row.button_clicked",
    "the run says a button started it",
    runs,
  );

  // A second automation on the same button: both start.
  await manage.createAutomation(ids.owner, tasks.id, {
    name: "Note it",
    trigger: { type: "button_clicked", property: finish.id },
    actions: [{ type: "log", message: "{{trigger.actor}}" }],
  });
  check((await pressRowButton(ids.member, other.id, finish.id)).started === 2, "every automation made for the button starts");
  await manage.updateAutomation(ids.owner, done.id, { enabled: false });
  check((await pressRowButton(ids.member, other.id, finish.id)).started === 1, "…but a turned-off one doesn't");
  await flushAutomations();

  // One person, one row's button: a few clicks a minute.
  let refused = false;
  for (let i = 0; i < ROW_BUTTON_CLICKS_PER_MINUTE + 1 && !refused; i++) {
    refused = await failsWith(pressRowButton(ids.owner, row.id, finish.id), "rateLimited");
  }
  check(refused, "clicking one row's button too often is refused");
  check((await pressRowButton(ids.owner, other.id, finish.id)).started === 1, "…another row's still works");
  await flushAutomations();

  await archiveRows(ids.owner, tasks.id, [other.id]);
  check(await failsWith(pressRowButton(ids.owner, other.id, finish.id), "inTrash"), "a row in the trash can't be clicked");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
