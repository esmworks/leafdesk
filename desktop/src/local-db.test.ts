// The local database for real: made, migrated with the server's migrations, stopped, started
// again, killed and recovered. CI runs this on macOS, Windows and Linux (.github/workflows/ci.yml).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import postgres from "postgres";
import { startLocalDatabase, type LocalDatabase } from "./local-db.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafdesk local db "));
const drizzle = path.join(import.meta.dirname, "..", "..", "drizzle");

// The last one started, stopped even when the test fails (else it would outlive the test).
let running: LocalDatabase | null = null;
const start = async () => (running = await startLocalDatabase(root));

after(async () => {
  await running?.stop().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function migrate(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const journal = JSON.parse(fs.readFileSync(path.join(drizzle, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const statements = fs.readFileSync(path.join(drizzle, `${tag}.sql`), "utf8").split("--> statement-breakpoint");
    await sql.begin(async (tx) => {
      for (const statement of statements) if (statement.trim()) await tx.unsafe(statement);
    });
  }
  await sql.end();
  return journal.entries.length;
}

test("the local database runs the server's migrations, keeps its data and recovers", { timeout: 300_000 }, async () => {
  const first = await start();
  assert.match(first.url, /^postgres:\/\/leafdesk:[^@]+@127\.0\.0\.1:\d+\/postgres$/);
  const migrations = await migrate(first.url);
  assert.ok(migrations > 80, `${migrations} migrations`);

  let sql = postgres(first.url, { max: 2 });
  const [server] = await sql`select current_setting('server_version_num')::int as version, current_setting('listen_addresses') as listen`;
  assert.ok(server.version >= 180000, `PostgreSQL ${server.version}`);
  assert.equal(server.listen, "127.0.0.1");
  const [db] = await sql`select datlocprovider as provider, datlocale as locale, pg_encoding_to_char(encoding) as encoding from pg_database where datname = current_database()`;
  assert.deepEqual({ ...db }, { provider: "b", locale: "C.UTF-8", encoding: "UTF8" });
  // Unicode case and full-text search, as pages use them, without the system's locales.
  const [text] = await sql`select upper('çalışma ğüş') as up, to_tsvector('simple', 'Toplantı notları') @@ plainto_tsquery('simple', 'Notları') as found`;
  assert.deepEqual({ ...text }, { up: "ÇALIŞMA ĞÜŞ", found: true });
  const tables = await sql`select count(*)::int as n from pg_tables where schemaname = 'public'`;
  assert.ok(tables[0].n > 80, `${tables[0].n} tables`);
  await sql`insert into "user" (id, name, email) values ('local-db-test', 'Local', 'local@example.test')`;
  await sql.end();
  await first.stop();

  // Started again, on another port, with what it held.
  const second = await start();
  sql = postgres(second.url, { max: 1 });
  assert.equal((await sql`select name from "user" where id = 'local-db-test'`)[0]?.name, "Local");
  await sql`update "user" set name = 'Before the crash' where id = 'local-db-test'`;
  await sql.end();

  // Killed (the app crashed, the computer lost power): the next start recovers.
  const pid = Number(fs.readFileSync(path.join(root, "data", "postmaster.pid"), "utf8").split("\n")[0]);
  process.kill(pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const third = await start();
  sql = postgres(third.url, { max: 1 });
  assert.equal((await sql`select name from "user" where id = 'local-db-test'`)[0]?.name, "Before the crash");
  await sql.end();

  // A database left running (by an app that crashed): stopped and started on the new port.
  const fourth = await start();
  assert.notEqual(fourth.port, third.port);
  sql = postgres(fourth.url, { max: 1 });
  assert.equal((await sql`select count(*)::int as n from "user"`)[0].n, 1);
  await sql.end();
  await fourth.stop();
  assert.equal(fs.existsSync(path.join(root, "data", "postmaster.pid")), false, "stopped cleanly");
});
