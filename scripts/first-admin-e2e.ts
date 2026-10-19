/**
 * End-to-end check of the first-account rule (server/first-admin.ts) against a real PostgreSQL:
 * the first account of an empty server becomes its administrator; of accounts signing up at the
 * same time exactly one does, round after round; later accounts don't; a server that already had
 * accounts names nobody; and of two accounts that both exist when they are checked, the older one
 * wins whichever check runs first.
 *
 * It needs an empty server, so it makes its own database next to the one in DATABASE_URL (or
 * FIRST_ADMIN_E2E_DATABASE_URL), migrates it, and drops it at the end. The role needs CREATEDB.
 *
 *   FIRST_ADMIN_E2E_DATABASE_URL=postgres://leafdesk:leafdesk@localhost:5432/leafdesk pnpm tsx scripts/first-admin-e2e.ts
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

try {
  process.loadEnvFile();
} catch {}

const SERVER_URL = process.env.FIRST_ADMIN_E2E_DATABASE_URL || process.env.DATABASE_URL;
if (!SERVER_URL) throw new Error("Set FIRST_ADMIN_E2E_DATABASE_URL (or DATABASE_URL) to a PostgreSQL the script may create a database on");
const RUN = Date.now().toString(36);
const DB_NAME = `leafdesk_first_admin_e2e_${RUN}`;
const testUrl = new URL(SERVER_URL);
testUrl.pathname = `/${DB_NAME}`;

const admin = postgres(SERVER_URL, { max: 1, onnotice: () => {} });
await admin.unsafe(`create database "${DB_NAME}"`);
let failed = false;
try {
  const migrator = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
  await migrate(drizzle(migrator), { migrationsFolder: "./drizzle" });
  await migrator.end();

  // Imported now: the database client reads DATABASE_URL when it is created.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.BETTER_AUTH_SECRET ||= "first-admin-e2e-secret-not-used-anywhere-else-000";
  delete process.env.DISABLE_SIGNUP;
  await run();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  const pool = (globalThis as unknown as { __leafdeskSql?: postgres.Sql }).__leafdeskSql;
  await pool?.end({ timeout: 5 });
  await admin.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
  await admin.end();
}
process.exit(failed ? 1 : 0);

async function run() {
  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("@/db");
  const { user, verification } = await import("@/db/schema");
  const { auth } = await import("@/lib/auth");
  const { registerCollab } = await import("@/server/collab/bridge");
  const { claimFirstAdmin, firstAdminId, instanceAdmin } = await import("@/server/first-admin");

  // Sign-up makes a personal workspace and its first page; nothing here needs live documents.
  registerCollab({
    async pagesTrashed() {},
    broadcast() {},
    async setTitle() {},
    async disconnectUser() {},
    async readPage() {
      return { title: "", markdown: "", text: "" };
    },
    async disconnectLostAccess() {},
  } as unknown as Parameters<typeof registerCollab>[0]);

  let passed = 0;
  function check(condition: unknown, label: string, detail?: unknown): asserts condition {
    if (!condition) {
      console.error(`FAIL  ${label}`);
      if (detail !== undefined) console.error(detail);
      throw new Error(label);
    }
    passed++;
    console.log(`ok    ${label}`);
  }

  const MARK = "leafdesk:first-admin";
  const forgetCache = () => delete (globalThis as unknown as { __leafdeskFirstAdmin?: unknown }).__leafdeskFirstAdmin;
  /** An empty server again. */
  async function reset() {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate ${user} cascade`);
    });
    await db.delete(verification);
    forgetCache();
  }
  let n = 0;
  const signUp = async () => {
    const email = `first-admin-${RUN}-${++n}@example.test`;
    return (await auth.api.signUpEmail({ body: { email, name: `Person ${n}`, password: "first-admin-e2e-123" } })).user.id;
  };
  const marks = async () => db.select({ value: verification.value }).from(verification).where(eq(verification.identifier, MARK));
  const admins = async (ids: string[]) => {
    forgetCache();
    const flags = await Promise.all(ids.map((id) => instanceAdmin({ id, email: `${id}@example.test`, emailVerified: false })));
    return ids.filter((_, i) => flags[i]);
  };

  // The first account on an empty server.
  await reset();
  const first = await signUp();
  check((await marks()).length === 1 && (await marks())[0].value === first, "the first account on an empty server is named");
  forgetCache();
  check((await firstAdminId()) === first, "firstAdminId reads it back");
  const second = await signUp();
  check((await admins([first, second])).join() === first, "a later account is not an administrator");
  check((await marks()).length === 1, "and the mark doesn't move");

  // Simultaneous first sign-ups, several rounds of two and one of eight.
  for (const [rounds, size] of [
    [8, 2],
    [2, 8],
  ] as const) {
    for (let round = 1; round <= rounds; round++) {
      await reset();
      const ids = await Promise.all(Array.from({ length: size }, () => signUp()));
      const named = await marks();
      const winners = await admins(ids);
      check(
        named.length === 1 && winners.length === 1 && ids.includes(named[0].value) && winners[0] === named[0].value,
        `${size} sign-ups at the same time, round ${round}: exactly one is named`,
        { ids, named, winners },
      );
    }
  }

  // A server that had accounts before (made without the rule: no hook ran for them).
  await reset();
  const before = new Date(Date.now() - 60_000);
  await db.insert(user).values({ id: `old-${RUN}`, name: "Old account", email: `old-${RUN}@example.test`, createdAt: before, updatedAt: before });
  const newcomer = await signUp();
  check((await marks()).length === 0, "on a server that already had accounts, a new account names nobody");
  check((await admins([`old-${RUN}`, newcomer])).length === 0, "and nobody is an administrator by it");

  // Two accounts that both exist before either is checked: the older one, whichever check runs first.
  for (const order of ["newer first", "older first"] as const) {
    await reset();
    const t = Date.now();
    const older = { id: `a-${RUN}-${order.length}`, name: "Older", email: `older-${RUN}-${order.length}@example.test`, createdAt: new Date(t), updatedAt: new Date(t) };
    const newer = { id: `b-${RUN}-${order.length}`, name: "Newer", email: `newer-${RUN}-${order.length}@example.test`, createdAt: new Date(t + 1), updatedAt: new Date(t + 1) };
    await db.insert(user).values([older, newer]);
    const claims = order === "newer first" ? [claimFirstAdmin(newer.id), claimFirstAdmin(older.id)] : [claimFirstAdmin(older.id), claimFirstAdmin(newer.id)];
    await Promise.all(claims);
    const named = await marks();
    check(named.length === 1 && named[0].value === older.id, `both accounts there, checked ${order}: the older one is named`, named);
  }

  // Same creation time: the id breaks the tie, the same way for both checks.
  await reset();
  const same = new Date();
  await db.insert(user).values([
    { id: `y-${RUN}`, name: "Y", email: `y-${RUN}@example.test`, createdAt: same, updatedAt: same },
    { id: `x-${RUN}`, name: "X", email: `x-${RUN}@example.test`, createdAt: same, updatedAt: same },
  ]);
  const results = await Promise.all([claimFirstAdmin(`y-${RUN}`), claimFirstAdmin(`x-${RUN}`)]);
  check(results.filter(Boolean).length === 1 && (await marks())[0]?.value === `x-${RUN}`, "same creation time: one is named, by id");

  // The window the lock closes: an older account whose sign-up hasn't committed yet is being
  // named while a newer one, which can't see it, is checked. Without the lock both would be.
  await reset();
  const newer = `newer-${RUN}`;
  await db.insert(user).values({ id: newer, name: "Newer", email: `${newer}@example.test` });
  const held = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
  let settled = false;
  const pending = await held.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${MARK}))`;
    const older = new Date(Date.now() - 1000);
    await tx`insert into "user" (id, name, email, created_at, updated_at) values (${`older-${RUN}`}, 'Older', ${`older-${RUN}@example.test`}, ${older}, ${older})`;
    const claim = claimFirstAdmin(newer).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(!settled, "a check waits while another is naming an account");
    await tx`insert into verification (id, identifier, value, expires_at) values (${crypto.randomUUID()}, ${MARK}, ${`older-${RUN}`}, '9999-12-31')`;
    return [claim];
  });
  check((await pending[0]) === false, "and then names nobody else");
  await held.end();
  const named = await marks();
  check(named.length === 1 && named[0].value === `older-${RUN}`, "one account is named", named);

  console.log(`\n${passed} checks passed`);
}
