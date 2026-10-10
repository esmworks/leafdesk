/**
 * End-to-end check of sub-items against the database: turning them on (new properties or a
 * relation the database already has) and off, a row holding one parent whichever side of the
 * relation is edited (the parent's list of sub-items included), rows refused under themselves or
 * their own sub-items (one row, in bulk, from either side), new rows made with a parent, the view
 * setting, copies of the parent property, and the same over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/sub-items-e2e.ts
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
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const {
  addProperty,
  addView,
  deleteProperty,
  duplicateProperty,
  getProperties,
  moveRow,
  restoreProperty,
  setSubItems,
  updateRowProperties,
  updateRowsProperties,
  updateView,
} = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { createFromTemplate, createRowTemplate } = await import("@/server/templates");
const { PropertyValueError } = await import("@/lib/properties");
const { parentProperty, subItemsProperty } = await import("@/lib/sub-items");

const RUN = `sub-items-e2e-${Date.now().toString(36)}`;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "sub-items-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([{ workspaceId, userId: ids.owner, role: "owner" }]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const other = await createPage(actor, { workspaceId, kind: "database", title: "Other" });

  // Turning on adds a two-way relation of the database with itself
  const parent = await setSubItems(ids.owner, tasks.id, { on: true, names: { parent: "Parent", subItems: "Children" } });
  let props = await getProperties(tasks.id);
  const children = subItemsProperty(props);
  check(
    parent && parentProperty(props)?.id === parent.id && parent.name === "Parent" && children?.name === "Children",
    "turning sub-items on adds Parent and its other side, Children",
    props.map((p) => [p.name, p.options]),
  );
  const again = await setSubItems(ids.owner, tasks.id, { on: true, names: { parent: "Parent", subItems: "Children" } });
  check(again?.id === parent.id && (await getProperties(tasks.id)).length === props.length, "turning them on again adds nothing");

  const row = async (title: string, properties: Record<string, unknown> = {}) =>
    (await createPage(actor, { workspaceId, parentId: tasks.id, title, properties })).id;
  const [a, b, c, d] = [await row("A"), await row("B"), await row("C"), await row("D")];
  const values = async (id: string) => {
    const [r] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, id));
    const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    return { parent: ids(r.properties[parent.id]), children: ids(r.properties[children.id]) };
  };

  await updateRowProperties(ids.owner, b, { [parent.id]: [a] });
  check((await values(a)).children.join() === b, "setting B's parent lists B under A");

  await updateRowProperties(ids.owner, b, { [parent.id]: [a, c] });
  check(
    (await values(b)).parent.join() === c && !(await values(a)).children.length && (await values(c)).children.join() === b,
    "a second parent replaces the first: B moves from A to C",
    [await values(a), await values(b), await values(c)],
  );

  await updateRowProperties(ids.owner, a, { [children.id]: [b, d] });
  check(
    (await values(b)).parent.join() === a && (await values(d)).parent.join() === a && !(await values(c)).children.length,
    "listing B and D as A's sub-items makes A their only parent and takes B off C's list",
    [await values(a), await values(b), await values(c), await values(d)],
  );

  check(await rejects(() => updateRowProperties(ids.owner, a, { [parent.id]: [b] }), "subItemLoop"), "A can't go under its own sub-item B");
  check(await rejects(() => updateRowProperties(ids.owner, a, { [parent.id]: [a] }), "subItemLoop"), "A can't be its own parent");
  const grand = await row("B1", { [parent.id]: [b] });
  check(
    await rejects(() => updateRowProperties(ids.owner, a, { [parent.id]: [grand] }), "subItemLoop"),
    "A can't go under B1, a sub-item of its sub-item",
  );
  check(
    await rejects(() => updateRowProperties(ids.owner, grand, { [children.id]: [a] }), "subItemLoop"),
    "B1 can't list its own grandparent A as a sub-item",
  );
  check(
    await rejects(() => updateRowsProperties(ids.owner, tasks.id, [c, a], { [parent.id]: [grand] }), "subItemLoop"),
    "bulk edit refuses putting A under B1, and changes nothing",
  );
  check(!(await values(c)).parent.length, "the refused bulk edit left C alone");
  const bulk = await updateRowsProperties(ids.owner, tasks.id, [c, d], { [parent.id]: [grand] });
  check(
    bulk.done.length === 2 && (await values(grand)).children.sort().join() === [c, d].sort().join() && !(await values(a)).children.includes(d),
    "bulk edit moves C and D under B1",
    [await values(grand), await values(a)],
  );
  check((await values(b)).children.join() === grand, "a new row made with a parent is listed under it");

  // A board grouped by Parent: dragging A into the column of B1 (its grandchild) is refused
  check(
    await rejects(() => moveRow(ids.owner, a, { groupBy: parent.id, groupValue: grand, groupFrom: null }), "subItemLoop"),
    "dragging A on a board into the column of its own sub-item is refused",
  );

  // A copy of B sits under B's parent, without taking B's sub-items
  const bCopy = await duplicatePage(actor, b, " (copy)");
  check(
    (await values(bCopy.id)).parent.join() === a &&
      !(await values(bCopy.id)).children.length &&
      (await values(grand)).parent.join() === b &&
      (await values(b)).children.join() === grand,
    "a copied row keeps its parent and leaves the sub-items with the original",
    [await values(bCopy.id), await values(grand), await values(b)],
  );
  const template = await createRowTemplate(actor, tasks.id, { title: "From template" });
  await db
    .update(page)
    .set({ properties: { [parent.id]: [a], [children.id]: [grand] } })
    .where(eq(page.id, template.id));
  const fromTemplate = await createFromTemplate(actor, template.id, {});
  check(
    !(await values(fromTemplate.id)).children.length && (await values(grand)).parent.join() === b,
    "a row made from a template listing sub-items doesn't take them",
    [await values(fromTemplate.id), await values(grand)],
  );

  // View setting
  const table = await addView(ids.owner, tasks.id, { name: "Tree", type: "table" });
  await updateView(ids.owner, table.id, { config: { subItems: "parents" } });
  check(
    await rejects(() => updateView(ids.owner, table.id, { config: { subItems: "tree" as never } }), "invalidViewConfig"),
    "a view refuses an unknown sub-items display",
  );

  // A copy of the parent property is a plain relation
  const copy = await duplicateProperty(ids.owner, parent.id, "Parent copy");
  check(!copy.options.relation?.role && parentProperty(await getProperties(tasks.id))?.id === parent.id, "a copy of Parent doesn't hold parents");

  // Only a relation of the database with itself can hold parents
  const elsewhere = await addProperty(ids.owner, tasks.id, { name: "Elsewhere", type: "relation", relation: { databaseId: other.id } });
  check(
    await rejects(() => setSubItems(ids.owner, tasks.id, { on: true, propertyId: elsewhere.id }), "notSubItemsRelation"),
    "a relation to another database can't hold parents",
  );

  // Off keeps the properties and their links; on again with the same relation
  await setSubItems(ids.owner, tasks.id, { on: false });
  props = await getProperties(tasks.id);
  check(
    !parentProperty(props) && props.some((p) => p.id === parent.id) && (await values(b)).parent.join() === a,
    "turning sub-items off keeps Parent and its links",
  );
  const twoParents = await updateRowProperties(ids.owner, b, { [parent.id]: [a, c] });
  check((twoParents[parent.id] as string[]).length === 2, "with sub-items off, Parent is an ordinary relation again");
  await updateRowProperties(ids.owner, b, { [parent.id]: [a] });

  // Over MCP
  const on = await callTool(ids.owner, "set_sub_items", { database_id: tasks.id, on: true, parent_property: "Parent" });
  check(
    on.data?.sub_items === true && on.data.parent_property === "Parent" && on.data.sub_items_property === "Children",
    "set_sub_items turns them on with an existing relation",
    on,
  );
  const described = await callTool(ids.owner, "get_database", { database_id: tasks.id });
  const roles = Object.fromEntries(
    (described.data.properties as { name: string; sub_items_role?: string }[]).map((p) => [p.name, p.sub_items_role]),
  );
  check(roles.Parent === "parent" && roles.Children === "sub_items" && !roles["Parent copy"], "get_database names the sub-items properties", roles);
  const viewed = await callTool(ids.owner, "update_database_view", { database_id: tasks.id, view_id: table.id, sub_items: "flat" });
  check(viewed.data?.sub_items === "flat", "update_database_view sets how sub-items show", viewed);
  const board = await callTool(ids.owner, "create_database_view", { database_id: tasks.id, name: "Board", type: "board", sub_items: "flat" });
  check(board.isError && /sub_items only applies to table, list and timeline/.test(board.text), "sub_items is refused on a board", board.text);
  const loop = await callTool(ids.owner, "update_database_row", { row_id: a, properties: { Parent: "B" } });
  check(loop.isError && /under itself/.test(loop.text), "MCP refuses putting A under B", loop.text);

  // Deleting one side deletes its pair, turning sub-items off; restoring brings both back
  await deleteProperty(ids.owner, children.id);
  props = await getProperties(tasks.id);
  check(!parentProperty(props) && !subItemsProperty(props), "deleting Children deletes Parent with it");
  await restoreProperty(ids.owner, children.id);
  props = await getProperties(tasks.id);
  check(parentProperty(props)?.id === parent.id && subItemsProperty(props)?.id === children.id, "restoring Children brings sub-items back");
  const off = await callTool(ids.owner, "set_sub_items", { database_id: tasks.id, on: false });
  check(off.data?.sub_items === false && !parentProperty(await getProperties(tasks.id)), "set_sub_items turns them off");
  const named = await callTool(ids.owner, "set_sub_items", {
    database_id: tasks.id,
    on: true,
    parent_property_name: "Epic",
    sub_items_property_name: "Stories",
  });
  check(named.data?.parent_property === "Epic" && named.data.sub_items_property === "Stories", "set_sub_items names new properties", named);

  // A copy of the database keeps its sub-items, pointing at its own rows
  const copied = await duplicatePage(actor, tasks.id, " (copy)");
  const copyProps = await getProperties(copied.id);
  const copyParent = parentProperty(copyProps);
  check(
    copyParent?.name === "Epic" && copyParent.options.relation?.databaseId === copied.id && subItemsProperty(copyProps)?.name === "Stories",
    "a copied database keeps sub-items on its own rows",
    copyProps.map((p) => [p.name, p.options]),
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
