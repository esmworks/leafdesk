/**
 * End-to-end check of deleted database properties and views against the database: a deleted
 * property is left out of every read (snapshot, row page, filters and sorts, formulas, MCP) and
 * refused on writes while rows keep its values and views their settings about it; restoring brings
 * both back (with a number when its name was taken meanwhile), two-way relations go and come back
 * with their other side, access rules naming its people stop holding, automations skip it, and
 * the daily cleanup or "Delete permanently" deletes it for good. Views likewise, with a database
 * keeping at least one. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/deleted-schema-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, automationRun, databaseProperty, databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const databases = await import("@/server/databases");
const { createAutomation } = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { createPage, getTree } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { propertyAccessFor, setPropertyAccess } = await import("@/server/property-access");
const { runRetention } = await import("@/server/retention");

const RUN = `deleted-schema-e2e-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;

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

async function rejects(fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return code ? (error as { code?: string }).code === code : true;
  }
}

/** Calls an MCP tool as `userId` with read and write access, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "deleted-schema-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

type Values = Record<string, unknown>;
const valuesOf = async (databaseId: string, userId = ids.owner) =>
  new Map((await databases.getDatabaseSnapshot(userId, databaseId)).rows.map((r) => [r.title, r.properties as Values]));
const storedView = async (viewId: string) => (await db.select().from(databaseView).where(eq(databaseView.id, viewId)))[0];
const storedValues = async (rowId: string) => (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties as Values;
const errorCode = (value: unknown) => (value as { error?: { code?: string } } | undefined)?.error?.code;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN, settings: { trashRetentionDays: 30 } });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const root = await createPage(actor, { workspaceId, title: "Planning" });
  const tasks = await createPage(actor, { workspaceId, parentId: root.id, kind: "database", title: "Tasks" });
  const projects = await createPage(actor, { workspaceId, parentId: root.id, kind: "database", title: "Projects" });
  // The member edits the pages below full access, so property access rules hold for them.
  await setPagePermission(ids.owner, root.id, ids.owner, "full");
  await setPagePermission(ids.owner, root.id, null, "none");
  await setPagePermission(ids.owner, root.id, ids.member, "edit");

  const status = (await databases.getProperties(tasks.id)).find((p) => p.type === "status")!;
  const estimate = await databases.addProperty(ids.owner, tasks.id, { name: "Estimate", type: "number" });
  const notes = await databases.addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const double = await databases.addProperty(ids.owner, tasks.id, { name: "Double", type: "formula", formula: { expression: 'prop("Estimate") * 2' } });
  const owner = await databases.addProperty(ids.owner, tasks.id, { name: "Owner", type: "person" });
  const project = await databases.addProperty(ids.owner, tasks.id, {
    name: "Project",
    type: "relation",
    relation: { databaseId: projects.id, twoWay: true, pairedName: "Tasks" },
  });
  const pairedId = project.options.relation!.pairedPropertyId!;
  const [alpha] = await databases.createRows(ids.owner, projects.id, [{ title: "Alpha" }]);
  const [build, test] = await databases.createRows(ids.owner, tasks.id, [
    { title: "Build", properties: { Estimate: 3, Notes: "first", Owner: [ids.member], Project: [alpha.id] } },
    { title: "Test", properties: { Estimate: 1 } },
  ]);
  const table = (await databases.getDatabase(ids.owner, tasks.id)).views[0];
  await databases.updateView(ids.owner, table.id, {
    config: {
      filters: [{ propertyId: estimate.id, op: "gt", value: 2 }],
      sorts: [{ propertyId: estimate.id, direction: "desc" }],
      columnWidths: { [estimate.id]: 140 },
      hidden: [notes.id],
    },
  });

  // ------------------------------------------------------------------------------------ delete
  await databases.deleteProperty(ids.owner, estimate.id);
  check(!(await databases.getProperties(tasks.id)).some((p) => p.id === estimate.id), "a deleted property leaves the database's properties");
  const values = await valuesOf(tasks.id);
  check(!(estimate.id in values.get("Build")!), "rows read without its value", values.get("Build"));
  check((await storedValues(build.id))[estimate.id] === 3, "…while the row keeps it stored");
  check(errorCode(values.get("Build")![double.id]) === "unknownProperty", "a formula reading it fails as for a missing property", values.get("Build")![double.id]);
  const shown = (await databases.getDatabase(ids.owner, tasks.id)).views.find((v) => v.id === table.id)!;
  check(!shown.config.filters?.length && !shown.config.sorts?.length && !shown.config.columnWidths?.[estimate.id], "views read without what they say about it", shown.config);
  check((await storedView(table.id)).config.filters?.length === 1, "…while the view keeps it stored");
  check((await databases.listRows(ids.owner, tasks.id, (await storedView(table.id)).config)).length === 2, "its filter doesn't apply while it is deleted");
  // A view saved from what the client sees keeps the stored reference.
  await databases.updateView(ids.owner, table.id, { config: { ...shown.config, sorts: [{ propertyId: status.id, direction: "asc" }] } });
  const resaved = (await storedView(table.id)).config;
  check(
    resaved.filters?.length === 1 && resaved.sorts?.some((s) => s.propertyId === estimate.id) && resaved.sorts?.some((s) => s.propertyId === status.id),
    "saving the view keeps its settings about the deleted property",
    resaved,
  );
  check(await rejects(() => databases.updateRowProperties(ids.owner, build.id, { [estimate.id]: 5 }), "unknownProperty"), "writing its value is refused");
  check(await rejects(() => databases.updateProperty(ids.owner, estimate.id, { name: "X" })), "it can't be renamed while deleted");
  const mcpWrite = await callTool(ids.owner, "update_database_row", { row_id: build.id, properties: { Estimate: 5 } });
  check(mcpWrite.isError, "MCP refuses to write it", mcpWrite.text);
  const mcpSchema = await callTool(ids.owner, "get_database", { database_id: tasks.id });
  check(!mcpSchema.text.includes("Estimate"), "MCP's get_database leaves it out", mcpSchema.text);
  const mcpQuery = await callTool(ids.owner, "query_database", { database_id: tasks.id });
  check(!mcpQuery.text.includes('"Estimate"'), "MCP's query_database leaves its values out", mcpQuery.text);
  const listed = await databases.listDeletedSchema(ids.owner, tasks.id);
  check(
    listed.properties.length === 1 && listed.properties[0].id === estimate.id && listed.properties[0].deletedBy === ids.owner && listed.retentionDays === 30,
    "the deleted properties list it with who deleted it",
    listed,
  );

  // ------------------------------------------------------------------- restore, name taken meanwhile
  const newEstimate = await databases.addProperty(ids.owner, tasks.id, { name: "Estimate", type: "text" });
  check(newEstimate.name === "Estimate", "a deleted property's name is free for a new one", newEstimate.name);
  const restored = await databases.restoreProperty(ids.owner, estimate.id);
  check(restored.name === "Estimate 2", "restoring under a taken name adds a number", restored.name);
  const back = await valuesOf(tasks.id);
  check(back.get("Build")![estimate.id] === 3 && back.get("Build")![double.id] === 6, "its values and the formula reading it come back", back.get("Build"));
  check((await databases.listRows(ids.owner, tasks.id, (await storedView(table.id)).config)).map((r) => r.title).join() === "Build", "the view filters by it again");
  check(!(await databases.listDeletedSchema(ids.owner, tasks.id)).properties.length, "it leaves the deleted properties");

  // ----------------------------------------------------------------------------- two-way relations
  await databases.deleteProperty(ids.owner, project.id);
  check(!(await databases.getProperties(projects.id)).some((p) => p.id === pairedId), "deleting a two-way relation deletes its other side");
  check(await rejects(() => databases.updateRowProperties(ids.owner, alpha.id, { Tasks: [test.id] }), "unknownProperty"), "…which takes no writes either");
  await databases.restoreProperty(ids.owner, pairedId);
  check((await databases.getProperties(tasks.id)).some((p) => p.id === project.id), "restoring either side restores both");
  const linked = (await valuesOf(projects.id)).get("Alpha")![pairedId] as string[];
  check(linked?.includes(build.id) && ((await valuesOf(tasks.id)).get("Build")![project.id] as string[]).includes(alpha.id), "…with their links on both sides");

  // ------------------------------------------------------------------------------- access rules
  await setPropertyAccess(ids.owner, notes.id, { everyone: "none", exceptions: [{ personPropertyId: owner.id, level: "edit_values" }] });
  const seen = async () => (await propertyAccessFor(ids.member, tasks.id)).levelOf(notes.id, { properties: await storedValues(build.id) });
  check((await seen()) === "edit_values", "a rule naming the people of a person property lets them in");
  await databases.deleteProperty(ids.owner, owner.id);
  check((await seen()) === "none", "…not while that person property is deleted");
  await databases.restoreProperty(ids.owner, owner.id);
  check((await seen()) === "edit_values", "…and again once it is restored");
  await setPropertyAccess(ids.owner, notes.id, { everyone: "inherit", exceptions: [] });

  // --------------------------------------------------------------------------------- automations
  const optionB = status.options.options![1];
  const automation = await createAutomation(ids.owner, tasks.id, {
    name: "Set status",
    trigger: { type: "row_created" },
    actions: [{ type: "set_properties", values: { [status.name]: optionB.name } }],
  });
  await databases.deleteProperty(ids.owner, status.id);
  const [auto] = await databases.createRows(ids.owner, tasks.id, [{ title: "Automated" }]);
  await flushAutomations();
  const [run] = await db.select().from(automationRun).where(eq(automationRun.automationId, automation.id));
  check(run?.steps[0]?.status === "skipped" && run.steps[0].code === "propertyDeleted", "an action setting a deleted property is skipped", run?.steps);
  check(!(status.id in (await storedValues(auto.id))), "…and sets nothing");
  await databases.restoreProperty(ids.owner, status.id);

  // ----------------------------------------------------------------------------------------- views
  check(await rejects(() => databases.deleteView(ids.owner, table.id), "lastView"), "the last view can't be deleted");
  const board = await databases.addView(ids.owner, tasks.id, { name: "Board", type: "board" });
  await databases.deleteView(ids.owner, board.id);
  check(!(await databases.getDatabase(ids.owner, tasks.id)).views.some((v) => v.id === board.id), "a deleted view leaves the database's views");
  const tree = await getTree(ids.owner, workspaceId);
  check(!tree.find((n) => n.id === tasks.id)!.views!.some((v) => v.id === board.id), "…and the sidebar");
  check(await rejects(() => databases.deleteView(ids.owner, table.id), "lastView"), "deleted views don't count toward keeping one");
  check(await rejects(() => databases.updateView(ids.owner, board.id, { name: "X" })), "a deleted view can't be changed");
  check((await databases.listDeletedSchema(ids.owner, tasks.id)).views.some((v) => v.id === board.id), "the deleted views list it");
  await databases.restoreView(ids.owner, board.id);
  check((await databases.getDatabase(ids.owner, tasks.id)).views.some((v) => v.id === board.id), "a restored view is back");
  await databases.deleteView(ids.owner, board.id);
  await databases.purgeView(ids.owner, board.id);
  check(!(await storedView(board.id)), "deleting a view permanently removes it");

  // ------------------------------------------------------------------------------ deleting for good
  await databases.deleteProperty(ids.owner, newEstimate.id);
  await databases.purgeProperty(ids.owner, newEstimate.id);
  check(!(await db.select().from(databaseProperty).where(eq(databaseProperty.id, newEstimate.id))).length, "deleting a property permanently removes it");
  await databases.deleteProperty(ids.owner, notes.id);
  const late = await databases.addView(ids.owner, tasks.id, { name: "Late", type: "table" });
  await databases.deleteView(ids.owner, late.id);
  const early = await runRetention({ now: new Date(Date.now() + 29 * DAY), workspaceIds: [workspaceId] });
  check(early?.deletedProperties === 0 && early.deletedViews === 0, "the cleanup keeps them within the workspace's retention", early);
  const due = await runRetention({ now: new Date(Date.now() + 31 * DAY), workspaceIds: [workspaceId] });
  check(due?.deletedProperties === 1 && due.deletedViews === 1, "…and deletes them for good after it", due);
  check(!(notes.id in (await storedValues(build.id))), "rows lose the purged property's values");
  check(!(await storedView(table.id)).config.hidden?.includes(notes.id), "views lose their settings about it");

  // ------------------------------------------------------------------------------------- audit log
  const events = await db
    .select({ action: auditEvent.action, actor: auditEvent.actorUserId, details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["property.trashed", "property.restored", "property.deleted", "view.trashed", "view.restored", "view.deleted"])));
  const count = (action: string) => events.filter((e) => e.action === action).length;
  check(count("property.trashed") >= 5 && count("property.restored") >= 4, "deleting and restoring properties is in the audit log", events);
  check(events.some((e) => e.action === "property.deleted" && e.actor === null && (e.details as { property?: string }).property === "Notes"), "…and so is the cleanup's delete, by the server");
  check(count("view.trashed") === 3 && count("view.restored") === 1 && count("view.deleted") === 2, "so are deleted, restored and purged views", events);

  // A member with edit access may restore, as they may delete.
  await databases.deleteProperty(ids.member, restored.id);
  await databases.restoreProperty(ids.member, restored.id);
  check((await databases.getProperties(tasks.id)).some((p) => p.id === restored.id), "a member who may delete a property may restore it");
  await databases.deleteProperty(ids.owner, restored.id);
  await databases.setDatabaseLocked(ids.owner, tasks.id, true);
  check(await rejects(() => databases.restoreProperty(ids.owner, restored.id), "databaseLocked"), "a locked database restores no property");
  check(await rejects(() => databases.purgeProperty(ids.owner, restored.id), "databaseLocked"), "…nor deletes one for good");
  await databases.setDatabaseLocked(ids.owner, tasks.id, false);
  check(!(await rejects(() => databases.restoreProperty(ids.owner, restored.id))), "unlocked, it restores again");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
