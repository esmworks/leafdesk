/**
 * End-to-end check of dashboards against the database: what widgets show for a viewer (numbers,
 * charts and lists over the rows a view's filters keep), rows and properties the viewer can't see
 * staying out of every figure, the rows behind a number or a bar, widgets on databases the viewer
 * can't open, what a published dashboard shows (and that a widget never publishes a database outside
 * the publication, rows or people's names), and adding, listing, changing and keeping dashboards
 * over MCP and through a Markdown rewrite. Also what keeps dashboards from doing more work than
 * they need: which channels a change signals and which databases' stamps it changes (what the
 * browser asks again for), and that a published page reads each database once, however many
 * widgets show it. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/dashboard-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created. The
// pool is made here, before @/db makes its own, so the queries a published page sends can be counted.
const { default: postgres } = await import("postgres");
const { env } = await import("@/lib/env");
const queries: { text: string; params: unknown[] }[] = [];
let counting = false;
(globalThis as unknown as { __leafdeskSql?: unknown }).__leafdeskSql = postgres(env.databaseUrl, {
  max: 10,
  debug: (_connection, text, params) => void (counting && queries.push({ text, params })),
});
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { addProperty, deleteProperty, getProperties } = await import("@/server/databases");
const { getPublishedPage, publishedDatabase, publishPage } = await import("@/server/publication");
const { archivePage, createPage, renamePage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { widgetData, widgetRows, widgetStamps } = await import("@/server/dashboards");
const { DASHBOARD_BLOCK, LIST_WIDGET_ROWS, parseDashboard, widgetStamp } = await import("@/lib/dashboard");

const RUN = `dashboard-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
// What the server signals to browsers, channel and event ("db:<id> rows").
const sent: string[] = [];
const broadcast = service.broadcast;
service.broadcast = (channel, event) => {
  sent.push(`${channel} ${event}`);
  broadcast(channel, event);
};
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dashboard-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

type Block = { id: string; type: string; props: Record<string, unknown>; children?: Block[] };
const dashboardsOf = async (pageId: string) =>
  ((await getCollab().readBlocks(pageId)).blocks as Block[]).filter((b) => b.type === DASHBOARD_BLOCK).map((b) => ({ id: b.id, widgets: parseDashboard(b.props.widgets) }));

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const owner = { userId: ids.owner };
  const member = { userId: ids.member };

  // The page holding the dashboard, and a database under it.
  const report = await createPage(actor, { workspaceId, title: "Sales report" });
  const deals = await createPage(actor, { workspaceId, parentId: report.id, kind: "database", title: "Deals" });
  for (const prop of await getProperties(deals.id)) await deleteProperty(ids.owner, prop.id);
  const stage = await addProperty(ids.owner, deals.id, { name: "Stage", type: "select", options: ["Lead", "Won", "Lost"] });
  const amount = await addProperty(ids.owner, deals.id, { name: "Amount", type: "number" });
  const margin = await addProperty(ids.owner, deals.id, { name: "Margin", type: "number" });
  await addProperty(ids.owner, deals.id, { name: "Rep", type: "person" });
  const won = stage.options.options!.find((o) => o.name === "Won")!.id;
  const rows: [string, string, number, number][] = [
    ["Acme", "Won", 100, 10],
    ["Globex", "Won", 200, 20],
    ["Initech", "Lead", 50, 5],
    ["Umbrella", "Lost", 70, 7],
  ];
  const created: Record<string, string> = {};
  for (const [title, s, a, m] of rows) {
    const row = await createPage(actor, { workspaceId, parentId: deals.id, title, properties: { Stage: s, Amount: a, Margin: m, Rep: [ids.owner] } });
    created[title] = row.id;
  }
  // Many leads, for a list longer than a list widget shows.
  for (let i = 0; i < LIST_WIDGET_ROWS + 2; i++) {
    await createPage(actor, { workspaceId, parentId: deals.id, title: `Lead ${i + 1}`, properties: { Stage: "Lead", Amount: 1 } });
  }
  // Members edit the deals (people with full access see every property), a won deal only its owner
  // can open, and a margin only the owner may see.
  await setPagePermission(ids.owner, deals.id, ids.owner, "full");
  await setPagePermission(ids.owner, deals.id, null, "edit");
  await setPagePermission(ids.owner, created.Globex, ids.owner, "full");
  await setPagePermission(ids.owner, created.Globex, null, "none");
  await setPropertyAccess(ids.owner, margin.id, { everyone: "none", exceptions: [] });
  // A database the member can't open at all.
  const secret = await createPage(actor, { workspaceId, kind: "database", title: "Salaries" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");

  const total = rows.length + LIST_WIDGET_ROWS + 2;
  const wonCount = { type: "chart" as const, config: { chartType: "number" as const, filters: [{ propertyId: stage.id, op: "equals" as const, value: won }] } };
  const wonSum = { type: "chart" as const, config: { ...wonCount.config, chartAggregate: { fn: "sum" as const, propertyId: amount.id } } };
  const marginSum = { type: "chart" as const, config: { chartType: "number" as const, chartAggregate: { fn: "sum" as const, propertyId: margin.id } } };
  const byStage = { type: "chart" as const, config: { groupBy: stage.id, chartAggregate: { fn: "sum" as const, propertyId: amount.id } } };

  // Numbers
  const ownWon = await widgetData(owner, { databaseId: deals.id, view: wonCount });
  check(ownWon.state === "ok" && ownWon.kind === "number" && ownWon.result?.value === 2 && ownWon.rowCount === 2, "a number counts the rows its filters keep", ownWon);
  const memberWon = await widgetData(member, { databaseId: deals.id, view: wonCount });
  check(memberWon.state === "ok" && memberWon.kind === "number" && memberWon.result?.value === 1, "rows the viewer can't open stay out of a number", memberWon);
  const memberSum = await widgetData(member, { databaseId: deals.id, view: wonSum });
  check(memberSum.state === "ok" && memberSum.kind === "number" && memberSum.result?.value === 100, "a sum adds up only the rows the viewer can open", memberSum);
  const ownMargin = await widgetData(owner, { databaseId: deals.id, view: marginSum });
  check(ownMargin.state === "ok" && ownMargin.kind === "number" && ownMargin.result?.value === 42, "a sum over a property its owner may see", ownMargin);
  const memberMargin = await widgetData(member, { databaseId: deals.id, view: marginSum });
  check(
    memberMargin.state === "ok" && memberMargin.kind === "number" && memberMargin.result?.value === total - 1 && !memberMargin.properties.some((p) => p.id === margin.id),
    "a calculation over a property the viewer can't see counts rows and names no such property",
    memberMargin,
  );

  // Charts
  const chart = await widgetData(owner, { databaseId: deals.id, view: byStage });
  check(chart.state === "ok" && chart.kind === "chart" && chart.chart, "a chart widget comes back grouped", chart);
  const amounts = Object.fromEntries(chart.chart.groups.map((g) => [g.value.kind === "option" ? g.value.option.name : g.key, g.result?.value]));
  check(amounts.Won === 300 && amounts.Lead === 50 + LIST_WIDGET_ROWS + 2 && amounts.Lost === 70, "each group measures its rows", amounts);
  check(
    chart.chart.groups.every((g) => g.rows.length === 0 && g.segments.every((s) => s.rows.length === 0)),
    "a chart sends counts, not rows",
    chart.chart.groups.map((g) => g.rows.length),
  );
  const wonGroup = chart.chart.groups.find((g) => g.value.kind === "option" && g.value.option.name === "Won")!;
  const ownDrill = await widgetRows(owner, { databaseId: deals.id, view: byStage }, { groupKey: wonGroup.key });
  check(ownDrill?.total === 2 && ownDrill.rows.map((r) => r.title).sort().join() === "Acme,Globex", "the rows behind a bar", ownDrill);
  const memberDrill = await widgetRows(member, { databaseId: deals.id, view: byStage }, { groupKey: wonGroup.key });
  check(memberDrill?.total === 1 && memberDrill.rows[0].title === "Acme", "the rows behind a bar leave out rows the viewer can't open", memberDrill);
  const numberDrill = await widgetRows(member, { databaseId: deals.id, view: wonCount }, {});
  check(numberDrill?.total === 1, "the rows behind a number", numberDrill);

  // Lists and other layouts
  const list = await widgetData(member, { databaseId: deals.id, view: { type: "list", config: {} } });
  check(
    list.state === "ok" && list.kind === "list" && list.rows.length === LIST_WIDGET_ROWS && list.rowCount === total - 1,
    "a list sends its first rows and counts the rest",
    list,
  );
  const table = await widgetData(member, { databaseId: deals.id, view: { type: "table", config: {} } });
  check(table.state === "ok" && table.kind === "view", "other layouts show as linked views", table);

  // Databases the viewer can't open
  for (const [label, databaseId] of [
    ["one shared with no one", secret.id],
    ["a page that isn't a database", report.id],
    ["a missing one", `${RUN}-missing`],
  ]) {
    const data = await widgetData(member, { databaseId, view: wonCount });
    const drill = await widgetRows(member, { databaseId, view: wonCount }, {});
    check(data.state === "unavailable" && drill === null, `a widget on ${label} says nothing about it`, data);
  }

  // Live refresh. Rows signal their own database's channel; the page tree, which changes with every
  // page anyone touches, makes the browser compare stamps and ask again only where one changed.
  const notes = await createPage(actor, { workspaceId, parentId: report.id, kind: "database", title: "Notes" });
  const elsewhere = await createPage(actor, { workspaceId, title: "Elsewhere" });
  const watched = [deals.id, notes.id, secret.id];
  const before = await widgetStamps(member, watched);
  const dealsData = await widgetData(member, { databaseId: deals.id, view: wonCount });
  const notesData = await widgetData(member, { databaseId: notes.id, view: { type: "list", config: {} } });
  check(
    dealsData.state === "ok" &&
      notesData.state === "ok" &&
      before[deals.id] === widgetStamp(dealsData.database) &&
      before[notes.id] === widgetStamp(notesData.database) &&
      before[secret.id] === widgetStamp(null),
    "a database's stamp is the one its widgets show, and says nothing of one the viewer can't see",
    before,
  );
  sent.length = 0;
  await createPage(actor, { workspaceId, parentId: notes.id, title: "A note" });
  check(
    sent.includes(`db:${notes.id} rows`) && !sent.some((s) => s.startsWith(`db:${deals.id} `)),
    "a new row signals its own database's channel, not other databases'",
    sent,
  );
  await renamePage(actor, elsewhere.id, "Elsewhere, renamed");
  await createPage(actor, { workspaceId, title: "Another page" });
  check(
    JSON.stringify(await widgetStamps(member, watched)) === JSON.stringify(before),
    "new rows and changes to other pages leave every stamp as it was",
    await widgetStamps(member, watched),
  );
  await renamePage(actor, notes.id, "Meeting notes");
  const afterRenaming = await widgetStamps(member, watched);
  check(
    afterRenaming[notes.id] !== before[notes.id] && afterRenaming[deals.id] === before[deals.id],
    "renaming a database changes its stamp only",
    afterRenaming,
  );
  await archivePage(ids.owner, notes.id);
  const afterTrashing = await widgetStamps(owner, watched);
  check(
    afterTrashing[notes.id] !== afterRenaming[notes.id] && afterTrashing[notes.id] !== widgetStamp(null) && afterTrashing[deals.id] === before[deals.id],
    "trashing a database changes its stamp only",
    afterTrashing,
  );
  await restorePage(ids.owner, notes.id);
  await setPagePermission(ids.owner, notes.id, ids.owner, "full");
  await setPagePermission(ids.owner, notes.id, null, "none");
  const afterSharing = await widgetStamps(member, watched);
  check(
    afterSharing[notes.id] === widgetStamp(null) && afterSharing[deals.id] === before[deals.id],
    "a database the viewer can no longer see stamps as nothing, the others as before",
    afterSharing,
  );
  check(
    JSON.stringify(await widgetStamps(member, [`${RUN}-missing`, report.id])) === JSON.stringify({ [report.id]: widgetStamp(null) }),
    "stamps say nothing of pages that aren't databases, and skip ids that aren't ids",
  );

  // MCP: add a dashboard, list it, change it
  const added = await callTool(ids.owner, "add_dashboard", {
    page_id: report.id,
    widgets: [
      { database_id: deals.id, title: "Won", chart_type: "number", filters: [{ property: "Stage", op: "equals", value: "Won" }] },
      { database_id: deals.id, group_by: "Stage", aggregate: "sum", aggregate_property: "Amount" },
      { database_id: deals.id, group_by: "Rep" },
      { database_id: deals.id, type: "list" },
      { database_id: secret.id, type: "list" },
    ],
  });
  check(!added.isError && added.data.widgets.length === 5, "add_dashboard adds the widgets", added);
  const [stored] = await dashboardsOf(report.id);
  check(stored?.id === added.data.dashboard_id && stored.widgets.length === 5, "the dashboard is in the page body under its id", stored);
  check(
    JSON.stringify(stored.widgets[0].view) === JSON.stringify(wonCount),
    "a widget's settings are stored like a view's",
    stored.widgets[0].view,
  );
  const listed = await callTool(ids.member, "get_page", { page_id: report.id });
  const listedWidgets = listed.data?.dashboards?.[0]?.widgets ?? [];
  check(
    listed.data?.markdown.includes(`<!-- leafdesk:dashboard ${stored.id} -->`) && listedWidgets.length === 5,
    "get_page shows the dashboard's line and lists its widgets",
    listed.data,
  );
  check(
    listedWidgets[4].accessible === false && !("database_title" in listedWidgets[4]) && listedWidgets[0].chart_type === "number",
    "get_page keeps a database the user can't open private",
    listedWidgets,
  );
  const renamed = await callTool(ids.owner, "update_dashboard_widget", {
    page_id: report.id,
    widget_id: stored.widgets[1].id,
    title: "Pipeline",
    chart_type: "donut",
    before_widget_id: stored.widgets[0].id,
  });
  const [afterRename] = await dashboardsOf(report.id);
  check(
    !renamed.isError &&
      afterRename.widgets[0].id === stored.widgets[1].id &&
      afterRename.widgets[0].title === "Pipeline" &&
      afterRename.widgets[0].view.config.chartType === "donut" &&
      afterRename.widgets[0].view.config.groupBy === stage.id,
    "update_dashboard_widget changes and moves a widget, keeping what it isn't given",
    afterRename.widgets,
  );
  const refused = await callTool(ids.member, "add_dashboard", { page_id: report.id, widgets: [{ database_id: secret.id }] });
  check(refused.isError, "add_dashboard refuses a database the user can't open", refused.text);

  // A Markdown rewrite keeps the dashboard whole; one that leaves its line out removes it
  const { markdown } = await getCollab().readPage(report.id);
  await getCollab().replaceContent(report.id, `Intro\n\n${markdown}`, actor);
  const [kept] = await dashboardsOf(report.id);
  check(kept?.id === stored.id && kept.widgets.length === 5, "rewriting the page's Markdown keeps the dashboard", kept);

  const marginWidget = await callTool(ids.owner, "update_dashboard_widget", {
    page_id: report.id,
    database_id: deals.id,
    chart_type: "number",
    aggregate: "sum",
    aggregate_property: "Margin",
  });
  check(!marginWidget.isError && marginWidget.data.widgets.length === 6, "update_dashboard_widget adds a widget", marginWidget);

  // Publishing
  const { token } = await publishPage(ids.owner, report.id);
  const published = await getPublishedPage(token);
  const block = published?.body.find((b) => b.kind === "dashboard");
  check(block?.kind === "dashboard" && block.widgets.length === 6, "a published page shows its dashboard", published?.body.map((b) => b.kind));
  const [pipeline, number, people, listWidget, salaries, marginTotal] = block.widgets;
  check(
    number.database?.table.layout === "chart" && number.database.table.chart?.result?.value === 2 && number.database.table.rows.length === 0,
    "a published number shows its value and no rows",
    number.database?.table,
  );
  const publishedChart = pipeline.database?.table.chart;
  check(
    publishedChart?.data?.total === 300 + 50 + LIST_WIDGET_ROWS + 2 + 70 && publishedChart.data.groups.every((g) => g.rows.length === 0),
    "a published chart shows its figures, without rows",
    publishedChart,
  );
  check(
    people.database?.table.chart?.data === null && !JSON.stringify(people.database.table).includes(ids.owner),
    "a published chart grouped by people names no one",
    people.database?.table,
  );
  check(
    listWidget.database?.table.rows.length === LIST_WIDGET_ROWS && listWidget.rowCount === total,
    "a published list shows its first rows and counts the rest",
    { rows: listWidget.database?.table.rows.length, count: listWidget.rowCount },
  );
  check(salaries.database === null, "a widget on a database outside the publication shows nothing of it", salaries);
  const hiddenSum = marginTotal.database?.table.chart;
  check(
    hiddenSum?.measure.kind === "count" && hiddenSum.result?.value === total && !hiddenSum.properties.some((p) => p.id === margin.id),
    "a published sum over a property visitors can't see counts rows instead",
    hiddenSum,
  );

  // A published page reads each database once, however many widgets show it: a second dashboard
  // with six widgets on two databases, beside the first one's five on one of them.
  const second = await callTool(ids.owner, "add_dashboard", {
    page_id: report.id,
    widgets: [
      { database_id: deals.id, chart_type: "number", filters: [{ property: "Stage", op: "equals", value: "Won" }] },
      { database_id: deals.id, group_by: "Stage", aggregate: "sum", aggregate_property: "Amount" },
      { database_id: deals.id, type: "list" },
      { database_id: deals.id, type: "table" },
      { database_id: notes.id, chart_type: "number" },
      { database_id: notes.id, type: "list" },
    ],
  });
  check(!second.isError && second.data.widgets.length === 6, "a second dashboard with six widgets on two databases", second);
  queries.length = 0;
  counting = true;
  const again = await getPublishedPage(token);
  counting = false;
  const rowLoads = (databaseId: string) => queries.filter((q) => q.text.includes('"is_template"') && q.params.includes(databaseId)).length;
  check(
    rowLoads(deals.id) === 1 && rowLoads(notes.id) === 1 && rowLoads(secret.id) === 0,
    "a published page loads each database's rows once for all its widgets",
    { deals: rowLoads(deals.id), notes: rowLoads(notes.id), secret: rowLoads(secret.id) },
  );
  // Nothing else about a database (its properties, deleted ones, who may see which) is read twice either.
  const repeated = Object.entries(
    Object.groupBy(
      queries.filter((q) => q.params.includes(deals.id) || q.params.includes(notes.id)),
      (q) => JSON.stringify([q.text, q.params]),
    ),
  )
    .filter(([, same]) => (same?.length ?? 0) > 1)
    .map(([key, same]) => ({ query: key.slice(0, 200), times: same?.length }));
  check(repeated.length === 0, "and reads nothing else about a database twice", repeated);
  const dashboards = again?.body.filter((b) => b.kind === "dashboard") ?? [];
  const secondBlock = dashboards[1];
  check(secondBlock?.kind === "dashboard" && secondBlock.widgets.length === 6, "the published page shows both dashboards", dashboards.length);
  const [, secondStored] = await dashboardsOf(report.id);
  const alone = await Promise.all(
    secondStored.widgets.map(async (w) => {
      const table = await publishedDatabase(ids.owner, w.databaseId, { linked: w.view });
      return w.view.type === "list" ? { ...table, rows: table.rows.slice(0, LIST_WIDGET_ROWS) } : table;
    }),
  );
  check(
    secondBlock.widgets.every((w, i) => JSON.stringify(w.database?.table) === JSON.stringify(alone[i])),
    "each widget still shows its own view, as it does read alone",
    secondBlock.widgets.map((w, i) => ({ shared: w.database?.table.layout, alone: alone[i].layout })),
  );
  check(
    secondBlock.widgets[0].database?.table.chart?.result?.value === 2 && secondBlock.widgets[4].database?.table.chart?.result?.value === 1,
    "widgets on the same load still filter on their own",
    secondBlock.widgets.map((w) => w.database?.table.chart?.result),
  );

  // Colors: a widget's box takes a palette hue, kept in the block and shown on the published page
  const tinted = await callTool(ids.owner, "update_dashboard_widget", {
    page_id: report.id,
    dashboard_id: second.data.dashboard_id,
    widget_id: secondStored.widgets[4].id,
    color: "green",
  });
  check(!tinted.isError && tinted.data.widgets[4].color === "green", "update_dashboard_widget colors a widget", tinted);
  const [, colored] = await dashboardsOf(report.id);
  check(colored.widgets[4].color === "green" && colored.widgets.filter((w) => w.color).length === 1, "the color is kept in the block, on that widget only", colored.widgets);
  const coloredPage = await getPublishedPage(token);
  const coloredBlock = coloredPage?.body.filter((b) => b.kind === "dashboard")[1];
  check(
    coloredBlock?.kind === "dashboard" && coloredBlock.widgets[4].color === "green" && coloredBlock.widgets[0].color === undefined,
    "a published widget shows its color",
    coloredBlock?.kind === "dashboard" && coloredBlock.widgets.map((w) => w.color),
  );
  const cleared = await callTool(ids.owner, "update_dashboard_widget", {
    page_id: report.id,
    dashboard_id: second.data.dashboard_id,
    widget_id: secondStored.widgets[4].id,
    color: "none",
  });
  check(!cleared.isError && cleared.data.widgets[4].color === null, "color none makes the widget plain again", cleared.data?.widgets[4]);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
