/**
 * End-to-end check of a database's history against the database: properties and shared views
 * added, changed, deleted and restored are recorded with who did it and what changed (quick
 * changes by the same person merging), personal views and databases being set up leave nothing,
 * rows put in the trash and taken out are recorded, row value changes read in groups; each entry
 * undoes (options taken away come back with the rows' values, a type change goes back with the
 * values it converted, values go back only where nothing changed them since); outsiders can't read
 * it and properties a member may not know of are left out of what they read. MCP and REST read
 * and undo it too.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/database-history-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseChange, databaseView, oauthClient, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { listDatabaseHistory, undoHistoryEntry } = await import("@/server/database-history");
const { asSetup } = await import("@/server/database-changes");
const { AccessError } = await import("@/server/access");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");

const RUN = `dbhistory-e2e-${Date.now().toString(36)}`;

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

async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof AccessError;
  }
}

/** A REST call, handled in-process as the route handler does. */
async function api(method: string, path: string, token: string) {
  const res = await handleApiRequest(new Request(`http://localhost/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const clientId = `${RUN}-client`;

/** Calls an MCP tool as `userId` through the test OAuth client, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId, scopes: [READ_SCOPE, WRITE_SCOPE] });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "database-history-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const history = async (userId: string, databaseId: string) => (await listDatabaseHistory(userId, databaseId, { limit: 50 })).entries;
const valueOf = async (rowId: string, propertyId: string) => {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row?.properties[propertyId];
};

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Test AI", redirectUris: [] });
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "none");
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");

  check((await history(ids.owner, tasks.id)).length === 0, "a new database starts with an empty history", await history(ids.owner, tasks.id));

  // Adding a property, then setting it up: one entry
  const priority = await databases.addProperty(ids.owner, tasks.id, { name: "Prio", type: "select", options: [{ name: "High" }, { name: "Low" }] });
  await databases.updateProperty(ids.owner, priority.id, { name: "Priority" });
  let entries = await history(ids.owner, tasks.id);
  check(entries.length === 1 && entries[0].type === "property" && entries[0].kind === "property_added", "adding a property and renaming it at once is one entry", entries);
  check(entries[0].type === "property" && entries[0].property.name === "Priority" && entries[0].actor.person?.id === ids.owner, "…naming the property as it is now and who added it", entries[0]);

  // Rows and their values
  const rows = await databases.createRows(ids.owner, tasks.id, [{ title: "One" }, { title: "Two" }, { title: "Three" }]);
  const rowIds = rows.map((r) => r.id);
  const [high, low] = (await databases.getProperties(tasks.id)).find((p) => p.id === priority.id)!.options.options!;
  await databases.updateRowsProperties(ids.owner, tasks.id, rowIds, { [priority.id]: high.id });
  entries = await history(ids.owner, tasks.id);
  const madeGroup = entries.find((e) => e.type === "values" && e.kind === "created");
  check(madeGroup?.type === "values" && madeGroup.rows === 3, "rows made together read as one group", entries);
  const setGroup = entries.find((e) => e.type === "values" && e.kind === "property");
  check(
    setGroup?.type === "values" && setGroup.rows === 3 && setGroup.property?.id === priority.id && setGroup.to?.type === "options",
    "a bulk edit reads as one group of three rows with the value they got",
    setGroup,
  );

  // A member changes the options: the option taken away is cleared from the rows
  await databases.updateProperty(ids.member, priority.id, { options: [low] });
  check((await valueOf(rowIds[0], priority.id)) === undefined, "taking an option away clears it from the rows");
  entries = await history(ids.owner, tasks.id);
  const optionsChange = entries.find((e) => e.type === "property" && e.kind === "property_changed");
  check(
    optionsChange?.type === "property" &&
      optionsChange.actor.person?.id === ids.member &&
      optionsChange.values === 3 &&
      optionsChange.fields.some((f) => f.field === "options" && f.removed.some((o) => o.name === "High")),
    "the member's change of options is recorded with the option taken away and the three values it cleared",
    optionsChange,
  );
  const undone = await undoHistoryEntry(ids.owner, tasks.id, optionsChange!.id);
  check(undone.done === 4 && undone.skipped === 0, "undoing it brings the option back and puts the three values back", undone);
  check((await valueOf(rowIds[1], priority.id)) === high.id, "…on the rows");
  const options = (await databases.getProperties(tasks.id)).find((p) => p.id === priority.id)!.options.options!;
  check(options.some((o) => o.id === high.id && o.name === "High"), "…with the option's own id", options);

  // A value changed since isn't overwritten by an undo of an older change
  await databases.updateRowsProperties(ids.member, tasks.id, rowIds, { [priority.id]: low.id });
  await databases.updateRowsProperties(ids.owner, tasks.id, [rowIds[0]], { [priority.id]: high.id });
  entries = await history(ids.owner, tasks.id);
  const memberGroup = entries.find((e) => e.type === "values" && e.actor.person?.id === ids.member);
  check(memberGroup?.type === "values" && memberGroup.rows === 3, "another person's bulk edit is a group of its own", entries);
  const putBack = await undoHistoryEntry(ids.owner, tasks.id, memberGroup!.id);
  check(putBack.done === 2 && putBack.skipped === 1, "undoing the group puts back the two rows nobody changed since and skips the third", putBack);
  check((await valueOf(rowIds[0], priority.id)) === high.id && (await valueOf(rowIds[1], priority.id)) === high.id, "…as they were");

  // Changing the type and back
  const estimate = await databases.addProperty(ids.member, tasks.id, { name: "Estimate", type: "number" });
  await databases.updateRowsProperties(ids.member, tasks.id, rowIds, { [estimate.id]: 5 });
  await databases.changePropertyType(ids.owner, estimate.id, { type: "checkbox", yes: "Yes" });
  entries = await history(ids.owner, tasks.id);
  const retype = entries.find((e) => e.type === "property" && e.kind === "property_changed" && e.property.id === estimate.id);
  check(
    retype?.type === "property" && retype.fields.some((f) => f.field === "type" && f.from === "number" && f.to === "checkbox") && retype.values === 3,
    "a type change is recorded with the values it converted",
    retype,
  );
  await undoHistoryEntry(ids.owner, tasks.id, retype!.id, { yes: "Yes" });
  const back = (await databases.getProperties(tasks.id)).find((p) => p.id === estimate.id)!;
  check(back.type === "number" && (await valueOf(rowIds[2], estimate.id)) === 5, "undoing it makes it a number again holding 5", { type: back.type, value: await valueOf(rowIds[2], estimate.id) });

  // Deleting and restoring
  await databases.deleteProperty(ids.member, estimate.id);
  entries = await history(ids.owner, tasks.id);
  const deleted = entries.find((e) => e.type === "property" && e.kind === "property_deleted");
  check(deleted?.type === "property" && deleted.property.state === "deleted" && deleted.canUndo, "a deleted property is recorded and can be restored from the history", deleted);
  await undoHistoryEntry(ids.owner, tasks.id, deleted!.id);
  check((await databases.getProperties(tasks.id)).some((p) => p.id === estimate.id), "…which brings it back");
  check((await history(ids.owner, tasks.id))[0].kind === "property_restored", "…and records that too");

  // Views
  const view = await databases.addView(ids.owner, tasks.id, { name: "Board", type: "board" });
  await databases.updateView(ids.member, view.id, {
    config: { filters: [{ propertyId: priority.id, op: "equals", value: high.id }] },
  });
  entries = await history(ids.owner, tasks.id);
  const viewChange = entries.find((e) => e.type === "view" && e.kind === "view_changed");
  check(viewChange?.type === "view" && viewChange.parts.includes("filters") && viewChange.actor.person?.id === ids.member, "a view's filters changed are recorded", viewChange);
  await undoHistoryEntry(ids.owner, tasks.id, viewChange!.id);
  const [viewNow] = (await databases.getDatabase(ids.owner, tasks.id)).views.filter((v) => v.id === view.id);
  check(!viewNow.config.filters?.length, "undoing it takes the filter away again", viewNow.config);
  const before = (await db.select().from(databaseChange).where(eq(databaseChange.databaseId, tasks.id))).length;
  await databases.addView(ids.member, tasks.id, { name: "Mine", type: "table", personal: true });
  const after = (await db.select().from(databaseChange).where(eq(databaseChange.databaseId, tasks.id))).length;
  check(before === after, "a personal view leaves no history");

  // Rows to the trash and back
  await databases.updateRowsProperties(ids.owner, tasks.id, rowIds, { [priority.id]: low.id });
  await archivePage(ids.owner, rowIds[0]);
  await archivePage(ids.owner, rowIds[1]);
  entries = await history(ids.owner, tasks.id);
  const trashed = entries.find((e) => e.type === "rows" && e.kind === "rows_trashed");
  check(trashed?.type === "rows" && trashed.rows.length === 2, "rows trashed one after the other are one entry", trashed);
  const restored = await undoHistoryEntry(ids.owner, tasks.id, trashed!.id);
  check(restored.done === 2, "undoing it takes both out of the trash", restored);
  const live = await db.select({ archivedAt: page.archivedAt }).from(page).where(inArray(page.id, rowIds));
  check(live.every((r) => r.archivedAt === null), "…which are rows again");

  // Setting a database up leaves nothing; outsiders and hidden properties
  const setUp = await createPage(actor, { workspaceId, kind: "database", title: "Set up" });
  await asSetup(() => databases.addProperty(ids.owner, setUp.id, { name: "Seeded", type: "text" }));
  check((await history(ids.owner, setUp.id)).length === 0, "properties made while a database is set up leave no history");
  check(await refused(() => listDatabaseHistory(ids.outsider, tasks.id)), "someone outside the workspace can't read the history");
  const salary = await databases.addProperty(ids.owner, tasks.id, { name: "Salary", type: "number" });
  await setPropertyAccess(ids.owner, salary.id, { everyone: "none", exceptions: [] });
  const memberSees = await history(ids.member, tasks.id);
  check(!memberSees.some((e) => e.type === "property" && e.property.id === salary.id), "a member doesn't read changes of a property hidden from them", memberSees.slice(0, 3));
  check(memberSees.some((e) => e.type === "property" && e.property.id === priority.id), "…but reads the others", memberSees.slice(0, 3));
  await setPagePermission(ids.owner, tasks.id, ids.member, "view");
  const viewerSees = await history(ids.member, tasks.id);
  check(viewerSees.length > 0 && viewerSees.every((e) => !e.canUndo), "someone who may only view the database reads it without undoing anything", viewerSees.slice(0, 2));

  // MCP: get_page_history on a database reads its history; restore_page_version undoes a change
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");
  const listed = await callTool(ids.owner, "get_page_history", { page_id: tasks.id });
  const mcpChanges = listed.data?.changes as { id: string; change: string; property?: string; can_undo: boolean }[] | undefined;
  check(!listed.isError && mcpChanges?.some((c) => c.change === "property_added" && c.property === "Salary"), "get_page_history on a database lists its changes", listed.text.slice(0, 400));
  const salaryAdded = mcpChanges!.find((c) => c.change === "property_added" && c.property === "Salary")!;
  const mcpUndo = await callTool(ids.owner, "restore_page_version", { version_id: salaryAdded.id });
  check(!mcpUndo.isError && mcpUndo.data?.undone === salaryAdded.id, "restore_page_version undoes a change from it", mcpUndo.text);
  check(!(await databases.getProperties(tasks.id)).some((p) => p.id === salary.id), "…here deleting the property added");
  const group = (await history(ids.owner, tasks.id)).find((e) => e.type === "values" && e.kind === "property")!;
  const elsewhere = await createPage(actor, { workspaceId, kind: "database", title: "Elsewhere" });
  const crossed = await undoHistoryEntry(ids.owner, elsewhere.id, group.id).then(() => null, (error: unknown) => error);
  check(crossed instanceof Error, "a group's id undoes nothing through another database", String(crossed));

  // Paging
  const first = await listDatabaseHistory(ids.owner, tasks.id, { limit: 3 });
  const second = await listDatabaseHistory(ids.owner, tasks.id, { limit: 3, before: first.next });
  check(first.entries.length === 3 && first.next && second.entries.length > 0, "the history reads in pages", { first: first.next, second: second.entries.length });
  check(!second.entries.some((e) => first.entries.some((f) => f.id === e.id)), "…without repeating an entry");

  // REST: GET /databases/{id}/history in pages, POST .../history/{change_id}/undo
  const { secret: reader } = await createApiToken(ids.owner, { name: "history e2e read", scopes: ["databases:read"] });
  const { secret: writer } = await createApiToken(ids.owner, { name: "history e2e write", scopes: ["pages:write"] });
  const page1 = await api("GET", `/databases/${tasks.id}/history?limit=2`, reader);
  check(page1.status === 200 && page1.body.changes.length === 2 && page1.body.has_more && page1.body.next_cursor, "GET /databases/{id}/history lists the changes a page at a time", page1.body);
  const page2 = await api("GET", `/databases/${tasks.id}/history?limit=2&cursor=${page1.body.next_cursor}`, reader);
  const firstIds = new Set(page1.body.changes.map((c: { id: string }) => c.id));
  check(page2.status === 200 && page2.body.changes.length > 0 && !page2.body.changes.some((c: { id: string }) => firstIds.has(c.id)), "…reading on with next_cursor", page2.body);
  const badCursor = await api("GET", `/databases/${tasks.id}/history?cursor=nope`, reader);
  check(badCursor.status === 400 && badCursor.body.error?.code === "invalid_cursor", "a cursor not from the API is refused", badCursor.body);
  const all = await api("GET", `/databases/${tasks.id}/history?limit=50`, reader);
  const target = (all.body.changes as { id: string; change: string; can_undo: boolean }[]).find((c) => c.can_undo && c.change === "view_added");
  check(target, "…naming the changes that can be undone", all.body.changes);
  const liveViews = async () =>
    (await db.select({ id: databaseView.id }).from(databaseView).where(and(eq(databaseView.databaseId, tasks.id), isNull(databaseView.deletedAt)))).length;
  const viewsBefore = await liveViews();
  const readOnly = await api("POST", `/databases/${tasks.id}/history/${target.id}/undo`, reader);
  check(readOnly.status === 403, "undoing needs a token that writes", readOnly);
  const wrongPath = await api("POST", `/databases/${elsewhere.id}/history/${target.id}/undo`, writer);
  check(wrongPath.status === 404, "a change undoes nothing under another database's path", wrongPath);
  check((await liveViews()) === viewsBefore, "…leaving it as it was");
  const undoneViaRest = await api("POST", `/databases/${tasks.id}/history/${target.id}/undo`, writer);
  check(undoneViaRest.status === 200 && undoneViaRest.body.undone === target.id && undoneViaRest.body.done === 1, "POST /databases/{id}/history/{change_id}/undo undoes it", undoneViaRest);
  check((await liveViews()) === viewsBefore - 1, "…here deleting the view added");
  const noSuch = await api("POST", `/databases/${tasks.id}/history/${RUN}-none/undo`, writer);
  check(noSuch.status === 404, "an id that is no change answers 404", noSuch);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
