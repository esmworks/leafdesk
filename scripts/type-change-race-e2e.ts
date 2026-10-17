/**
 * End-to-end check that changing a property's type keeps a cell saved while the change is under
 * way: the value converted is the one the row holds when the change is written, never an older one
 * read before it. A second connection holds the property's row so the type change waits at a known
 * point; the cell is written while it waits. No sleeps: the script waits until the database reports
 * the type change as blocked, so the outcome doesn't depend on timing.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/type-change-race-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import type { TransactionSql } from "postgres";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray, sql } = await import("drizzle-orm");
const { default: postgres } = await import("postgres");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, changePropertyType, deleteProperty, ensureOption, getProperties, updateRowProperties } = await import(
  "@/server/databases"
);
const { createPage } = await import("@/server/pages");
const { env } = await import("@/lib/env");
type TypeChange = Parameters<typeof changePropertyType>[2];

registerCollab({ async pagesTrashed() {}, broadcast() {}, async disconnectLostAccess() {} } as unknown as Parameters<typeof registerCollab>[0]);

const RUN = `type-change-race-e2e-${Date.now().toString(36)}`;

// Each case runs on its own, so a failing one doesn't hide how the next one does.
let passed = 0;
const failed: string[] = [];
function check(condition: unknown, label: string, detail?: unknown) {
  if (!condition) {
    failed.push(label);
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    return;
  }
  passed++;
  console.log(`ok    ${label}`);
}

/** Fails, rather than waits on, a step that doesn't finish in time. */
async function within<T>(work: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(test: () => Promise<boolean>, label: string) {
  await within(
    (async () => {
      while (!(await test())) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    label,
  );
}

// The second connection, which holds the property's row while the type change runs.
const holder = postgres(env.databaseUrl, { max: 1 });

/**
 * Changes the property's type while `write` saves a cell of the same row: the type change starts,
 * is held up where it writes the property, `write` runs, and the type change then goes on.
 * `meanwhile` changes the property itself on the holding connection before letting it go.
 */
async function retypeWithWriteBetween(
  propertyId: string,
  change: TypeChange,
  write: () => Promise<unknown>,
  meanwhile?: (tx: TransactionSql) => Promise<unknown>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let holding!: (held: { pid: number; tx: TransactionSql }) => void;
  const held = new Promise<{ pid: number; tx: TransactionSql }>((resolve) => (holding = resolve));
  const transaction = holder.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await tx`select id from database_property where id = ${propertyId} for update`;
    holding({ pid, tx });
    await released;
  });
  try {
    const { pid, tx: heldTx } = await held;
    const retyped = changePropertyType(ids.owner, propertyId, change);
    retyped.catch(() => {});
    await until(
      async () => (await db.execute(sql`select 1 from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`)).length > 0,
      "the type change waits for the held property",
    );
    await within(write(), "the cell is saved while the type change waits");
    if (meanwhile) await meanwhile(heldTx);
    release();
    await transaction;
    return await within(retyped, "the type change finishes once the property is let go");
  } finally {
    release();
    await transaction.catch(() => {});
  }
}

async function stored(rowId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(inArray(page.id, [rowId]));
  return row.properties;
}

const ids = { owner: `${RUN}-owner` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([{ workspaceId, userId: ids.owner, role: "owner" }]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  for (const prop of await getProperties(tasks.id)) await deleteProperty(ids.owner, prop.id);

  // A stored value: the cell saved meanwhile is the one converted.
  const estimate = await addProperty(ids.owner, tasks.id, { name: "Estimate", type: "text" });
  const row = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r1", properties: { Estimate: "7" } });
  check((await stored(row.id))[estimate.id] === "7", "the row starts with the old value");
  const { converted } = await retypeWithWriteBetween(estimate.id, { type: "number", yes: "Yes" }, () =>
    updateRowProperties(ids.owner, row.id, { [estimate.id]: "42" }),
  );
  const estimated = (await stored(row.id))[estimate.id];
  check(estimated === 42, "a cell saved during a type change is converted, not overwritten with the older value", { estimated });
  check(converted === 1, "the change counts the value it converted", { converted });

  // A formula: what it froze into is worked out from the cells as they are when the change is written.
  const amount = await addProperty(ids.owner, tasks.id, { name: "Amount", type: "number" });
  const double = await addProperty(ids.owner, tasks.id, { name: "Double", type: "formula", formula: { expression: 'prop("Amount") * 2' } });
  await updateRowProperties(ids.owner, row.id, { [amount.id]: 5 });
  await retypeWithWriteBetween(double.id, { type: "number", yes: "Yes" }, () => updateRowProperties(ids.owner, row.id, { [amount.id]: 21 }));
  const doubled = await stored(row.id);
  check(
    doubled[double.id] === 42 && doubled[amount.id] === 21,
    "a formula frozen during a type change uses the cells saved meanwhile",
    { double: doubled[double.id], amount: doubled[amount.id] },
  );

  // The property itself changed while the type change waited: it starts over from the new settings.
  const color = await addProperty(ids.owner, tasks.id, { name: "Color", type: "select" });
  await ensureOption(ids.owner, color.id, "Red");
  await updateRowProperties(ids.owner, row.id, { Color: "Red" });
  await retypeWithWriteBetween(
    color.id,
    { type: "text", yes: "Yes" },
    async () => {},
    (tx) => tx`update database_property set options = jsonb_set(options, '{options,0,name}', '"Crimson"'), updated_at = now() where id = ${color.id}`,
  );
  const colored = (await stored(row.id))[color.id];
  check(colored === "Crimson", "an option renamed while the type change waited is converted by its new name", { colored });

  if (failed.length) throw new Error(`${failed.length} checks failed: ${failed.join("; ")}`);
  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await holder.end();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
