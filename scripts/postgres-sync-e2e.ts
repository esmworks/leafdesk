/**
 * End-to-end check of PostgreSQL table syncs against the database, with a table of its own in a
 * schema made here standing in for another server's: a private address, a bad table name, a
 * missing table, a wrong password and a table without a one-column primary key (and no key named)
 * are refused; setting one up makes a database of the table's rows (the key as text, the title
 * column as titles, numbers, checkboxes, dates, times and JSON as their kinds of property), keeps
 * the connection address sealed; a due run writes the table's
 * changes over, adds new rows and keeps rows that left it; a dropped column pauses the sync with
 * the server's words, a new address checks the table again; stopping keeps the rows. Creates its
 * own user, workspace and schema and deletes them afterwards.
 *
 *   pnpm tsx scripts/postgres-sync-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present), its host reachable by name. Migrations must be
 * applied. Run it while no app server uses the same database: the server's sweep would run the
 * syncs it makes due.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// The "other" server is this one: let the sync reach its host and port (read when env loads; a
// bare name would allow only 5432).
const target = new URL(process.env.DATABASE_URL!);
process.env.CONNECTOR_ALLOWED_HOSTS = `${target.hostname}:${target.port || "5432"}`;

const RUN = `pgsync_${Date.now()}`;
const schema = RUN;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseSync, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { getProperties } = await import("@/server/databases");
const { createPostgresSync, getPostgresSync, stopPostgresSync, updatePostgresSync } = await import("@/server/postgres-sync/manage");
const { runDueSyncs } = await import("@/server/jira-sync/run");

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
    return (error as { code?: string }).code ?? String(error);
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
const actor = { userId: owner };
const url = target.href;
const wrongPassword = (() => {
  const u = new URL(target.href);
  u.password = "not-the-password";
  return u.href;
})();
const rowsOf = async (databaseId: string) =>
  (await db.select({ title: page.title, properties: page.properties, archivedAt: page.archivedAt }).from(page).where(eq(page.parentId, databaseId))).filter(
    (r) => !r.archivedAt,
  );
const due = (databaseId: string) => db.update(databaseSync).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(databaseSync.databaseId, databaseId));

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  await db.execute(sql.raw(`create schema ${schema}`));
  await db.execute(
    sql.raw(`create table ${schema}.customers (
      id integer primary key, name text, city varchar(50), credit numeric(12, 2), active boolean,
      since date, seen_at timestamptz, tags text[], raw bytea
    )`),
  );
  await db.execute(
    sql.raw(`insert into ${schema}.customers values
      (1, 'Acme', 'İzmir', 1500.50, true, '2024-03-01', '2026-10-20 09:30:00+03', '{gold,export}', null),
      (2, 'Globex', 'Ankara', null, false, null, null, null, null)`),
  );
  await db.execute(sql.raw(`create table ${schema}.no_key (code text, name text)`));

  const setup = (fields: Record<string, unknown>) => createPostgresSync(actor, { workspaceId, parentId: null, url, table: `${schema}.customers`, ...fields });

  // Refused before anything is made.
  check((await outcome(() => setup({ url: "postgres://app:pw@10.0.0.1/shop" }))) === "invalidSite", "a private address is refused");
  check((await outcome(() => setup({ table: "a.b.c" }))) === "invalidInput", "a bad table name is refused");
  check((await outcome(() => setup({ table: `${schema}.missing` }))) === "notFound", "a missing table is refused");
  check((await outcome(() => setup({ url: wrongPassword }))) === "unauthorized", "a wrong password is refused");
  check((await outcome(() => setup({ table: `${schema}.no_key` }))) === "invalidInput", "a table without a primary key needs its key named");

  // Set up: a database of the table's rows.
  const result = await setup({ title: "Customers" });
  const databaseId = result.pages[0].id;
  check(result.created.rows === 2, "the table's rows become rows", result);
  const props = await getProperties(databaseId);
  const prop = (name: string) => props.find((p) => p.name === name)!;
  check(
    ["id:text", "city:text", "credit:number", "active:checkbox", "since:date", "seen_at:date", "tags:text"].every((pair) => {
      const [name, type] = pair.split(":");
      return prop(name)?.type === type;
    }) && !prop("raw") && !prop("name"),
    "columns become properties by their types; the title column and unread types don't",
    props.map((p) => `${p.name}:${p.type}`),
  );
  const acme = (await rowsOf(databaseId)).find((r) => r.title === "Acme")!;
  check(
    acme.properties[prop("id").id] === "1" &&
      acme.properties[prop("city").id] === "İzmir" &&
      acme.properties[prop("credit").id] === 1500.5 &&
      acme.properties[prop("active").id] === true &&
      acme.properties[prop("since").id] === "2024-03-01" &&
      acme.properties[prop("seen_at").id] === "2026-10-20T06:30:00.000Z" &&
      acme.properties[prop("tags").id] === "gold, export",
    "a row's values go to their properties",
    acme.properties,
  );
  const [stored] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  const credentials = `${target.username}:${target.password}@`;
  check(stored.source === "postgres" && !stored.siteUrl.includes("@") && !stored.secrets.includes(credentials), "the connection address is kept sealed", stored.siteUrl);
  const shown = await getPostgresSync(owner, databaseId);
  check(shown?.table === `${schema}.customers` && shown.keyColumn === "id" && shown.titleColumn === "name" && !JSON.stringify(shown).includes(credentials), "the sync's dialog shows where it reads", shown);

  // A due run writes changes over, adds new rows and keeps rows that left.
  await db.execute(sql.raw(`update ${schema}.customers set name = 'Acme Ltd', credit = 2000 where id = 1`));
  await db.execute(sql.raw(`delete from ${schema}.customers where id = 2`));
  await db.execute(sql.raw(`insert into ${schema}.customers (id, name, city) values (3, 'Initech', 'Bursa')`));
  await due(databaseId);
  await runDueSyncs();
  const after = await rowsOf(databaseId);
  const renamed = after.find((r) => r.title === "Acme Ltd");
  check(renamed?.properties[prop("credit").id] === 2000, "a run writes the table's changes over", renamed);
  check(after.some((r) => r.title === "Initech") && after.some((r) => r.title === "Globex"), "new rows come in, rows that left the table stay");

  // A dropped column pauses the sync with the server's words; a new address checks the table again.
  await db.execute(sql.raw(`alter table ${schema}.customers drop column city`));
  await due(databaseId);
  await runDueSyncs();
  const paused = await getPostgresSync(owner, databaseId);
  check(paused?.lastError === "badQuery" && !paused.enabled && Boolean(paused.lastErrorDetail?.includes("city")), "a dropped column pauses the sync", paused);
  check((await outcome(() => updatePostgresSync(owner, databaseId, { url }))) === "badQuery", "a new address checks the table first");
  await db.execute(sql.raw(`alter table ${schema}.customers add column city text`));
  const resumed = await updatePostgresSync(owner, databaseId, { url });
  check(resumed.enabled && resumed.lastError === null, "once the table fits again, it syncs again", resumed);

  // Stopping keeps the rows.
  const count = (await rowsOf(databaseId)).length;
  await stopPostgresSync(owner, databaseId);
  check((await getPostgresSync(owner, databaseId)) === null && (await rowsOf(databaseId)).length === count, "stopping keeps the rows");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.execute(sql.raw("set client_min_messages to warning"));
  await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, owner));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
