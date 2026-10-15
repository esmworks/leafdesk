/**
 * End-to-end check of chart views against the database: the settings a new chart starts with,
 * config validation, the series a chart plots from the rows its filters let through (counts,
 * multi-select rows in each option, sums over numbers and number formulas, date buckets,
 * stacks), rows the viewer can't see staying out, duplicating and deleting the properties a chart
 * uses, what a published chart shows (its figures, no rows), and creating, describing and querying charts over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/chart-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { addProperty, addView, deleteProperty, deleteView, getDatabaseSnapshot, getProperties, listRows, updateView } =
  await import("@/server/databases");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { duplicatePage } = await import("@/server/duplicate");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { PropertyValueError } = await import("@/lib/properties");
const { chartData, chartGroupProperty, chartMeasure } = await import("@/lib/chart");

const RUN = `chart-e2e-${Date.now().toString(36)}`;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "chart-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

type Series = { group: string; value: number | null; row_count: number; segments?: { series: string; value: number | null }[] };
const byGroup = (series: Series[]) => Object.fromEntries(series.map((s) => [s.group, s.value]));

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
  const deals = await createPage(actor, { workspaceId, kind: "database", title: "Deals" });
  for (const prop of await getProperties(deals.id)) await deleteProperty(ids.owner, prop.id);

  // A chart without anything to group by has no grouping yet
  const bare = await addView(ids.owner, deals.id, { name: " ", type: "chart" });
  check(bare.name === "Chart" && bare.type === "chart" && !bare.config.groupBy, "a chart without a groupable property is called Chart and has no grouping", bare);

  const stage = await addProperty(ids.owner, deals.id, { name: "Stage", type: "select", options: ["Lead", "Won", "Lost"] });
  const tags = await addProperty(ids.owner, deals.id, { name: "Tags", type: "multi_select", options: ["Big", "Renewal"] });
  const amount = await addProperty(ids.owner, deals.id, { name: "Amount", type: "number" });
  const closed = await addProperty(ids.owner, deals.id, { name: "Closed", type: "date" });
  const paid = await addProperty(ids.owner, deals.id, { name: "Paid", type: "checkbox" });
  const withTax = await addProperty(ids.owner, deals.id, { name: "With tax", type: "formula", formula: { expression: 'prop("Amount") * 1.2' } });
  await addProperty(ids.owner, deals.id, { name: "Notes", type: "text" });

  const chart = await addView(ids.owner, deals.id, { name: "Pipeline", type: "chart" });
  check(chart.config.groupBy === stage.id, "a new chart groups by the first select property", chart.config);

  // Config validation
  const bad: [string, object][] = [
    ["chart type", { chartType: "pie" }],
    ["sort", { chartSort: "size" }],
    ["calculation shape", { chartAggregate: "sum" }],
    ["calculation", { chartAggregate: { fn: "latest_date", propertyId: closed.id } }],
    ["stack property", { stackBy: 7 }],
    ["value labels", { showValues: "yes" }],
    ["hidden groups", { hiddenGroups: "Won" }],
  ];
  for (const [label, config] of bad) {
    check(
      await rejects(() => updateView(ids.owner, chart.id, { config: config as never }), "invalidViewConfig"),
      `a malformed ${label} is refused`,
    );
  }

  const option = (prop: typeof stage, name: string) => prop.options.options!.find((o) => o.name === name)!.id;
  const rows: [string, Record<string, unknown>][] = [
    ["Acme", { Stage: "Won", Tags: ["Big", "Renewal"], Amount: 100, Closed: "2026-01-12", Paid: true }],
    ["Globex", { Stage: "Won", Tags: ["Big"], Amount: 50, Closed: "2026-03-02" }],
    ["Initech", { Stage: "Lost", Amount: 30, Closed: "2026-01-30" }],
    ["Umbrella", { Stage: "Lead", Tags: ["Renewal"], Amount: 20 }],
    ["Hooli", { Amount: 5, Paid: true }],
  ];
  const created = new Map<string, string>();
  for (const [title, properties] of rows) created.set(title, (await createPage(actor, { workspaceId, parentId: deals.id, title, properties })).id);

  // What the app plots: the snapshot's rows through the view's filters, then the chart's groups
  const plotted = async (userId: string, viewId: string) => {
    const snapshot = await getDatabaseSnapshot(userId, deals.id);
    const view = snapshot.views.find((v) => v.id === viewId)!;
    const visible = await listRows(userId, deals.id, view.config);
    const groupBy = chartGroupProperty(snapshot.properties, view.config)!;
    const stackBy = snapshot.properties.find((p) => p.id === view.config.stackBy) ?? null;
    const data = chartData(visible, { groupBy, stackBy, measure: chartMeasure(view.config, snapshot.properties), config: view.config });
    return data;
  };
  let data = await plotted(ids.owner, chart.id);
  check(
    data.groups.map((g) => `${g.key}:${g.amount}`).join() === `${option(stage, "Lead")}:1,${option(stage, "Won")}:2,${option(stage, "Lost")}:1,:1`,
    "a chart counts rows per option, with rows without a stage last",
    data.groups.map((g) => [g.key, g.amount]),
  );

  // Sum over a number, sorted by value, with a filter
  await updateView(ids.owner, chart.id, {
    config: {
      ...chart.config,
      chartAggregate: { fn: "sum", propertyId: amount.id },
      chartSort: "value_desc",
      filters: [{ propertyId: amount.id, op: "gt", value: 10 }],
    },
  });
  data = await plotted(ids.owner, chart.id);
  check(
    data.groups.map((g) => g.amount).join() === "150,30,20",
    "a filtered chart sums a number per stage, largest first (the filtered-out row takes its no-value group along)",
    data.groups.map((g) => [g.key, g.amount]),
  );

  // Multi-select rows count in each of their options; number formulas sum like numbers
  const byTag = await addView(ids.owner, deals.id, { name: "Tags", type: "chart" });
  await updateView(ids.owner, byTag.id, {
    config: { groupBy: tags.id, chartType: "donut", chartAggregate: { fn: "sum", propertyId: withTax.id }, hideEmptyGroups: true },
  });
  data = await plotted(ids.owner, byTag.id);
  check(
    data.groups.map((g) => Math.round(g.amount * 100) / 100).join() === "180,144,42",
    "a donut by tag sums a number formula, a row with two tags in both slices",
    data.groups.map((g) => [g.key, g.amount]),
  );

  // Dates by month with the quiet months in between; stacked by a checkbox
  const byMonth = await addView(ids.owner, deals.id, { name: "Months", type: "chart" });
  await updateView(ids.owner, byMonth.id, { config: { groupBy: closed.id, stackBy: paid.id, hiddenGroups: [""] } });
  data = await plotted(ids.owner, byMonth.id);
  check(
    data.groups.map((g) => `${g.key}:${g.segments.map((s) => s.amount).join("+")}`).join() === "2026-01-01:1+1,2026-02-01:0+0,2026-03-01:1+0",
    "a chart by month fills February and stacks paid and unpaid deals",
    data.groups.map((g) => [g.key, g.segments.map((s) => s.amount)]),
  );

  // Rows a viewer can't see stay out of their chart
  await setPagePermission(ids.owner, created.get("Acme")!, ids.owner, "full");
  await setPagePermission(ids.owner, created.get("Acme")!, null, "none");
  const memberData = await plotted(ids.member, chart.id);
  check(
    memberData.groups.find((g) => g.key === option(stage, "Won"))?.amount === 50,
    "a member's chart leaves out the row restricted from them",
    memberData.groups.map((g) => [g.key, g.amount]),
  );

  // Duplicating keeps the chart pointing at the copied properties
  const copy = await duplicatePage(actor, deals.id, " (copy)");
  const copied = await getDatabaseSnapshot(ids.owner, copy.id);
  const copiedChart = copied.views.find((v) => v.name === "Pipeline")!;
  const copiedMonths = copied.views.find((v) => v.name === "Months")!;
  const copiedAmount = copied.properties.find((p) => p.name === "Amount")!;
  const copiedPaid = copied.properties.find((p) => p.name === "Paid")!;
  check(
    copiedChart.config.chartAggregate?.propertyId === copiedAmount.id && copiedAmount.id !== amount.id && copiedMonths.config.stackBy === copiedPaid.id,
    "a duplicated chart measures and stacks by the copied properties",
    { chart: copiedChart.config, months: copiedMonths.config },
  );

  // MCP: create, describe and query a chart by property names
  const createdByMcp = await callTool(ids.owner, "create_database_view", {
    database_id: deals.id,
    name: "Revenue",
    type: "chart",
    chart_type: "horizontal_bar",
    group_by: "Stage",
    aggregate: "sum",
    aggregate_property: "Amount",
    stack_by: "Paid",
    show_values: true,
  });
  check(
    !createdByMcp.isError &&
      createdByMcp.data.chart_type === "horizontal_bar" &&
      createdByMcp.data.aggregate === "sum" &&
      createdByMcp.data.aggregate_property === "Amount" &&
      createdByMcp.data.stack_by === "Paid",
    "MCP creates a stacked horizontal bar chart summing a number",
    createdByMcp.text,
  );
  const refused = await callTool(ids.owner, "create_database_view", {
    database_id: deals.id,
    name: "Bad",
    type: "chart",
    aggregate: "sum",
    aggregate_property: "Notes",
  });
  check(refused.isError && /can't calculate sum over "Notes"/.test(refused.text), "MCP refuses to sum a text property", refused.text);
  const queried = await callTool(ids.owner, "query_database", { database_id: deals.id, view_id: createdByMcp.data.id, limit: 1 });
  const series = queried.data.chart.series as Series[];
  check(
    queried.data.returned === 1 && JSON.stringify(byGroup(series)) === JSON.stringify({ Lead: 20, Won: 150, Lost: 30, "No Stage": 5 }),
    "query_database returns the chart's series over every matching row",
    queried.data.chart,
  );
  const won = series.find((s) => s.group === "Won")!;
  check(
    JSON.stringify(won.segments) === JSON.stringify([{ series: "Unchecked", value: 50, row_count: 1 }, { series: "Checked", value: 100, row_count: 1 }]),
    "…with each bar's stacked segments",
    won,
  );
  const monthly = await callTool(ids.owner, "query_database", { database_id: deals.id, view_id: byMonth.id });
  check(
    (monthly.data.chart.series as Series[]).map((s) => s.group).join() === "2026-01,2026-02,2026-03",
    "a chart by month names its buckets by month",
    monthly.data.chart,
  );
  const updated = await callTool(ids.owner, "update_database_view", {
    database_id: deals.id,
    view_id: createdByMcp.data.id,
    aggregate: "count",
    chart_type: "line",
  });
  check(
    !updated.isError && updated.data.aggregate === "count" && !("aggregate_property" in updated.data) && !("stack_by" in updated.data),
    "MCP switches a chart back to counting rows; a line doesn't stack",
    updated.text,
  );
  const described = await callTool(ids.owner, "get_database", { database_id: deals.id });
  const donut = described.data.views.find((v: { id: string }) => v.id === byTag.id);
  check(
    donut?.chart_type === "donut" && donut.aggregate === "sum" && donut.aggregate_property === "With tax" && donut.show_legend === true && donut.group_by === "Tags",
    "get_database describes a chart's settings",
    donut,
  );

  // Deleting a property a chart uses turns it back into a plain count
  await deleteProperty(ids.owner, amount.id);
  await deleteProperty(ids.owner, paid.id);
  const after = (await getDatabaseSnapshot(ids.owner, deals.id)).views;
  check(
    !after.find((v) => v.id === chart.id)!.config.chartAggregate && !after.find((v) => v.id === byMonth.id)!.config.stackBy,
    "deleting the measured and stacked properties clears them from charts",
    after.map((v) => v.config),
  );

  // A published chart shows its figures over the rows its filters keep, and no rows
  const published = await createPage(actor, { workspaceId, kind: "database", title: "Public chart" });
  const [firstView] = (await getDatabaseSnapshot(ids.owner, published.id)).views;
  const kind = (await getProperties(published.id)).find((p) => p.type === "select" || p.type === "status")!;
  const secret = await addProperty(ids.owner, published.id, { name: "Secret", type: "text" });
  const shown = await addProperty(ids.owner, published.id, { name: "Shown", type: "number" });
  await createPage(actor, { workspaceId, parentId: published.id, title: "Visible", properties: { Shown: 1 } });
  await createPage(actor, { workspaceId, parentId: published.id, title: "Filtered", properties: { Shown: 9 } });
  const publicChart = await addView(ids.owner, published.id, { name: "Chart", type: "chart" });
  await updateView(ids.owner, publicChart.id, {
    config: { ...publicChart.config, shown: [shown.id], filters: [{ propertyId: shown.id, op: "lt", value: 5 }] },
  });
  await deleteView(ids.owner, firstView.id);
  const { token } = await publishPage(ids.owner, published.id);
  const publicDb = (await getPublishedPage(token))?.database;
  check(
    publicDb?.layout === "chart" && publicDb.rows.length === 0 && publicDb.properties.length === 0,
    "a published chart sends no rows or columns",
    publicDb,
  );
  const figures = publicDb.chart;
  check(
    figures?.groupById === kind.id && figures.data?.total === 1 && !figures.properties.some((p) => p.id === secret.id || p.id === shown.id),
    "a published chart's figures follow its filters and name only what it groups and measures",
    figures,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
