/**
 * End-to-end check of unique ID properties: numbering the rows a database has when the property
 * is added (in the order they were made), rows created at the same time getting numbers of their
 * own, writes refused, a duplicated row getting a new number and a duplicated database keeping its
 * rows' (without a prefix another database has), deleting and restoring the property, changing
 * its type away and back, prefixes (checked, upper case, one per workspace), filters by "TASK-12",
 * search by ID, relation pickers, and the MCP tools and REST API reading IDs and refusing writes.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/unique-id-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be
 * applied. Needs no running server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseProperty, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { PropertyValueError } = await import("@/lib/properties");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, searchPages } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const databases = await import("@/server/databases");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");

const RUN = `uid-e2e-${Date.now().toString(36)}`;
// Prefixes are unique in a workspace; this run's own workspaces keep runs apart.
const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof PropertyValueError) return error.code ?? "property";
    throw error;
  }
}

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
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
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "unique-id-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** A REST API call, handed to the handler directly; no server listens on this address. */
async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await handleApiRequest(
    new Request(`http://uid-e2e.localhost/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: parsed as any };
}

const numberOf = async (rowId: string, propertyId: string) =>
  ((await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0]?.properties ?? {})[propertyId];
const numbersIn = async (databaseId: string, propertyId: string) =>
  (await db.select({ id: page.id, title: page.title, properties: page.properties }).from(page).where(eq(page.parentId, databaseId))).map(
    (r) => ({ id: r.id, title: r.title, n: r.properties[propertyId] as number | undefined }),
  );
const lastNumber = async (propertyId: string) =>
  (await db.select({ n: databaseProperty.lastNumber }).from(databaseProperty).where(eq(databaseProperty.id, propertyId)))[0]?.n;

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.owner, role: "owner" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const notes = await databases.addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });

  // Numbering the rows already there, in the order they were made
  const before: { id: string }[] = [];
  for (const title of ["First", "Second", "Third"]) before.push((await databases.createRows(ids.owner, tasks.id, [{ title }]))[0]);
  const uid = await databases.addProperty(ids.owner, tasks.id, { name: "ID", type: "unique_id", prefix: " task- " });
  check(uid.options.uniqueId?.prefix === "TASK", "the prefix is stored in upper case, without a dash", uid.options);
  const numbered = await Promise.all(before.map((r) => numberOf(r.id, uid.id)));
  check(JSON.stringify(numbered) === "[1,2,3]", "adding the property numbers the rows in the order they were made", numbered);
  check((await lastNumber(uid.id)) === 3, "…and its counter is at the last number");

  // Rows made at the same time
  const singles = await Promise.all(Array.from({ length: 10 }, (_, i) => databases.createRows(ids.owner, tasks.id, [{ title: `Parallel ${i}` }])));
  const batch = await databases.createRows(ids.owner, tasks.id, Array.from({ length: 5 }, (_, i) => ({ title: `Batch ${i}` })));
  const made = [...singles.flat(), ...batch];
  const madeNumbers = (await Promise.all(made.map((r) => numberOf(r.id, uid.id)))) as number[];
  const sorted = [...madeNumbers].sort((a, b) => a - b);
  check(
    JSON.stringify(sorted) === JSON.stringify(Array.from({ length: 15 }, (_, i) => i + 4)),
    "rows created at the same time each get a number of their own, without gaps",
    madeNumbers,
  );
  const batchNumbers = madeNumbers.slice(10);
  check(batchNumbers.every((n, i) => i === 0 || n === batchNumbers[i - 1] + 1), "…and rows added together are numbered in their order", batchNumbers);
  check((await lastNumber(uid.id)) === 18, "the counter follows", await lastNumber(uid.id));

  // Writes
  check((await failure(() => databases.updateRowProperties(ids.owner, before[0].id, { [uid.id]: 99 }))) === "readOnlyProperty", "a row's ID can't be written");
  check(
    (await failure(() => databases.createRows(ids.owner, tasks.id, [{ title: "Forced", properties: { [uid.id]: 1 } }]))) === "readOnlyProperty",
    "…not even on a new row",
  );
  await databases.updateRowProperties(ids.owner, before[0].id, { [notes.id]: "edited" });
  check((await numberOf(before[0].id, uid.id)) === 1, "editing a row keeps its number");
  await db.update(page).set({ properties: { [uid.id]: 500, [notes.id]: "raw" } }).where(eq(page.id, before[1].id));
  check((await numberOf(before[1].id, uid.id)) === 2, "…even a write straight to the database", await numberOf(before[1].id, uid.id));
  await db.insert(page).values({ id: `${RUN}-raw`, workspaceId, parentId: tasks.id, kind: "page", title: "Raw", properties: { [uid.id]: 2 }, createdBy: ids.owner });
  check((await numberOf(`${RUN}-raw`, uid.id)) === 19, "a row inserted straight into the table gets the next number, not the one it brought");

  // Duplicating
  const copy = await duplicatePage(actor, before[0].id);
  check((await numberOf(copy.id, uid.id)) === 20, "a duplicated row gets a new number", await numberOf(copy.id, uid.id));
  const tasksCopy = await duplicatePage(actor, tasks.id);
  const [copiedProp] = (await databases.getProperties(tasksCopy.id)).filter((p) => p.type === "unique_id");
  const copiedRows = await numbersIn(tasksCopy.id, copiedProp.id);
  check(
    copiedRows.find((r) => r.title === "First")?.n === 1 && copiedRows.find((r) => r.title === "Third")?.n === 3,
    "a duplicated database keeps its rows' numbers",
    copiedRows,
  );
  check(!copiedProp.options.uniqueId?.prefix, "…and leaves out a prefix the workspace has already", copiedProp.options);
  const [afterCopy] = await databases.createRows(ids.owner, tasksCopy.id, [{ title: "New in copy" }]);
  check((await numberOf(afterCopy.id, copiedProp.id)) === 21, "…and goes on after its highest number", await numberOf(afterCopy.id, copiedProp.id));

  // Prefixes
  const bugs = await createPage(actor, { workspaceId, kind: "database", title: "Bugs" });
  check(
    (await failure(() => databases.addProperty(ids.owner, bugs.id, { name: "ID", type: "unique_id", prefix: "Task" }))) === "uniqueIdPrefixTaken",
    "a prefix another database of the workspace has is refused",
  );
  check(
    (await failure(() => databases.addProperty(ids.owner, bugs.id, { name: "ID", type: "unique_id", prefix: "BU G" }))) === "invalidUniqueIdPrefix",
    "a prefix that isn't letters and digits is refused",
  );
  check(
    (await failure(() => databases.addProperty(ids.owner, bugs.id, { name: "ID", type: "unique_id", prefix: "ABCDEFGHIJK" }))) === "invalidUniqueIdPrefix",
    "…and one that is too long",
  );
  const elsewhere = await createPage(actor, { workspaceId: otherWorkspace, kind: "database", title: "Elsewhere" });
  const elsewhereId = await databases.addProperty(ids.owner, elsewhere.id, { name: "ID", type: "unique_id", prefix: "TASK" });
  check(elsewhereId.options.uniqueId?.prefix === "TASK", "another workspace may use the same prefix");
  const bugId = await databases.addProperty(ids.owner, bugs.id, { name: "ID", type: "unique_id", prefix: "bug" });
  check(
    (await failure(() => databases.addProperty(ids.owner, bugs.id, { name: "ID 2", type: "unique_id" }))) === "oneUniqueId",
    "a database has one unique ID property",
  );
  check(
    (await failure(() => databases.updateProperty(ids.owner, notes.id, { prefix: "X" }))) === "unsupportedType",
    "only unique IDs take a prefix",
  );
  await databases.updateProperty(ids.owner, bugId.id, { prefix: "Issue" });
  check(
    (await failure(() => databases.updateProperty(ids.owner, uid.id, { prefix: "issue" }))) === "uniqueIdPrefixTaken",
    "renaming a prefix to one that's taken is refused",
  );
  await databases.updateProperty(ids.owner, bugId.id, { prefix: null });
  await databases.updateProperty(ids.owner, uid.id, { prefix: "BUG" });
  check(
    (await databases.getProperties(tasks.id)).find((p) => p.id === uid.id)?.options.uniqueId?.prefix === "BUG",
    "a prefix let go of is free again",
  );
  check((await numberOf(before[2].id, uid.id)) === 3, "changing the prefix keeps the numbers");
  await databases.updateProperty(ids.owner, uid.id, { prefix: "TASK" });

  // Relation pickers
  const links = await databases.addProperty(ids.owner, bugs.id, { name: "Task", type: "relation", relation: { databaseId: tasks.id } });
  const targets = await databases.getRelationTargets(ids.owner, [links]);
  const firstTarget = targets[links.id].rows.find((r) => r.id === before[0].id);
  check(firstTarget?.uniqueId === "TASK-1", "relation pickers have each row's ID to find it by", firstTarget);

  // Filters
  const shown = await databases.getDatabase(ids.owner, tasks.id);
  const filtered = (await callTool(ids.owner, "query_database", { database_id: tasks.id, filters: [{ property: "ID", op: "equals", value: "task-2" }] })).data;
  check(filtered?.rows?.length === 1 && filtered.rows[0].title === "Second", "query_database filters by an ID as shown", filtered);
  check(filtered.rows[0].properties.ID === "TASK-2", "…and reads it as shown", filtered.rows[0]);
  const range = (await callTool(ids.owner, "query_database", { database_id: tasks.id, filters: [{ property: "ID", op: "lte", value: 3 }], sorts: [{ property: "ID", direction: "desc" }] })).data;
  check(JSON.stringify(range.rows.map((r: { title: string }) => r.title)) === '["Third","Second","First"]', "…compares and sorts by number", range.rows);
  const wrongPrefix = await callTool(ids.owner, "query_database", { database_id: tasks.id, filters: [{ property: "ID", op: "equals", value: "BUG-2" }] });
  check(wrongPrefix.isError && /TASK-12 or 12/.test(wrongPrefix.text), "…and says which IDs it takes", wrongPrefix.text);
  check(shown.properties.some((p) => p.id === uid.id), "the app's database has the property");

  // Search
  const found = await searchPages(ids.owner, "task-3", { workspaceId });
  check(found[0]?.id === before[2].id, "search finds a row by its ID", found.map((h) => h.title));
  const foundAll = await searchPages(ids.owner, "TASK-3");
  check(foundAll[0]?.id === before[2].id, "…across the user's workspaces too", foundAll.map((h) => h.title));
  const [elsewhereRow] = await databases.createRows(ids.owner, elsewhere.id, [{ title: "Elsewhere one" }]);
  const ownerHits = (await searchPages(ids.owner, "TASK-1")).map((h) => h.id);
  check(ownerHits.includes(before[0].id) && ownerHits.includes(elsewhereRow.id), "…in every workspace that numbers rows with the prefix", ownerHits);
  check(!(await searchPages(ids.member, "TASK-1")).some((h) => h.id === elsewhereRow.id), "…only where the user may look");
  const outsider = await searchPages(ids.owner, "BUG-3", { workspaceId });
  check(!outsider.some((h) => h.id === before[2].id), "…and not by another prefix");

  // MCP
  const described = (await callTool(ids.owner, "get_database", { database_id: tasks.id })).data;
  const describedId = described.properties.find((p: { name: string }) => p.name === "ID");
  check(describedId?.type === "unique_id" && describedId.prefix === "TASK" && describedId.read_only === true, "get_database describes the property", describedId);
  const write = await callTool(ids.owner, "update_database_row", { row_id: before[0].id, properties: { ID: 7 } });
  check(write.isError && /can't be changed/.test(write.text), "update_database_row refuses to write an ID", write.text);
  const added = await callTool(ids.owner, "add_database_property", { database_id: bugs.id, name: "Key", type: "unique_id", prefix: "x" });
  check(added.isError && /already numbers its rows/.test(added.text), "add_database_property keeps to one per database", added.text);
  const notesTry = await callTool(ids.owner, "add_database_property", { database_id: bugs.id, name: "Body", type: "text", prefix: "X" });
  check(notesTry.isError && /prefix only applies/.test(notesTry.text), "…and takes a prefix only for unique IDs", notesTry.text);
  const plans = await createPage(actor, { workspaceId, kind: "database", title: "Plans" });
  await databases.createRows(ids.owner, plans.id, [{ title: "Plan A" }, { title: "Plan B" }]);
  const planId = await callTool(ids.owner, "add_database_property", { database_id: plans.id, name: "Code", type: "unique_id", prefix: "plan" });
  check(!planId.isError && planId.data.property.prefix === "PLAN", "add_database_property adds one with a prefix", planId.text);
  const renamed = await callTool(ids.owner, "update_database_property", { database_id: plans.id, property: "Code", prefix: null });
  check(!renamed.isError && renamed.data.property.prefix === null, "update_database_property removes the prefix", renamed.text);
  const plansRead = (await callTool(ids.owner, "query_database", { database_id: plans.id })).data;
  check(
    plansRead.rows.map((r: { properties: Record<string, unknown> }) => r.properties.Code).sort().join(",") === "1,2",
    "…and IDs then read as their numbers",
    plansRead.rows,
  );

  // REST API
  const { secret } = await createApiToken(ids.owner, { name: RUN, scopes: ["rows:read", "rows:write", "databases:read"] });
  const queried = await api("POST", `/databases/${tasks.id}/query`, secret, { filters: [{ property: "ID", op: "equals", value: "TASK-1" }] });
  check(queried.status === 200 && queried.body.rows?.[0]?.properties?.ID === "TASK-1", "the REST API filters by ID and reads it as shown", queried.body);
  const patched = await api("PATCH", `/rows/${before[0].id}`, secret, { properties: { ID: 5 } });
  check(patched.status === 400 && /can't be changed/.test(JSON.stringify(patched.body)), "…and refuses to write one", patched.body);

  // Deleting and restoring
  await databases.deleteProperty(ids.owner, uid.id);
  const [whileDeleted] = await databases.createRows(ids.owner, tasks.id, [{ title: "While deleted" }]);
  check((await numberOf(whileDeleted.id, uid.id)) === undefined, "rows made while the property is deleted have no number");
  await databases.restoreProperty(ids.owner, uid.id);
  check((await numberOf(before[0].id, uid.id)) === 1, "restoring it brings the numbers back");
  check((await numberOf(whileDeleted.id, uid.id)) === 21, "…and numbers the rows made meanwhile after the last one", await numberOf(whileDeleted.id, uid.id));

  // Changing the type
  const asText = await databases.changePropertyType(ids.owner, uid.id, { type: "text", yes: "Yes" });
  check(asText.cleared === 0, "an ID turns into text without losing values", asText);
  check((await numberOf(before[2].id, uid.id)) === "TASK-3", "…as it showed", await numberOf(before[2].id, uid.id));
  await databases.changePropertyType(ids.owner, uid.id, { type: "number", yes: "Yes" });
  check((await numberOf(before[2].id, uid.id)) === null || (await numberOf(before[2].id, uid.id)) === undefined, "text like TASK-3 isn't a number");
  const back = await databases.changePropertyType(ids.owner, uid.id, { type: "unique_id", yes: "Yes" });
  const all = await numbersIn(tasks.id, uid.id);
  const nums = all.map((r) => r.n!).sort((a, b) => a - b);
  check(
    JSON.stringify(nums) === JSON.stringify(Array.from({ length: all.length }, (_, i) => i + 22)),
    "turning it back into a unique ID numbers every row again, after the numbers it gave out before",
    nums,
  );
  check(all.find((r) => r.id === before[0].id)?.n === 22, "…in the order they were made");
  check(back.converted === all.length && (await lastNumber(uid.id)) === 21 + all.length, "…and its counter is at the last", back);
  const refs = await createPage(actor, { workspaceId, kind: "database", title: "Refs" });
  const ref = await databases.addProperty(ids.owner, refs.id, { name: "Ref", type: "text" });
  for (const title of ["R1", "R2", "R3"]) await databases.createRows(ids.owner, refs.id, [{ title, properties: { [ref.id]: `old ${title}` } }]);
  await databases.changePropertyType(ids.owner, ref.id, { type: "unique_id", yes: "Yes" });
  const refNumbers = (await numbersIn(refs.id, ref.id)).sort((a, b) => a.n! - b.n!).map((r) => `${r.title}:${r.n}`);
  check(refNumbers.join(",") === "R1:1,R2:2,R3:3", "a text property turned into a unique ID numbers the rows from 1", refNumbers);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
