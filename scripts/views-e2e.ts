/**
 * End-to-end check of gallery, list and timeline views against the database: the settings new
 * views start with, config validation, gallery covers in the database snapshot (read from row
 * bodies, only while a gallery shows them, and only for rows the viewer can see), timeline edits
 * writing start and end together, and creating and updating these views over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/views-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { markdownImageHint, PG_MARKDOWN_IMAGE_PATTERN } = await import("@/lib/cover");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const {
  addProperty,
  addView,
  deleteProperty,
  deleteView,
  getDatabaseSnapshot,
  getProperties,
  moveView,
  updateRowProperties,
  updateView,
} = await import("@/server/databases");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { duplicatePage } = await import("@/server/duplicate");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { AccessError } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `views-e2e-${Date.now().toString(36)}`;

// The real collab service, so row bodies are stored the way the editor stores them.
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

async function deniedAccess(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof AccessError;
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "views-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

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
  const status = (await getProperties(tasks.id)).find((p) => p.type === "select" || p.type === "status")!;

  // New views: names and starting settings
  const gallery = await addView(ids.owner, tasks.id, { name: " ", type: "gallery" });
  check(gallery.name === "Gallery" && gallery.type === "gallery", "a gallery without a name is called Gallery", gallery);
  check(Object.keys(gallery.config).length === 0, "a gallery starts with medium cards and first-image covers (the defaults)", gallery.config);
  const list = await addView(ids.owner, tasks.id, { name: "", type: "list" });
  check(list.name === "List" && Object.keys(list.config).length === 0, "a list view starts with default settings", list);
  const noDates = await addView(ids.owner, tasks.id, { name: "", type: "timeline" });
  check(noDates.name === "Timeline" && !noDates.config.dateBy, "a timeline without date properties has no start yet", noDates);
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const ends = await addProperty(ids.owner, tasks.id, { name: "Ends", type: "date" });
  const timeline = await addView(ids.owner, tasks.id, { name: "Plan", type: "timeline" });
  check(
    timeline.config.dateBy === due.id && !timeline.config.endDateBy && !timeline.config.groupBy,
    "a timeline starts at the first date property, one-day bars, no swimlanes",
    timeline.config,
  );
  check(
    await rejects(() => addView(ids.owner, tasks.id, { name: "X", type: "kanban" as never }), "unsupportedViewType"),
    "an unknown view type is refused",
  );

  // Config validation
  const bad: [string, object][] = [
    ["zoom", { zoom: "year" }],
    ["card size", { cardSize: "huge" }],
    ["cover", { cover: { source: "files" } }],
    ["cover shape", { cover: "first_image" }],
    ["show table", { showTable: "yes" }],
    ["end date", { endDateBy: 42 }],
  ];
  for (const [label, config] of bad) {
    check(
      await rejects(() => updateView(ids.owner, timeline.id, { config: config as never }), "invalidViewConfig"),
      `a malformed ${label} setting is refused`,
    );
  }
  await updateView(ids.owner, timeline.id, {
    config: { ...timeline.config, endDateBy: ends.id, zoom: "month", showTable: false, groupBy: status.id },
  });
  await updateView(ids.owner, gallery.id, { config: { cardSize: "large", cover: { source: "first_image" } } });
  const views = (await getDatabaseSnapshot(ids.owner, tasks.id)).views;
  const saved = views.find((v) => v.id === timeline.id)!.config;
  check(
    saved.endDateBy === ends.id && saved.zoom === "month" && saved.showTable === false && saved.groupBy === status.id,
    "valid timeline settings are saved",
    saved,
  );
  check(views.find((v) => v.id === gallery.id)!.config.cardSize === "large", "valid gallery settings are saved");

  // Timeline drags write start and end in one row update
  const r1 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "With image" });
  const r2 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Code only" });
  const r3 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Restricted" });
  const r4 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Plain" });
  const written = await updateRowProperties(ids.owner, r1.id, { [due.id]: "2026-10-05", [ends.id]: "2026-10-09" });
  check(written[due.id] === "2026-10-05" && written[ends.id] === "2026-10-09", "a bar's start and end are written together", written);

  // Gallery covers: the first image of the body, from the stored document
  await service.replaceContent(r1.id, "Intro\n\n![first](https://example.test/first.png)\n\n![second](https://example.test/second.png)", actor);
  await service.replaceContent(r2.id, "```\n![code](https://example.test/code.png)\n```", actor);
  await service.replaceContent(r3.id, "![secret](https://example.test/secret.png)", actor);
  await service.replaceContent(r4.id, "No pictures here", actor);
  const covers = async (userId: string) =>
    Object.fromEntries((await getDatabaseSnapshot(userId, tasks.id)).rows.map((r) => [r.title, r.cover]));
  const withGallery = await covers(ids.owner);
  check(withGallery["With image"] === "https://example.test/first.png", "a row's cover is the first image in its body", withGallery);
  check(withGallery["Code only"] === null, "image Markdown inside a code block is not a cover", withGallery);
  check(withGallery.Plain === null, "a row without images has no cover", withGallery);

  // Saving a body compares the old and new first image Markdown (Postgres and JS regexes) to tell
  // open galleries about a new cover; both must find the same match.
  const hints = await db
    .select({ markdown: page.contentMarkdown, hint: sql<string | null>`substring(${page.contentMarkdown} from ${PG_MARKDOWN_IMAGE_PATTERN})` })
    .from(page)
    .where(inArray(page.id, [r1.id, r2.id, r4.id]));
  check(
    hints.every((h) => h.hint === markdownImageHint(h.markdown)) && hints.filter((h) => h.hint).length === 2,
    "Postgres and JS find the same image Markdown in a body",
    hints,
  );

  await service.replaceContent(r1.id, "![new](/files/new.png)", actor);
  check((await covers(ids.owner))["With image"] === "/files/new.png", "a changed body changes the cover");

  // Access: covers only come with rows the viewer can see
  await setPagePermission(ids.owner, r3.id, ids.owner, "full");
  await setPagePermission(ids.owner, r3.id, null, "none");
  const memberCovers = await covers(ids.member);
  check(!("Restricted" in memberCovers), "a restricted row and its cover stay hidden from members", memberCovers);
  check(memberCovers["With image"] === "/files/new.png", "members see covers of the rows they can see");
  let guestBlocked = false;
  try {
    await getDatabaseSnapshot(ids.guest, tasks.id);
  } catch (error) {
    guestBlocked = error instanceof AccessError;
  }
  check(guestBlocked, "a guest without access gets no snapshot, covers included");
  await setPagePermission(ids.owner, tasks.id, ids.guest, "view");
  // The guest's own entry on the database would reach the restricted row; one on the row itself wins.
  await setPagePermission(ids.owner, r3.id, ids.guest, "none");
  const guestCovers = await covers(ids.guest);
  check(
    guestCovers["With image"] === "/files/new.png" && !("Restricted" in guestCovers),
    "a guest the database is shared with sees covers of the rows shared with them",
    guestCovers,
  );

  // Covers are only read while a gallery shows them
  await updateView(ids.owner, gallery.id, { config: { cover: { source: "none" } } });
  const noCovers = (await getDatabaseSnapshot(ids.owner, tasks.id)).rows;
  check(noCovers.every((r) => !("cover" in r)), "without a gallery showing covers, rows carry no cover field", noCovers[0]);
  await updateView(ids.owner, gallery.id, { config: {} });

  // Duplicating keeps the timeline pointing at the copied properties
  const copy = await duplicatePage(actor, tasks.id, " (copy)");
  const copied = await getDatabaseSnapshot(ids.owner, copy.id);
  const copiedTimeline = copied.views.find((v) => v.type === "timeline" && v.name === "Plan")!;
  const copiedEnds = copied.properties.find((p) => p.name === "Ends")!;
  check(
    copiedTimeline.config.endDateBy === copiedEnds.id && copiedEnds.id !== ends.id,
    "a duplicated timeline ends at the copied end property",
    copiedTimeline.config,
  );

  // Deleting the end property turns bars back into one-day bars
  await deleteProperty(ids.owner, ends.id);
  const afterDelete = (await getDatabaseSnapshot(ids.owner, tasks.id)).views.find((v) => v.id === timeline.id)!.config;
  check(!afterDelete.endDateBy && afterDelete.dateBy === due.id, "deleting the end property clears it from timelines", afterDelete);

  // MCP: create and update the new views by property names
  const created = await callTool(ids.owner, "create_database_view", {
    database_id: tasks.id,
    name: "Roadmap",
    type: "timeline",
    date_by: "Due",
    group_by: status.name,
    zoom: "day",
    show_table: false,
  });
  check(
    !created.isError && created.data.type === "timeline" && created.data.date_by === "Due" && created.data.zoom === "day",
    "MCP creates a timeline with its settings",
    created.text,
  );
  const wrong = await callTool(ids.owner, "create_database_view", { database_id: tasks.id, name: "G", type: "gallery", zoom: "week" });
  check(wrong.isError && /only applies to timeline/.test(wrong.text), "MCP refuses timeline settings on a gallery", wrong.text);
  const cards = await callTool(ids.owner, "create_database_view", {
    database_id: tasks.id,
    name: "Cards",
    type: "gallery",
    card_size: "small",
    cover: "none",
  });
  check(!cards.isError && cards.data.card_size === "small" && cards.data.cover === "none", "MCP creates a gallery with its settings", cards.text);
  const ungrouped = await callTool(ids.owner, "update_database_view", {
    database_id: tasks.id,
    view_id: created.data.id,
    group_by: null,
    zoom: "week",
  });
  check(!ungrouped.isError && !("group_by" in ungrouped.data) && ungrouped.data.zoom === "week", "MCP removes timeline swimlanes", ungrouped.text);
  const listed = await callTool(ids.owner, "create_database_view", { database_id: tasks.id, name: "Compact", type: "list" });
  check(!listed.isError && listed.data.type === "list", "MCP creates a list view", listed.text);
  const described = await callTool(ids.owner, "get_database", { database_id: tasks.id });
  const roadmap = described.data.views.find((v: { id: string }) => v.id === created.data.id);
  check(roadmap?.type === "timeline" && roadmap.show_table === false, "get_database describes timeline settings", roadmap);

  // A published database shows the columns its first view shows, whatever the view's type
  const published = await createPage(actor, { workspaceId, kind: "database", title: "Public list" });
  const [firstView] = (await getDatabaseSnapshot(ids.owner, published.id)).views;
  const notes = await addProperty(ids.owner, published.id, { name: "Notes", type: "text" });
  const when = await addProperty(ids.owner, published.id, { name: "When", type: "date" });
  const compact = await addView(ids.owner, published.id, { name: "Compact", type: "list" });
  await updateView(ids.owner, compact.id, { config: { shown: [when.id] } });
  await deleteView(ids.owner, firstView.id);
  const { token } = await publishPage(ids.owner, published.id);
  const publicColumns = (await getPublishedPage(token))?.database?.properties.map((p) => p.id);
  check(
    publicColumns?.length === 1 && publicColumns[0] === when.id && !publicColumns.includes(notes.id),
    "a published list shows only the properties the list shows",
    publicColumns,
  );

  // Moving view tabs
  const tabs = async (id: string) => (await getDatabaseSnapshot(ids.owner, id)).views.map((v) => v.name);
  const board = await addView(ids.owner, published.id, { name: "Board", type: "board" });
  const table = await addView(ids.owner, published.id, { name: "Table", type: "table" });
  check((await tabs(published.id)).join() === "Compact,Board,Table", "new views come last", await tabs(published.id));
  await moveView(ids.owner, compact.id, table.id, "after");
  check((await tabs(published.id)).join() === "Board,Table,Compact", "a view moves after another", await tabs(published.id));
  await moveView(ids.owner, table.id, board.id, "before");
  check((await tabs(published.id)).join() === "Table,Board,Compact", "a view moves before another", await tabs(published.id));
  const firstColumns = (await getPublishedPage(token))?.database?.properties.map((p) => p.id);
  check(firstColumns?.includes(notes.id), "the view moved first decides what a published database shows", firstColumns);
  // Views that share a position are in the order they were made: Compact, Board, Table.
  await db.update(databaseView).set({ position: 0 }).where(eq(databaseView.databaseId, published.id));
  await moveView(ids.owner, table.id, compact.id, "before");
  const untied = (await getDatabaseSnapshot(ids.owner, published.id)).views;
  check(
    untied.map((v) => v.name).join() === "Table,Compact,Board" && new Set(untied.map((v) => v.position)).size === 3,
    "views that share a position still move, and get positions of their own",
    untied.map((v) => [v.name, v.position]),
  );
  check(await deniedAccess(() => moveView(ids.owner, board.id, timeline.id, "before")), "a view can't move next to another database's view");
  check(await deniedAccess(() => moveView(ids.guest, board.id, table.id, "before")), "a guest without access can't move views");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
