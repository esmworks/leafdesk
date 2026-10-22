/**
 * End-to-end check of property descriptions and dependent selects against the database. A
 * description is stored cleaned, refused when too long, and given to MCP's get_database and to the
 * AI chat's view of the workspace. A select depending on another offers only the options that fit a
 * row's value of it: a write setting one that doesn't fit is refused (the app, bulk edits, MCP),
 * changing the value it depends on clears what no longer fits (also on a board move and down a
 * chain), a CSV import leaves misfits empty, removing a parent option prunes the lists, a loop is
 * refused, and turning the parent into another type undoes the dependency. Duplicating the database
 * keeps both. Creates its own user and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/prop-guidance-e2e.ts
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
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { csvTable } = await import("@/lib/import/csv");
const { importCsvIntoDatabase } = await import("@/server/import/csv");
const { workspaceMap } = await import("@/server/ai-tools");

const RUN = `prop-guidance-e2e-${Date.now().toString(36)}`;

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

async function errorCode(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "prop-guidance-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
type Values = Record<string, unknown>;
const stored = async (rowId: string) => (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties as Values;

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  const actor = { userId: owner };
  const customers = await createPage(actor, { workspaceId, kind: "database", title: "Customers" });

  // ------------------------------------------------------------------------------ descriptions
  const segment = await databases.addProperty(owner, customers.id, {
    name: "Segment",
    type: "select",
    options: ["Retail", "Industry"],
    description: "  Industry when they buy for a plant.\n\n\n\nRetail otherwise.  ",
  });
  check(segment.options.description === "Industry when they buy for a plant.\n\nRetail otherwise.", "a description is stored trimmed with blank lines folded", segment.options);
  check((await errorCode(() => databases.updateProperty(owner, segment.id, { description: "x".repeat(1001) }))) === "invalidDescription", "a description over 1000 characters is refused");
  const notes = await databases.addProperty(owner, customers.id, { name: "Notes", type: "text" });
  await databases.updateProperty(owner, notes.id, { description: "Last call, one line" });
  check((await databases.getProperties(customers.id)).find((p) => p.id === notes.id)!.options.description === "Last call, one line", "a description can be set later");
  await databases.updateProperty(owner, notes.id, { description: null });
  check(!("description" in (await databases.getProperties(customers.id)).find((p) => p.id === notes.id)!.options), "…and removed");

  // -------------------------------------------------------------------------- dependent selects
  const country = await databases.addProperty(owner, customers.id, { name: "Country", type: "select", options: ["Türkiye", "Germany"] });
  const city = await databases.addProperty(owner, customers.id, { name: "City", type: "select", options: ["Istanbul", "Ankara", "Berlin", "Other"] });
  const opt = (prop: { options: { options?: { id: string; name: string }[] } }, name: string) => prop.options.options!.find((o) => o.name === name)!.id;
  const [tr, de] = [opt(country, "Türkiye"), opt(country, "Germany")];
  const withParents = (prop: typeof city, parents: Record<string, string[]>) =>
    prop.options.options!.map((o) => (parents[o.name] ? { ...o, parentOptionIds: parents[o.name] } : o));
  await databases.updateProperty(owner, city.id, { dependsOn: "Country" });
  await databases.updateProperty(owner, city.id, { options: withParents(city, { Istanbul: [tr, "gone"], Ankara: [tr], Berlin: [de] }) });
  const cityNow = (await databases.getProperties(customers.id)).find((p) => p.id === city.id)!;
  check(cityNow.options.dependsOn === country.id, "a select depends on another, named by name", cityNow.options);
  check(
    JSON.stringify(cityNow.options.options!.find((o) => o.name === "Istanbul")!.parentOptionIds) === JSON.stringify([tr]) &&
      !cityNow.options.options!.find((o) => o.name === "Other")!.parentOptionIds,
    "parent lists keep only the parent's options",
    cityNow.options.options,
  );
  check((await errorCode(() => databases.updateProperty(owner, country.id, { dependsOn: city.id }))) === "invalidDependency", "a loop is refused");
  check((await errorCode(() => databases.updateProperty(owner, notes.id, { dependsOn: country.id }))) === "invalidDependency", "only selects can depend");
  check((await errorCode(() => databases.updateProperty(owner, country.id, { dependsOn: notes.id }))) === "invalidDependency", "…on a select");

  const [acme, beta] = await databases.createRows(owner, customers.id, [
    { title: "Acme", properties: { Country: "Türkiye", City: "Istanbul" } },
    { title: "Beta", properties: { Country: "Germany", City: "Berlin" } },
  ]);
  const [istanbul, berlin, other] = [opt(cityNow, "Istanbul"), opt(cityNow, "Berlin"), opt(cityNow, "Other")];
  check((await stored(acme.id))[city.id] === istanbul, "a fitting option is written");
  check(
    (await errorCode(() => databases.createRows(owner, customers.id, [{ title: "Gamma", properties: { Country: "Germany", City: "Ankara" } }]))) === "optionUnavailable",
    "a new row can't take an option that doesn't fit",
  );
  check((await errorCode(() => databases.updateRowProperties(owner, acme.id, { [city.id]: berlin }))) === "optionUnavailable", "an edit can't either");
  await databases.updateRowProperties(owner, acme.id, { [city.id]: other });
  check((await stored(acme.id))[city.id] === other, "an option without a list fits any row");
  await databases.updateRowProperties(owner, acme.id, { [city.id]: istanbul });
  await databases.updateRowProperties(owner, acme.id, { [country.id]: de });
  check(!((await stored(acme.id))[city.id]), "changing the parent clears what no longer fits", await stored(acme.id));
  await databases.updateRowProperties(owner, acme.id, { [country.id]: tr, [city.id]: istanbul });
  check((await stored(acme.id))[city.id] === istanbul, "the parent and its dependent can change together");

  // A chain: District depends on City.
  const district = await databases.addProperty(owner, customers.id, { name: "District", type: "multi_select", options: ["Kadıköy", "Mitte", "Center"] });
  await databases.updateProperty(owner, district.id, { dependsOn: city.id });
  await databases.updateProperty(owner, district.id, {
    options: district.options.options!.map((o) => (o.name === "Kadıköy" ? { ...o, parentOptionIds: [istanbul] } : o.name === "Mitte" ? { ...o, parentOptionIds: [berlin] } : o)),
  });
  const [kadikoy, center] = [opt(district, "Kadıköy"), opt(district, "Center")];
  await databases.updateRowProperties(owner, acme.id, { [district.id]: [kadikoy, center] });
  await databases.updateRowProperties(owner, acme.id, { [country.id]: de });
  const chained = await stored(acme.id);
  check(!chained[city.id] && JSON.stringify(chained[district.id]) === JSON.stringify([center]), "clearing goes down the chain, a multi-select keeping what fits", chained);

  // Bulk edit: rows whose city doesn't fit the new country lose it.
  await databases.updateRowProperties(owner, acme.id, { [country.id]: tr, [city.id]: istanbul });
  const bulk = await databases.updateRowsProperties(owner, customers.id, [acme.id, beta.id], { [country.id]: de });
  const [a, b] = [await stored(acme.id), await stored(beta.id)];
  check(bulk && !a[city.id] && b[city.id] === berlin, "a bulk edit of the parent clears per row", { a, b });
  check(
    (await errorCode(() => databases.updateRowsProperties(owner, customers.id, [acme.id, beta.id], { [city.id]: istanbul }))) === "optionUnavailable",
    "a bulk edit setting a misfit is refused",
  );

  // Board move: grouping by Country moves a row to another country.
  await databases.updateRowProperties(owner, acme.id, { [country.id]: tr, [city.id]: istanbul });
  await databases.moveRow(owner, acme.id, { groupBy: country.id, groupValue: de, groupFrom: tr });
  check(!((await stored(acme.id))[city.id]), "moving a row to another group on a board clears what no longer fits", await stored(acme.id));

  // CSV import: misfits arrive empty, the rest as given.
  await importCsvIntoDatabase(actor, {
    databaseId: customers.id,
    table: csvTable(["Name,Country,City", "Delta,Germany,Ankara", "Echo,Türkiye,Ankara"].join("\n")),
    mapping: ["title", country.id, city.id],
  });
  const rows = new Map((await databases.listRows(owner, customers.id)).map((r) => [r.title, r.properties as Values]));
  check(!rows.get("Delta")![city.id] && rows.get("Delta")![country.id] === de, "a CSV import leaves a misfit empty", rows.get("Delta"));
  check(rows.get("Echo")![city.id] === opt(cityNow, "Ankara"), "…and imports the ones that fit", rows.get("Echo"));

  // MCP: the schema shows descriptions and dependencies; writes follow the rule.
  const schema = await callTool(owner, "get_database", { database_id: customers.id });
  const described = (schema.data.properties ?? schema.data.database_properties) as { name: string; description?: string; depends_on?: string; option_parents?: Record<string, string[]> }[];
  check(described.find((p) => p.name === "Segment")?.description?.startsWith("Industry when"), "MCP get_database gives the description", schema.text);
  check(
    described.find((p) => p.name === "City")?.depends_on === "Country" && described.find((p) => p.name === "City")?.option_parents?.Istanbul?.[0] === "Türkiye",
    "…and the dependency, by names",
    described.find((p) => p.name === "City"),
  );
  const refused = await callTool(owner, "update_database_row", { row_id: beta.id, properties: { City: "Istanbul" } });
  check(refused.isError && refused.text.includes("Istanbul"), "MCP refuses a misfit, naming it", refused.text);
  const added = await callTool(owner, "add_database_property", {
    database_id: customers.id,
    name: "Branch",
    type: "select",
    options: ["Kadıköy branch", "Berlin branch"],
    description: "The branch that serves them",
    depends_on: "City",
    option_parents: [
      { option: "Kadıköy branch", parent_options: ["Istanbul"] },
      { option: "Berlin branch", parent_options: ["Berlin"] },
    ],
  });
  check(!added.isError, "MCP adds a dependent select with a description", added.text);
  const branch = (await databases.getProperties(customers.id)).find((p) => p.name === "Branch")!;
  check(
    branch.options.dependsOn === city.id &&
      branch.options.description === "The branch that serves them" &&
      JSON.stringify(branch.options.options!.find((o) => o.name === "Berlin branch")!.parentOptionIds) === JSON.stringify([berlin]),
    "…stored as asked",
    branch.options,
  );
  const changed = await callTool(owner, "update_database_property", { database_id: customers.id, property: "Branch", depends_on: null, description: "" });
  const branchNow = (await databases.getProperties(customers.id)).find((p) => p.id === branch.id)!;
  check(!changed.isError && !branchNow.options.dependsOn && !branchNow.options.description && branchNow.options.options!.every((o) => !o.parentOptionIds), "MCP undoes both", branchNow.options);

  // The AI chat's view of the workspace gives each property's guidance.
  const map = await workspaceMap({ userId: owner, actor }, workspaceId, null, 20_000);
  check(map.includes("description: Industry when they buy for a plant. Retail otherwise.") && /City.*depends on Country/.test(map), "the AI chat sees descriptions and dependencies", map);

  // Removing a parent option prunes the lists that named it.
  const countryNow = (await databases.getProperties(customers.id)).find((p) => p.id === country.id)!;
  await databases.updateProperty(owner, country.id, { options: countryNow.options.options!.filter((o) => o.id !== de) });
  const pruned = (await databases.getProperties(customers.id)).find((p) => p.id === city.id)!;
  check(!pruned.options.options!.find((o) => o.id === berlin)!.parentOptionIds, "removing a parent option prunes its children's lists (Berlin now goes anywhere)", pruned.options.options);

  // Duplicating the database keeps descriptions and points dependencies at the copies.
  const copy = await duplicatePage(actor, customers.id, " (copy)");
  const copied = await databases.getProperties(copy.id);
  const copiedCity = copied.find((p) => p.name === "City")!;
  check(copied.find((p) => p.name === "Segment")!.options.description === segment.options.description, "a copy keeps the descriptions");
  check(copiedCity.options.dependsOn === copied.find((p) => p.name === "Country")!.id && copiedCity.options.dependsOn !== country.id, "…and depends on its own copy of the parent", copiedCity.options);

  // Turning the parent into text undoes the dependency.
  await databases.changePropertyType(owner, country.id, { type: "text", yes: "Yes" });
  const free = (await databases.getProperties(customers.id)).find((p) => p.id === city.id)!;
  check(!free.options.dependsOn && free.options.options!.every((o) => !o.parentOptionIds), "turning the parent into another type undoes the dependency", free.options);
  await databases.updateRowProperties(owner, beta.id, { [city.id]: istanbul });
  check((await stored(beta.id))[city.id] === istanbul, "…so every option is offered again");
  const typed = await databases.changePropertyType(owner, segment.id, { type: "multi_select", yes: "Yes" });
  check(typed.property.options.description === segment.options.description, "a type change keeps the description");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, [owner]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
