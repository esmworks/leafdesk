/**
 * End-to-end check of dependencies against the database: turning them on (taking a timeline's
 * dates) and off, rows refused waiting for themselves (from either side), waiting rows following
 * the rows they wait for by each rule (down the chain, weekends skipped, newly linked rows moved
 * out of the way, rows dated by the same write kept), copies of the database, and the same over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/dependencies-e2e.ts
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
  getProperties,
  setDependencies,
  setSubItems,
  updateRowProperties,
  updateRowsProperties,
  updateView,
} = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { PropertyValueError } = await import("@/lib/properties");
const { blockedByProperty, blockingProperty, dependencySettings } = await import("@/lib/dependencies");

const RUN = `dependencies-e2e-${Date.now().toString(36)}`;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dependencies-e2e", version: "1" } },
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
/** A day of October 2026 (the 5th is a Monday). */
const oct = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([{ workspaceId, userId: ids.owner, role: "owner" }]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const start = await addProperty(ids.owner, tasks.id, { name: "Start", type: "date" });
  const end = await addProperty(ids.owner, tasks.id, { name: "End", type: "date" });
  const timeline = await addView(ids.owner, tasks.id, { name: "Timeline", type: "timeline" });
  await updateView(ids.owner, timeline.id, { config: { dateBy: start.id, endDateBy: end.id } });

  // Turning on adds a two-way relation and takes the timeline's dates
  const by = await setDependencies(ids.owner, tasks.id, { on: true, names: { blockedBy: "Blocked by", blocking: "Blocking" } });
  let props = await getProperties(tasks.id);
  const blocking = blockingProperty(props)!;
  check(
    by && blockedByProperty(props)?.id === by.id && by.name === "Blocked by" && blocking?.name === "Blocking",
    "turning dependencies on adds Blocked by and its other side, Blocking",
    props.map((p) => [p.name, p.options]),
  );
  check(
    JSON.stringify(dependencySettings(blockedByProperty(props)!, props)) ===
      JSON.stringify({ shift: "overlap", skipWeekends: false, start: start.id, end: end.id }),
    "without dates given they come from the timeline (not the first date property, Due)",
    dependencySettings(blockedByProperty(props)!, props),
  );
  const again = await setDependencies(ids.owner, tasks.id, { on: true });
  check(again?.id === by.id && (await getProperties(tasks.id)).length === props.length, "turning them on again adds nothing");

  // Sub-items and dependencies keep to their own relations
  const parent = await setSubItems(ids.owner, tasks.id, { on: true, names: { parent: "Parent", subItems: "Children" } });
  check(
    await rejects(() => setDependencies(ids.owner, tasks.id, { on: true, propertyId: parent!.id }), "notDependencyRelation"),
    "the sub-items' parent property can't hold dependencies",
  );
  check(
    await rejects(() => setSubItems(ids.owner, tasks.id, { on: true, propertyId: blocking.id }), "notSubItemsRelation"),
    "Blocking can't hold sub-items' parents",
  );
  check(blockedByProperty(await getProperties(tasks.id))?.id === by.id, "turning sub-items on keeps dependencies on");
  check(
    await rejects(() => setDependencies(ids.owner, tasks.id, { on: true, settings: { startPropertyId: parent!.id } }), "invalidDependencySettings"),
    "dates must be date properties",
  );

  const row = async (title: string, properties: Record<string, unknown> = {}) =>
    (await createPage(actor, { workspaceId, parentId: tasks.id, title, properties })).id;
  const dates = async (id: string) => {
    const [r] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, id));
    const day = (v: unknown) => (typeof v === "string" ? v.slice(8) : "-");
    return `${day(r.properties[start.id])}-${day(r.properties[end.id])}`;
  };
  const a = await row("A", { [start.id]: oct(5), [end.id]: oct(7) });
  const b = await row("B", { [start.id]: oct(8), [end.id]: oct(9), [by.id]: [a] });
  const c = await row("C", { [start.id]: oct(12), [by.id]: [b] });
  const u = await row("Undated", { [by.id]: [a] });
  check((await dates(b)) === "08-09", "a new row waiting for an earlier row keeps its dates");

  // overlap: A now ends on the 9th, B (and C after it) move
  await updateRowProperties(ids.owner, a, { [end.id]: oct(9) });
  check(
    (await dates(b)) === "10-11" && (await dates(c)) === "12--" && (await dates(u)) === "---",
    "A ending later moves B after it; C (still after B) and the undated row stay",
    [await dates(b), await dates(c), await dates(u)],
  );
  await updateRowProperties(ids.owner, a, { [end.id]: oct(12) });
  check(
    (await dates(b)) === "13-14" && (await dates(c)) === "15--",
    "moving A further takes B and C down the chain; C, without an end, keeps none",
    [await dates(b), await dates(c)],
  );

  // Loops are refused from either side
  check(await rejects(() => updateRowProperties(ids.owner, a, { [by.id]: [c] }), "dependencyLoop"), "A can't wait for C, which waits for it");
  check(await rejects(() => updateRowProperties(ids.owner, a, { [by.id]: [a] }), "dependencyLoop"), "A can't wait for itself");
  check(
    await rejects(() => updateRowProperties(ids.owner, c, { [blocking.id]: [a] }), "dependencyLoop"),
    "C can't block A, which it waits for",
  );
  check(
    await rejects(() => updateRowsProperties(ids.owner, tasks.id, [a, u], { [by.id]: [b] }), "dependencyLoop"),
    "bulk edit refuses making A wait for B",
  );

  // A row newly linked from the Blocking side moves out of the way
  const e = await row("E", { [start.id]: oct(6), [end.id]: oct(7) });
  await updateRowProperties(ids.owner, a, { [blocking.id]: [b, u, e] });
  check((await dates(e)) === "13-14", "listing E under A's Blocking moves it after A", await dates(e));

  // The same write dating B keeps B where it was put
  await updateRowsProperties(ids.owner, tasks.id, [a], { [end.id]: oct(14) });
  check((await dates(b)) === "15-16" && (await dates(e)) === "15-16", "bulk editing A's end moves the rows waiting for it");
  await updateRowProperties(ids.owner, b, { [start.id]: oct(5), [end.id]: oct(6) });
  check((await dates(b)) === "05-06", "a waiting row dated before its blocker ends stays (shown in red)");
  await updateRowProperties(ids.owner, b, { [start.id]: oct(15), [end.id]: oct(16) });

  // keep_gap: A ending two days earlier pulls B, C and E in by two days, never before A ends
  await setDependencies(ids.owner, tasks.id, { on: true, settings: { shift: "keep_gap" } });
  await updateRowProperties(ids.owner, a, { [end.id]: oct(12) });
  check(
    (await dates(b)) === "13-14" && (await dates(e)) === "13-14" && (await dates(c)) === "15--",
    "keep_gap moves the waiting rows earlier by as much",
    [await dates(b), await dates(e), await dates(c)],
  );
  await updateRowProperties(ids.owner, a, { [end.id]: oct(13) });
  check((await dates(b)) === "14-15" && (await dates(c)) === "16--", "and later by as much", [await dates(b), await dates(c)]);

  // Weekends: A ending on Friday the 16th would start B on Saturday
  await setDependencies(ids.owner, tasks.id, { on: true, settings: { shift: "overlap", skipWeekends: true } });
  await updateRowProperties(ids.owner, a, { [end.id]: oct(16) });
  check((await dates(b)) === "19-20", "skipping weekends starts B on Monday the 19th", await dates(b));

  // none: nothing moves
  await setDependencies(ids.owner, tasks.id, { on: true, settings: { shift: "none" } });
  await updateRowProperties(ids.owner, a, { [end.id]: oct(25) });
  check((await dates(b)) === "19-20", "with the none rule rows stay");

  // MCP
  const mcpOn = await callTool(ids.owner, "set_dependencies", {
    database_id: tasks.id,
    on: true,
    shift: "overlap",
    skip_weekends: false,
    start_property: "Start",
    end_property: null,
  });
  check(
    mcpOn.data?.dependencies === true &&
      mcpOn.data.blocked_by_property === "Blocked by" &&
      mcpOn.data.blocking_property === "Blocking" &&
      mcpOn.data.shift === "overlap" &&
      mcpOn.data.start_property === "Start" &&
      mcpOn.data.end_property === null,
    "set_dependencies changes the settings",
    mcpOn,
  );
  const wrongDate = await callTool(ids.owner, "set_dependencies", { database_id: tasks.id, on: true, start_property: "Parent" });
  check(wrongDate.isError, "set_dependencies refuses a start that isn't a date", wrongDate.text);
  const described = await callTool(ids.owner, "get_database", { database_id: tasks.id });
  const describedProps = described.data?.properties as { name: string; dependency_role?: string; dependencies?: { shift: string } }[];
  check(
    describedProps.find((p) => p.name === "Blocked by")?.dependency_role === "blocked_by" &&
      describedProps.find((p) => p.name === "Blocked by")?.dependencies?.shift === "overlap" &&
      describedProps.find((p) => p.name === "Blocking")?.dependency_role === "blocking",
    "get_database names each side of dependencies and the rule",
    describedProps,
  );
  const loop = await callTool(ids.owner, "update_database_row", { row_id: a, properties: { "Blocked by": "C" } });
  check(loop.isError && loop.text.includes("wait"), "an MCP write closing a loop is refused", loop.text);
  await callTool(ids.owner, "update_database_row", { row_id: a, properties: { Start: oct(26) } });
  check((await dates(b)).startsWith("27"), "an MCP write moving A moves B (start only now)", await dates(b));

  // A copy of the database keeps dependencies on its own properties
  await setDependencies(ids.owner, tasks.id, { on: true, settings: { endPropertyId: end.id } });
  const copied = await duplicatePage(actor, tasks.id, " (copy)");
  const copyProps = await getProperties(copied.id);
  const copyBy = blockedByProperty(copyProps);
  const copySettings = copyBy && dependencySettings(copyBy, copyProps);
  check(
    copyBy?.options.relation?.databaseId === copied.id &&
      copyProps.find((p) => p.id === copySettings?.start)?.name === "Start" &&
      copyProps.find((p) => p.id === copySettings?.end)?.name === "End" &&
      copySettings?.start !== start.id,
    "a copied database keeps dependencies on its own date properties",
    copyProps.map((p) => [p.name, p.id, p.options]),
  );

  // Off keeps the links, and nothing moves any more
  const off = await callTool(ids.owner, "set_dependencies", { database_id: tasks.id, on: false });
  props = await getProperties(tasks.id);
  const before = await dates(b);
  await updateRowProperties(ids.owner, a, { [start.id]: oct(30), [end.id]: oct(31) });
  const [bRow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, b));
  check(
    off.data?.dependencies === false && !blockedByProperty(props) && (await dates(b)) === before && (bRow.properties[by.id] as string[]).includes(a),
    "turning dependencies off keeps the links and stops moving rows",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
