import { sql } from "drizzle-orm";
import { db } from "@/db";
import journal from "../../drizzle/meta/_journal.json";

/**
 * Readiness for /api/health/ready: the database answers, and it has the newest migration this
 * build ships with. Answers in generic words only: a database error's text can hold the
 * connection URL, so none of it goes into the response.
 */
export type DatabaseCheck = "ok" | "unreachable" | "timeout";
export type MigrationsCheck = "ok" | "pending" | "unknown";
export type Readiness = { ready: boolean; checks: { database: DatabaseCheck; migrations: MigrationsCheck } };

/**
 * The newest migration's time in drizzle/meta/_journal.json. The migrator stores it as
 * `created_at` of the row it adds to drizzle.__drizzle_migrations, and applies every migration
 * newer than the newest row there; read from the bundle, so it is what this build expects.
 */
export const NEWEST_MIGRATION_MILLIS = Math.max(...journal.entries.map((e) => e.when));

/** How long the whole check may take, both queries together. */
export const READINESS_TIMEOUT_MS = 2000;

class Timeout extends Error {}

// Postgres codes for a missing table or schema: a database the migrator has never run on.
const NOT_MIGRATED = new Set(["42P01", "3F000"]);

export async function readiness({ newestMigration = NEWEST_MIGRATION_MILLIS, timeoutMs = READINESS_TIMEOUT_MS } = {}): Promise<Readiness> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), timeoutMs);
  });
  // A query still running at the deadline is left to finish on its own; race keeps its outcome
  // from going unhandled.
  const withinDeadline = <T>(query: Promise<T>) => Promise.race([query, deadline]);

  try {
    try {
      await withinDeadline(db.execute(sql`select 1`));
    } catch (error) {
      return result(error instanceof Timeout ? "timeout" : "unreachable", "unknown", error);
    }
    try {
      const [row] = await withinDeadline(
        db.execute<{ latest: string | number | null }>(sql`select max(created_at) as latest from drizzle.__drizzle_migrations`),
      );
      const latest = row?.latest == null ? null : Number(row.latest);
      return result("ok", latest !== null && latest >= newestMigration ? "ok" : "pending");
    } catch (error) {
      if (error instanceof Timeout) return result("timeout", "unknown", error);
      return result("ok", NOT_MIGRATED.has(codeOf(error) ?? "") ? "pending" : "unknown", error);
    }
  } finally {
    clearTimeout(timer);
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

// The last state logged, so a probe every few seconds logs a change once instead of every time.
let lastLogged = "ready";

function result(database: DatabaseCheck, migrations: MigrationsCheck, error?: unknown): Readiness {
  const ready = database === "ok" && migrations === "ok";
  // Only the error's code (ECONNREFUSED, 3D000, ...): its message can hold the connection URL.
  const state = ready ? "ready" : `not ready: database ${database}, migrations ${migrations}${codeOf(error) ? ` (${codeOf(error)})` : ""}`;
  if (state !== lastLogged) {
    lastLogged = state;
    console.warn(`health: ${state}`);
  }
  return { ready, checks: { database, migrations } };
}
