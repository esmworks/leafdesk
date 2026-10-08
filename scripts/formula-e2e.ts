/**
 * End-to-end check of formula and rollup properties against the database: formulas are checked
 * when saved, stored with property ids (renames keep them working) and worked out on every read
 * path (snapshot, row page, filters and sorts, MCP, published pages, duplicates); rollups count
 * only the related rows the reader can see, break visibly when what they read is deleted, feed
 * formulas, and are set up over MCP by names.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/formula-e2e.ts
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
const { databaseProperty, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const {
  addProperty,
  deleteProperty,
  getDatabaseSnapshot,
  getProperties,
  getRow,
  listRows,
  updateProperty,
  updateRowProperties,
} = await import("@/server/databases");
const { duplicatePage } = await import("@/server/duplicate");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `formula-e2e-${Date.now().toString(36)}`;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "formula-e2e", version: "1" } },
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
  new Map((await getDatabaseSnapshot(userId, databaseId)).rows.map((r) => [r.title, r.properties as Values]));
const errorCode = (value: unknown) => (value as { error?: { code?: string } } | undefined)?.error?.code;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const root = await createPage(actor, { workspaceId, title: "Planning" });
  const tasks = await createPage(actor, { workspaceId, parentId: root.id, kind: "database", title: "Tasks" });
  const projects = await createPage(actor, { workspaceId, parentId: root.id, kind: "database", title: "Projects" });
  for (const id of [tasks.id, projects.id]) for (const prop of await getProperties(id)) await deleteProperty(ids.owner, prop.id);

  // ---- Formulas ----
  const hours = await addProperty(ids.owner, tasks.id, { name: "Hours", type: "number" });
  const done = await addProperty(ids.owner, tasks.id, { name: "Done", type: "checkbox" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const cost = await addProperty(ids.owner, tasks.id, {
    name: "Cost",
    type: "formula",
    formula: { expression: 'prop("Hours") * 50' },
  });
  check(cost.options.formula?.expression === `prop("${hours.id}") * 50`, "a formula is stored with property ids", cost.options);
  const label = await addProperty(ids.owner, tasks.id, {
    name: "Label",
    type: "formula",
    formula: { expression: 'upper(prop("title")) + " · " + if(prop("Done"), "done", "open")' },
  });
  const late = await addProperty(ids.owner, tasks.id, {
    name: "Late",
    type: "formula",
    formula: { expression: 'dateBetween(now(), prop("Due"), "days") > 0 and not prop("Done")' },
  });
  const t1 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Design", properties: { Hours: 3, Done: true, Due: "2020-01-10" } });
  const t2 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Build", properties: { Hours: 5, Due: "2020-02-01" } });
  const t3 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Ship", properties: { Hours: 0, Due: "2999-01-01" } });
  const t4 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Secret", properties: { Hours: 100, Done: true } });

  let tv = await valuesOf(tasks.id);
  check(tv.get("Design")![cost.id] === 150 && tv.get("Build")![cost.id] === 250, "formulas are worked out in the snapshot", tv.get("Design"));
  check(tv.get("Design")![label.id] === "DESIGN · done" && tv.get("Build")![label.id] === "BUILD · open", "formulas read the title and checkboxes");
  check(tv.get("Build")![late.id] === true && tv.get("Design")![late.id] === false && tv.get("Ship")![late.id] === false, "date and logic functions work");
  const types = Object.fromEntries((await getProperties(tasks.id)).filter((p) => p.type === "formula").map((p) => [p.name, p.options.formula?.type]));
  check(types.Cost === "number" && types.Label === "text" && types.Late === "checkbox", "formulas come with their result type", types);

  const byCost = await listRows(ids.owner, tasks.id, {
    filters: [{ propertyId: cost.id, op: "gt", value: 100 }],
    sorts: [{ propertyId: cost.id, direction: "desc" }],
  });
  check(byCost.map((r) => r.title).join() === "Secret,Build,Design", "rows filter and sort by a number formula", byCost.map((r) => r.title));
  const lateRows = await listRows(ids.owner, tasks.id, { filters: [{ propertyId: late.id, op: "is_not_empty" }] });
  check(lateRows.map((r) => r.title).join() === "Build", "rows filter by a checkbox formula", lateRows.map((r) => r.title));
  const row = await getRow(ids.owner, t2.id);
  check(row.row.properties[cost.id] === 250, "a row page shows its formulas");

  check(
    await rejects(() => addProperty(ids.owner, tasks.id, { name: "Bad", type: "formula", formula: { expression: 'prop("Nope") + 1' } }), "invalidFormula"),
    "a formula using an unknown property is refused",
  );
  check(
    await rejects(() => addProperty(ids.owner, tasks.id, { name: "Bad", type: "formula", formula: { expression: 'prop("Done") * 2' } }), "invalidFormula"),
    "a formula with a type error is refused",
  );
  const a = await addProperty(ids.owner, tasks.id, { name: "A", type: "formula", formula: { expression: 'prop("Cost") + 1' } });
  check(
    await rejects(() => updateProperty(ids.owner, cost.id, { formula: { expression: 'prop("A") * 2' } }), "invalidFormula"),
    "a formula that would refer back to itself is refused",
  );
  check(await rejects(() => updateRowProperties(ids.owner, t1.id, { Cost: 1 }), "readOnlyProperty"), "formula values can't be written");

  const ratio = await addProperty(ids.owner, tasks.id, { name: "Ratio", type: "formula", formula: { expression: '10 / prop("Hours")' } });
  tv = await valuesOf(tasks.id);
  check(errorCode(tv.get("Ship")![ratio.id]) === "divisionByZero" && tv.get("Build")![ratio.id] === 2, "a row the formula fails on gets its error", tv.get("Ship")![ratio.id]);

  await updateProperty(ids.owner, hours.id, { name: "Effort" });
  tv = await valuesOf(tasks.id);
  check(tv.get("Build")![cost.id] === 250, "renaming a property keeps its formulas working");
  const mcpDb = await callTool(ids.owner, "get_database", { database_id: tasks.id });
  const described = mcpDb.data.properties.find((p: { name: string }) => p.name === "Cost");
  check(described?.formula === 'prop("Effort") * 50' && described.result_type === "number" && described.read_only, "MCP shows formulas with current names", described);

  const mcpAdd = await callTool(ids.owner, "add_database_property", {
    database_id: tasks.id,
    name: "Double cost",
    type: "formula",
    formula: 'prop("Cost") * 2',
  });
  check(!mcpAdd.isError && mcpAdd.data.property.result_type === "number", "MCP adds a formula by property names", mcpAdd.text);
  const mcpBad = await callTool(ids.owner, "add_database_property", { database_id: tasks.id, name: "X", type: "formula", formula: "1 +" });
  check(mcpBad.isError && mcpBad.text.includes("Invalid formula"), "MCP refuses an invalid formula with the reason", mcpBad.text);
  const mcpEdit = await callTool(ids.owner, "update_database_property", { database_id: tasks.id, property: "Double cost", formula: 'prop("Cost") * 3' });
  check(!mcpEdit.isError && mcpEdit.data.property.formula === 'prop("Cost") * 3', "MCP edits a formula", mcpEdit.text);
  const mcpQuery = await callTool(ids.owner, "query_database", {
    database_id: tasks.id,
    filters: [{ property: "Double cost", op: "gt", value: 500 }],
  });
  const queried = mcpQuery.data.rows.map((r: { title: string; properties: Values }) => [r.title, r.properties["Double cost"]]);
  check(JSON.stringify(queried) === JSON.stringify([["Build", 750], ["Secret", 15000]]), "MCP queries filter on formulas and return their values", queried);

  // ---- Rollups ----
  const rel = await addProperty(ids.owner, projects.id, {
    name: "Tasks",
    type: "relation",
    relation: { databaseId: tasks.id, twoWay: true, pairedName: "Project" },
  });
  const budget = await addProperty(ids.owner, projects.id, { name: "Budget", type: "number" });
  const rollup = (name: string, targetPropertyId: string, fn: string, display?: string) =>
    addProperty(ids.owner, projects.id, {
      name,
      type: "rollup",
      rollup: { relationPropertyId: rel.id, targetPropertyId, function: fn, ...(display ? { display } : {}) },
    });
  const total = await rollup("Total hours", hours.id, "sum");
  const count = await rollup("Task count", "title", "count_all");
  const progress = await rollup("Progress", done.id, "percent_checked", "bar");
  const names = await rollup("Task names", "title", "show_original");
  const first = await rollup("First due", due.id, "earliest_date");
  const costs = await rollup("Costs", cost.id, "sum");
  const perHour = await addProperty(ids.owner, projects.id, {
    name: "Budget per hour",
    type: "formula",
    formula: { expression: 'prop("Budget") / prop("Total hours")' },
  });
  check(progress.options.rollup?.display === "bar", "a rollup keeps how it shows a percentage", progress.options);
  const alpha = await createPage(actor, { workspaceId, parentId: projects.id, title: "Alpha", properties: { Budget: 1600, Tasks: [t1.id, t2.id, t4.id] } });
  const beta = await createPage(actor, { workspaceId, parentId: projects.id, title: "Beta", properties: { Budget: 10, Tasks: [t3.id] } });
  void beta;

  let pv = await valuesOf(projects.id);
  const alphaValues = pv.get("Alpha")!;
  check(alphaValues[total.id] === 108 && alphaValues[count.id] === 3, "a rollup sums and counts the linked rows", alphaValues);
  check(Math.abs((alphaValues[progress.id] as number) - 2 / 3) < 1e-9, "a rollup works out the share checked", alphaValues[progress.id]);
  check(JSON.stringify(alphaValues[names.id]) === JSON.stringify(["Design", "Build", "Secret"]), "a rollup shows the linked titles", alphaValues[names.id]);
  check(alphaValues[first.id] === "2020-01-10", "a rollup finds the earliest date", alphaValues[first.id]);
  check(alphaValues[costs.id] === 5400, "a rollup calculates over a formula of the related database", alphaValues[costs.id]);
  check(Math.abs((alphaValues[perHour.id] as number) - 1600 / 108) < 1e-9, "formulas are worked out after rollups", alphaValues[perHour.id]);
  check(pv.get("Beta")![total.id] === 0 && errorCode(pv.get("Beta")![perHour.id]) === "divisionByZero", "a rollup over zero hours feeds a failing formula");

  const byProgress = await listRows(ids.owner, projects.id, { filters: [{ propertyId: progress.id, op: "gt", value: 50 }] });
  check(byProgress.map((r) => r.title).join() === "Alpha", "rollup percentages filter by the percent shown", byProgress.map((r) => r.title));
  // A sum of a number property takes its format when read, and filters by what it shows.
  await updateProperty(ids.owner, hours.id, { number: { format: "percent" } });
  const asPercent = (await getProperties(projects.id)).find((p) => p.id === total.id);
  check(asPercent?.options.rollup?.number?.format === "percent", "a rollup's sum takes the format of the property it reads", asPercent?.options);
  const byPercentTotal = await listRows(ids.owner, projects.id, { filters: [{ propertyId: total.id, op: "gt", value: 10_000 }] });
  check(byPercentTotal.map((r) => r.title).join() === "Alpha", "…and filters by the percent shown (108 is 10,800 %)", byPercentTotal.map((r) => r.title));
  await updateProperty(ids.owner, hours.id, { number: null });
  check(!(await getProperties(projects.id)).find((p) => p.id === total.id)?.options.rollup?.number, "a plain number again leaves the rollup plain");
  const [stored] = await db.select({ options: databaseProperty.options }).from(databaseProperty).where(eq(databaseProperty.id, total.id));
  check(stored && !stored.options.rollup?.number, "the format is never stored on the rollup", stored?.options);
  const byTotal = await listRows(ids.owner, projects.id, { sorts: [{ propertyId: total.id, direction: "asc" }] });
  check(byTotal.map((r) => r.title).join() === "Beta,Alpha", "rows sort by a rollup");
  const namesFilter = await listRows(ids.owner, projects.id, { filters: [{ propertyId: names.id, op: "contains", value: "ship" }] });
  check(namesFilter.map((r) => r.title).join() === "Beta", "rows filter by the values a rollup shows");

  // Only the related rows the reader can see count.
  await setPagePermission(ids.owner, t4.id, ids.owner, "full");
  await setPagePermission(ids.owner, t4.id, null, "none");
  const memberView = (await valuesOf(projects.id, ids.member)).get("Alpha")!;
  check(
    memberView[total.id] === 8 && memberView[count.id] === 2 && JSON.stringify(memberView[names.id]) === JSON.stringify(["Design", "Build"]),
    "a rollup leaves out related rows the reader can't see",
    memberView,
  );
  check((await valuesOf(projects.id)).get("Alpha")![total.id] === 108, "…while those who can see them still count them");

  // Rollups follow edits of the related rows.
  await updateRowProperties(ids.owner, t2.id, { Effort: 7 });
  check((await valuesOf(projects.id)).get("Alpha")![total.id] === 110, "a rollup follows edits of the related rows");

  check(
    await rejects(() => rollup("Bad", "title", "sum"), "invalidRollup"),
    "a rollup function that doesn't fit the property is refused",
  );
  check(
    await rejects(
      () => addProperty(ids.owner, projects.id, { name: "Bad", type: "rollup", rollup: { relationPropertyId: budget.id, targetPropertyId: "title", function: "count_all" } }),
      "invalidRollup",
    ),
    "a rollup must read through a relation",
  );
  check(await rejects(() => updateRowProperties(ids.owner, alpha.id, { "Total hours": 1 }), "readOnlyProperty"), "rollup values can't be written");

  // MCP: by names
  const mcpRollup = await callTool(ids.owner, "add_database_property", {
    database_id: projects.id,
    name: "Latest due",
    type: "rollup",
    rollup: { relation: "Tasks", property: "Due", function: "latest_date" },
  });
  check(
    !mcpRollup.isError &&
      mcpRollup.data.property.rollup.relation === "Tasks" &&
      mcpRollup.data.property.rollup.property === "Due" &&
      mcpRollup.data.property.rollup.result_type === "date",
    "MCP adds a rollup by relation and property names",
    mcpRollup.text,
  );
  const mcpRollupEdit = await callTool(ids.owner, "update_database_property", {
    database_id: projects.id,
    property: "Latest due",
    rollup: { property: "Effort", function: "max" },
  });
  check(
    !mcpRollupEdit.isError && mcpRollupEdit.data.property.rollup.function === "max" && mcpRollupEdit.data.property.rollup.property === "Effort",
    "MCP changes what a rollup calculates",
    mcpRollupEdit.text,
  );
  const mcpRows = await callTool(ids.owner, "query_database", { database_id: projects.id, sorts: [{ property: "Total hours", direction: "desc" }] });
  const alphaRow = mcpRows.data.rows[0];
  check(alphaRow.title === "Alpha" && alphaRow.properties["Total hours"] === 110 && alphaRow.properties["Latest due"] === 100, "MCP returns rollup values", alphaRow);

  // Published pages show neither relations nor rollups; formulas still work.
  const { token } = await publishPage(ids.owner, root.id);
  const publishedTasks = await getPublishedPage(token, tasks.id);
  const publishedRow = publishedTasks?.database?.rows.find((r) => r.title === "Build");
  check(publishedRow?.properties[cost.id] === 350, "published databases show formula values", publishedRow);
  const publishedProjects = await getPublishedPage(token, projects.id);
  const shownTypes = publishedProjects?.database?.properties.map((p) => p.type) ?? [];
  const alphaPublished = publishedProjects?.database?.rows.find((r) => r.title === "Alpha");
  check(
    !shownTypes.includes("rollup") && !shownTypes.includes("relation") && alphaPublished && !(total.id in alphaPublished.properties),
    "published databases leave rollups out",
    { shownTypes, alphaPublished },
  );

  // Duplicating keeps formulas and rollups pointing at the copies.
  const copy = await duplicatePage(actor, root.id, " (copy)");
  const copiedDbs = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(and(eq(page.parentId, copy.id), eq(page.kind, "database")));
  const copiedProjects = copiedDbs.find((d) => d.title === "Projects")!;
  const copiedTasks = copiedDbs.find((d) => d.title === "Tasks")!;
  const copiedProps = await getProperties(copiedProjects.id);
  const copiedTotal = copiedProps.find((p) => p.name === "Total hours")!;
  const copiedTaskProps = await getProperties(copiedTasks.id);
  check(
    copiedTotal.options.rollup?.targetPropertyId === copiedTaskProps.find((p) => p.name === "Effort")?.id &&
      copiedTotal.options.rollup?.relationPropertyId === copiedProps.find((p) => p.name === "Tasks")?.id,
    "a duplicated rollup reads the copied relation and property",
    copiedTotal.options,
  );
  const copiedValues = (await valuesOf(copiedProjects.id)).get("Alpha")!;
  check(copiedValues[copiedTotal.id] === 110, "…and works out the same value", copiedValues);
  const copiedCost = (await valuesOf(copiedTasks.id)).get("Build")![copiedTaskProps.find((p) => p.name === "Cost")!.id];
  check(copiedCost === 350, "a duplicated formula uses the copied properties", copiedCost);

  // Deleting what a rollup or formula reads shows an error in every row.
  await deleteProperty(ids.owner, hours.id);
  pv = await valuesOf(projects.id);
  check(errorCode(pv.get("Alpha")![total.id]) === "rollupTarget", "a rollup whose property was deleted shows why", pv.get("Alpha")![total.id]);
  check(errorCode(pv.get("Alpha")![perHour.id]) === "referenceError", "…and so do formulas using it", pv.get("Alpha")![perHour.id]);
  tv = await valuesOf(tasks.id);
  check(errorCode(tv.get("Build")![cost.id]) === "unknownProperty", "a formula whose property was deleted shows why", tv.get("Build")![cost.id]);
  check(errorCode(tv.get("Build")![a.id]) === "referenceError", "…and so do formulas using that formula", tv.get("Build")![a.id]);
  await deleteProperty(ids.owner, rel.id);
  pv = await valuesOf(projects.id);
  check(errorCode(pv.get("Alpha")![count.id]) === "rollupRelation", "a rollup whose relation was deleted shows why", pv.get("Alpha")![count.id]);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
