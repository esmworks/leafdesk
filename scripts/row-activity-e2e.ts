/**
 * End-to-end check of database rows' activity against the database: a new row gets one "created"
 * entry; app, bulk, MCP and REST-style writes record who changed which value (and the title) from
 * what to what; quick changes by the same person merge, and a value changed back drops its entry;
 * credentials typed into text are masked; entries about a property the viewer may not see, or a
 * deleted one, are left out (and come back with it); linked rows the viewer can't open aren't
 * named; automations, agents and AI values show as such; a trashed row's activity is for those who see it
 * there, and it goes with the row when the row is deleted for good.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-activity-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, count, desc, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { oauthClient, page, rowActivity, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const databases = await import("@/server/databases");
const { archivePage, createPage, deletePagePermanently } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { asAutomation } = await import("@/server/automations/queue");
const { saveValue } = await import("@/server/ai-properties");
const { listRowActivity } = await import("@/server/row-activity-feed");
const ops = await import("@/server/operations");
const { AccessError } = await import("@/server/access");

const RUN = `rowactivity-e2e-${Date.now().toString(36)}`;

// The real collab service: titles are saved through the row's document.
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "row-activity-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  outsider: `${RUN}-outsider`,
  agent: `${RUN}-agent`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const stored = (rowId: string) => db.select().from(rowActivity).where(eq(rowActivity.rowId, rowId)).orderBy(desc(rowActivity.createdAt));
const feed = async (userId: string, rowId: string) => (await listRowActivity(userId, rowId, { limit: 100 })).entries;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.agent, role: "guest" },
  ]);
  await db.insert(workspaceAgent).values({ workspaceId, userId: ids.agent, name: "Helper", icon: "🤖", createdBy: ids.owner });
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Test AI", redirectUris: [] });

  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const docs = await createPage(actor, { workspaceId, kind: "database", title: "Docs" });
  // The member gets edit access, not the workspace-wide default (full access sees every property).
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "none");
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");
  await setPagePermission(ids.owner, tasks.id, ids.agent, "edit");
  const props = await databases.getProperties(tasks.id);
  const status = props.find((p) => p.type === "status")!;
  const [notStarted, inProgress, done] = status.options.options!;
  const notes = await databases.addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const estimate = await databases.addProperty(ids.owner, tasks.id, { name: "Estimate", type: "number" });
  const salary = await databases.addProperty(ids.owner, tasks.id, { name: "Salary", type: "number" });
  const owner = await databases.addProperty(ids.owner, tasks.id, { name: "Owner", type: "person" });
  const links = await databases.addProperty(ids.owner, tasks.id, { name: "Docs", type: "relation", relation: { databaseId: docs.id } });
  await databases.addProperty(ids.owner, tasks.id, { name: "Double", type: "formula", formula: { expression: 'prop("Estimate") * 2' } });

  // A new row: one entry, whatever values it came with
  const row = await createPage(actor, {
    workspaceId,
    parentId: tasks.id,
    title: "Ship it",
    properties: { [status.id]: notStarted.id, [estimate.id]: 3 },
  });
  let entries = await stored(row.id);
  check(entries.length === 1 && entries[0].kind === "created" && entries[0].actorUserId === ids.owner, "a new row gets one created entry", entries);

  // App writes, merged while quick
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: inProgress.id });
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: done.id });
  entries = (await stored(row.id)).filter((e) => e.kind === "property");
  check(
    entries.length === 1 && entries[0].oldValue === notStarted.id && entries[0].newValue === done.id,
    "two quick status changes by one person are one entry, from the first value to the last",
    entries,
  );
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: notStarted.id });
  entries = (await stored(row.id)).filter((e) => e.kind === "property");
  check(entries.length === 0, "changing the value back to where it started drops the entry", entries);

  for (const text of ["d", "dr", "draft"]) await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: text });
  entries = (await stored(row.id)).filter((e) => e.propertyId === notes.id);
  check(entries.length === 1 && entries[0].oldValue === null && entries[0].newValue === "draft", "typing in a text value is one entry", entries);
  await databases.updateRowProperties(ids.member, row.id, { [notes.id]: "draft 2" });
  entries = (await stored(row.id)).filter((e) => e.propertyId === notes.id);
  check(entries.length === 2, "someone else's change of the same value is an entry of its own", entries);
  await db.execute(sql`update ${rowActivity} set created_at = created_at - interval '10 minutes' where ${rowActivity.rowId} = ${row.id}`);
  await databases.updateRowProperties(ids.member, row.id, { [notes.id]: "draft 3" });
  entries = (await stored(row.id)).filter((e) => e.propertyId === notes.id);
  check(entries.length === 3, "a change after the merge window starts a new entry", entries);

  // Credentials typed into text are kept masked
  await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: "deploy key ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" });
  const [latestNote] = (await stored(row.id)).filter((e) => e.propertyId === notes.id && e.actorUserId === ids.owner);
  check(
    typeof latestNote.newValue === "string" && latestNote.newValue.includes("[redacted]") && !latestNote.newValue.includes("0123456789abcdef"),
    "a token typed into a text value is stored masked",
    latestNote,
  );

  // Derived values aren't recorded; values that don't change aren't either
  await databases.updateRowProperties(ids.owner, row.id, { [estimate.id]: 5 });
  await databases.updateRowProperties(ids.owner, row.id, { [estimate.id]: 5 });
  entries = await stored(row.id);
  check(
    entries.filter((e) => e.propertyId === estimate.id).length === 1 && entries.every((e) => e.propertyType !== "formula"),
    "one entry for the number, none for the formula over it",
    entries,
  );

  // Bulk edits: one entry per row
  const other = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Other" });
  const bulk = await databases.updateRowsProperties(ids.owner, tasks.id, [row.id, other.id], { [owner.id]: [ids.member] });
  check(bulk.done.length === 2, "the bulk edit changed both rows", bulk);
  const bulkEntries = await db.select().from(rowActivity).where(eq(rowActivity.propertyId, owner.id));
  check(
    bulkEntries.length === 2 && new Set(bulkEntries.map((e) => e.rowId)).size === 2,
    "a bulk edit records one entry for each row",
    bulkEntries,
  );

  // REST and MCP writes go through the same path, title included
  await ops.updateDatabaseRow({ userId: ids.owner, actor }, { row_id: row.id, title: "Ship it now", properties: { Estimate: 8 } });
  let titleEntry: (typeof rowActivity.$inferSelect)[] = [];
  for (let i = 0; i < 300 && !titleEntry.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    titleEntry = (await stored(row.id)).filter((e) => e.kind === "title");
  }
  check(
    titleEntry.length === 1 && titleEntry[0].oldValue === "Ship it" && titleEntry[0].newValue === "Ship it now",
    "renaming a row through the API records the title change",
    { titleEntry, title: (await db.select({ t: page.title }).from(page).where(eq(page.id, row.id)))[0] },
  );
  const viaMcp = await callTool(ids.owner, "update_database_row", { row_id: row.id, properties: { Status: "Done" } });
  check(!viaMcp.isError, "an MCP client sets the status", viaMcp.text);
  const listed = await callTool(ids.owner, "list_row_activity", { row_id: row.id, limit: 50 });
  check(!listed.isError, "list_row_activity answers", listed.text);
  const mcpStatus = listed.data.entries.find((e: { property?: string }) => e.property === "Status");
  check(
    mcpStatus?.from === "Not started" && mcpStatus?.to === "Done" && mcpStatus?.by === "owner" && mcpStatus?.actor === "user",
    "MCP lists the status change by option name and who made it",
    listed.data.entries,
  );
  check(listed.data.entries.at(-1)?.change === "created", "MCP lists the created entry last", listed.data.entries);

  // Automations and agents show as such
  await asAutomation(() => databases.updateRowProperties(ids.member, row.id, { [estimate.id]: 13 }));
  await asAutomation(() => databases.updateRowProperties(ids.agent, row.id, { [notes.id]: "agent notes" }));
  let mine = await feed(ids.owner, row.id);
  const byAutomation = mine.find((e) => e.property?.id === estimate.id && e.actor.person?.id === ids.member);
  const byAgent = mine.find((e) => e.property?.id === notes.id && e.actor.person?.id === ids.agent);
  check(byAutomation?.actor.kind === "automation", "a change an automation made reads as the automation's", byAutomation);
  check(byAgent?.actor.kind === "agent" && byAgent.actor.person?.isAgent, "a change an agent made reads as the agent's, not an automation's", byAgent);

  // AI values read as the AI's, for the person they were worked out for, apart from that person's edits
  await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: "owner notes" });
  await saveValue({ rowId: row.id, databaseId: tasks.id, userId: ids.owner, chain: [] }, notes.id, "AI notes");
  const ownerNotes = (await stored(row.id)).filter((e) => e.propertyId === notes.id && e.actorUserId === ids.owner);
  const aiNote = ownerNotes.find((e) => e.actorKind === "ai");
  check(
    aiNote?.oldValue === "owner notes" && aiNote.newValue === "AI notes" && ownerNotes.some((e) => e.actorKind === "user" && e.newValue === "owner notes"),
    "an AI value is an entry of its own, not merged into the edit the person made just before",
    ownerNotes,
  );
  await asAutomation(() => saveValue({ rowId: row.id, databaseId: tasks.id, userId: ids.member, chain: [] }, notes.id, "AI notes 2"));
  mine = await feed(ids.owner, row.id);
  const byAi = mine.find((e) => e.property?.id === notes.id && e.actor.kind === "ai" && e.actor.person?.id === ids.owner);
  const byAiForAutomation = mine.find((e) => e.property?.id === notes.id && e.actor.person?.id === ids.member && e.actor.kind === "ai");
  check(Boolean(byAi), "the feed reads an AI value as the AI's, naming who it was worked out for", byAi);
  check(Boolean(byAiForAutomation), "an AI value an automation's change set off reads as the AI's too, for the automation's person", mine);
  const listedAi = await callTool(ids.owner, "list_row_activity", { row_id: row.id, limit: 50 });
  const mcpAi = listedAi.data?.entries.find((e: { property?: string; actor?: string; by?: string }) => e.property === "Notes" && e.actor === "ai" && e.by === "owner");
  check(mcpAi?.to === "AI notes", "MCP lists the AI value with actor ai and the person in by", listedAi.data?.entries);

  // Values read for the viewer: options, people and linked rows they may open
  const open = await createPage(actor, { workspaceId, parentId: docs.id, title: "Open doc" });
  const hidden = await createPage(actor, { workspaceId, parentId: docs.id, title: "Hidden doc" });
  await setPagePermission(ids.owner, hidden.id, ids.owner, "full");
  await setPagePermission(ids.owner, hidden.id, null, "none");
  await databases.updateRowProperties(ids.owner, row.id, { [links.id]: [open.id, hidden.id] });
  const linkFor = async (userId: string) => (await feed(userId, row.id)).find((e) => e.property?.id === links.id);
  const ownerLink = await linkFor(ids.owner);
  const memberLink = await linkFor(ids.member);
  check(
    ownerLink?.to?.type === "pages" && ownerLink.to.pages.every((p) => "title" in p),
    "the owner reads both linked rows by title",
    ownerLink,
  );
  check(
    memberLink?.to?.type === "pages" &&
      memberLink.to.pages.some((p) => "title" in p && p.title === "Open doc") &&
      memberLink.to.pages.some((p) => p.id === hidden.id && "noAccess" in p) &&
      !JSON.stringify(memberLink).includes("Hidden doc"),
    "a linked row the viewer can't open isn't named",
    memberLink,
  );
  const ownerEntry = mine.find((e) => e.property?.id === owner.id);
  check(
    ownerEntry?.to?.type === "people" && ownerEntry.to.people[0]?.name === "member",
    "a person value reads as the person's name",
    ownerEntry,
  );

  // Property access: entries about a value the viewer may not see are left out
  await databases.updateRowProperties(ids.owner, row.id, { [salary.id]: 90000 });
  await setPropertyAccess(ids.owner, salary.id, { everyone: "none", exceptions: [] });
  mine = await feed(ids.owner, row.id);
  const theirs = await feed(ids.member, row.id);
  check(mine.some((e) => e.property?.id === salary.id), "with full access the owner still sees salary changes");
  check(!theirs.some((e) => e.property?.id === salary.id) && !JSON.stringify(theirs).includes("90000"), "a member who may not see Salary sees none of its entries", theirs);
  await setPropertyAccess(ids.owner, salary.id, { everyone: "view_property", exceptions: [] });
  check(!(await feed(ids.member, row.id)).some((e) => e.property?.id === salary.id), "…nor when they see the property but not its values");
  const page1 = await listRowActivity(ids.member, row.id, { limit: 2 });
  const page2 = await listRowActivity(ids.member, row.id, { offset: 2, limit: 100 });
  check(
    page1.entries.length === 2 && page1.hasMore && page1.total === page2.total && page2.entries.length === page1.total - 2,
    "pages of the feed add up to its total without the hidden entries",
    { page1: page1.total, page2: page2.entries.length },
  );

  // Deleted properties: left out until restored
  await databases.deleteProperty(ids.owner, estimate.id);
  check(!(await feed(ids.owner, row.id)).some((e) => e.property?.id === estimate.id), "entries about a deleted property are left out");
  await databases.restoreProperty(ids.owner, estimate.id);
  check((await feed(ids.owner, row.id)).some((e) => e.property?.id === estimate.id), "…and come back when it is restored");

  // Who may read it at all
  check(await refused(() => listRowActivity(ids.outsider, row.id)), "someone outside the workspace can't read the activity");
  const created = (await feed(ids.owner, other.id)).at(-1);
  check(created?.kind === "created" && created.actor.person?.id === ids.owner, "every row's activity ends with who created it", created);

  // Trash and deleting for good
  await archivePage(ids.owner, row.id);
  check((await feed(ids.owner, row.id)).length > 0, "a trashed row's activity is readable by those who see it in the trash");
  check(await refused(() => listRowActivity(ids.outsider, row.id)), "…and by nobody else");
  await deletePagePermanently(ids.owner, row.id);
  const [{ left }] = await db.select({ left: count() }).from(rowActivity).where(eq(rowActivity.rowId, row.id));
  check(left === 0, "deleting the row for good deletes its activity");
  const [{ kept }] = await db
    .select({ kept: count() })
    .from(rowActivity)
    .where(and(eq(rowActivity.rowId, other.id), inArray(rowActivity.kind, ["property"])));
  check(kept === 1, "other rows keep theirs");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
