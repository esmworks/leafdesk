/**
 * End-to-end check of ratings and durations, number properties in those formats
 * (lib/number-format): a rating takes whole stars from 0 to its max and refuses the rest, also when
 * its max is lowered; a duration stores minutes and takes "1:30", "1h 30m" or a number of minutes;
 * both filter and sort as numbers, a rollup summing durations shows as a duration, and MCP's
 * get_database describes the formats. Creates its own user and workspace and deletes them
 * afterwards.
 *
 *   pnpm tsx scripts/rating-duration-e2e.ts
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
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { describeProperty } = await import("@/server/mcp/query");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `rating-e2e-${Date.now().toString(36)}`;
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

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return error instanceof PropertyValueError ? (error.code ?? error.message) : String(error);
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
const stored = async (rowId: string) =>
  (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties as Record<string, unknown>;

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  const actor = { userId: owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  for (const prop of await databases.getProperties(tasks.id)) await databases.deleteProperty(owner, prop.id);
  const stars = await databases.addProperty(owner, tasks.id, { name: "Stars", type: "number", number: { format: "rating" } });
  const spent = await databases.addProperty(owner, tasks.id, { name: "Spent", type: "number", number: { format: "duration" } });
  check(stars.options.number?.format === "rating" && stars.options.number.max === 5, "a rating gets five stars by default", stars.options);
  check(
    (await outcome(() => databases.addProperty(owner, tasks.id, { name: "Bad", type: "number", number: { format: "rating", max: 11 } }))) ===
      "invalidNumberFormat",
    "a rating has at most ten stars",
  );

  const a = await createPage(actor, { workspaceId, parentId: tasks.id, title: "A", properties: { Stars: 4, Spent: "1:30" } });
  const b = await createPage(actor, { workspaceId, parentId: tasks.id, title: "B", properties: { Stars: "2", Spent: "2h 15m" } });
  const c = await createPage(actor, { workspaceId, parentId: tasks.id, title: "C", properties: { Spent: 45 } });
  check((await stored(a.id))[spent.id] === 90 && (await stored(b.id))[spent.id] === 135, "durations are stored in minutes");
  check((await stored(c.id))[spent.id] === 45, "a plain number is minutes");
  check((await stored(b.id))[stars.id] === 2, "a rating takes a number written as text");

  // Values a rating or a duration can't hold are refused.
  check((await outcome(() => databases.updateRowProperties(owner, c.id, { Stars: 6 }))) === "invalidRating", "more stars than the max are refused");
  check((await outcome(() => databases.updateRowProperties(owner, c.id, { Stars: 2.5 }))) === "invalidRating", "half stars are refused");
  check((await outcome(() => databases.updateRowProperties(owner, c.id, { Stars: -1 }))) === "invalidRating", "negative stars are refused");
  check((await outcome(() => databases.updateRowProperties(owner, c.id, { Spent: "soon" }))) === "invalidDuration", "a duration that can't be read is refused");
  await databases.updateProperty(owner, stars.id, { number: { format: "rating", max: 3 } });
  check((await outcome(() => databases.updateRowProperties(owner, c.id, { Stars: 4 }))) === "invalidRating", "a lower max refuses what goes past it");
  check((await stored(a.id))[stars.id] === 4, "values past a lowered max stay until they are changed");

  // Numbers to filters, sorts and rollups.
  const long = await databases.listRows(owner, tasks.id, { filters: [{ propertyId: spent.id, op: "gt", value: 60 }] });
  check(long.map((r) => r.title).sort().join() === "A,B", "durations filter by minutes", long.map((r) => r.title));
  const sorted = await databases.listRows(owner, tasks.id, { sorts: [{ propertyId: stars.id, direction: "desc" }] });
  check(sorted.map((r) => r.title).slice(0, 2).join() === "A,B", "ratings sort by stars", sorted.map((r) => r.title));
  const projects = await createPage(actor, { workspaceId, kind: "database", title: "Projects" });
  for (const prop of await databases.getProperties(projects.id)) await databases.deleteProperty(owner, prop.id);
  const taskLinks = await databases.addProperty(owner, projects.id, { name: "Tasks", type: "relation", relation: { databaseId: tasks.id } });
  const total = await databases.addProperty(owner, projects.id, {
    name: "Time",
    type: "rollup",
    rollup: { relationPropertyId: taskLinks.id, targetPropertyId: spent.id, function: "sum" },
  });
  const p = await createPage(actor, { workspaceId, parentId: projects.id, title: "P", properties: { Tasks: [a.id, b.id] } });
  const [row] = (await databases.listRows(owner, projects.id)).filter((r) => r.id === p.id);
  check(row.properties[total.id] === 225, "a rollup sums minutes", row.properties);
  const withUnit = (await databases.getDatabase(owner, projects.id)).properties.find((x) => x.id === total.id);
  check(withUnit?.options.rollup?.number?.format === "duration", "a sum of durations shows as a duration", withUnit?.options);

  // MCP describes the formats.
  const tasksSchema = await databases.getDatabase(owner, tasks.id);
  const described = tasksSchema.properties.map((x) => describeProperty(x, undefined, tasksSchema.properties));
  const json = JSON.stringify(described);
  check(json.includes('"format":"rating"') && json.includes('"max":3') && json.includes('"format":"duration"'), "get_database names a rating and a duration", described);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, owner));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
