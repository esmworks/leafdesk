import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import journal from "../../drizzle/meta/_journal.json";
import { NEWEST_MIGRATION_MILLIS, readiness } from "./health";

vi.mock("@/db", () => ({ db: { execute: vi.fn() } }));

const execute = vi.mocked(db.execute);
const NEWEST = 1_791_663_088_257;
const SECRET_URL = "postgres://leafdesk:hunter2@db.internal:5432/leafdesk";

/** A failure the way the driver reports it: the code on the error, the URL maybe in the text. */
function pgError(code: string) {
  return Object.assign(new Error(`connect failed for ${SECRET_URL}`), { code });
}

// Answers `select 1`, then the migrations query with the given newest created_at (a bigint
// comes back as a string).
function databaseWith(latest: string | null) {
  execute.mockResolvedValueOnce([{ "?column?": 1 }] as never).mockResolvedValueOnce([{ latest }] as never);
}

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readiness", () => {
  it("expects the newest migration in the journal", () => {
    expect(NEWEST_MIGRATION_MILLIS).toBe(journal.entries.at(-1)!.when);
  });

  it("is ready when the database answers and has the newest migration", async () => {
    databaseWith(String(NEWEST));
    expect(await readiness({ newestMigration: NEWEST })).toEqual({ ready: true, checks: { database: "ok", migrations: "ok" } });
    // A database ahead of this build (rolled back to an older image) still serves it.
    databaseWith(String(NEWEST + 1));
    expect((await readiness({ newestMigration: NEWEST })).ready).toBe(true);
  });

  it("is not ready while the newest migration is missing", async () => {
    databaseWith(String(NEWEST - 1));
    expect(await readiness({ newestMigration: NEWEST })).toEqual({ ready: false, checks: { database: "ok", migrations: "pending" } });
    // The migrator made its table but recorded nothing yet.
    databaseWith(null);
    expect((await readiness({ newestMigration: NEWEST })).checks.migrations).toBe("pending");
  });

  it("counts a database the migrator never ran on as pending", async () => {
    execute.mockResolvedValueOnce([] as never).mockRejectedValueOnce(pgError("42P01"));
    expect((await readiness({ newestMigration: NEWEST })).checks).toEqual({ database: "ok", migrations: "pending" });
    // Wrapped by the query builder, the code is on the cause.
    execute.mockResolvedValueOnce([] as never).mockRejectedValueOnce(Object.assign(new Error("Failed query"), { cause: pgError("3F000") }));
    expect((await readiness({ newestMigration: NEWEST })).checks.migrations).toBe("pending");
  });

  it("says unknown when the migrations can't be read for another reason", async () => {
    execute.mockResolvedValueOnce([] as never).mockRejectedValueOnce(pgError("42501"));
    expect(await readiness({ newestMigration: NEWEST })).toEqual({ ready: false, checks: { database: "ok", migrations: "unknown" } });
  });

  it("reports an unreachable database without the error's text", async () => {
    execute.mockRejectedValueOnce(pgError("3D000"));
    const result = await readiness({ newestMigration: NEWEST });
    expect(result).toEqual({ ready: false, checks: { database: "unreachable", migrations: "unknown" } });
    // Neither the answer nor the log carries the message (it can hold the connection URL).
    expect(JSON.stringify(result)).not.toContain("hunter2");
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("3D000");
    expect(logged).not.toContain("hunter2");
    // The migrations aren't asked about on a database that doesn't answer.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("gives up on a database that doesn't answer in time", async () => {
    vi.useFakeTimers();
    execute.mockReturnValueOnce(new Promise(() => {}) as never);
    const pending = readiness({ newestMigration: NEWEST, timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ ready: false, checks: { database: "timeout", migrations: "unknown" } });
  });

  it("shares one deadline between both queries", async () => {
    vi.useFakeTimers();
    execute
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([] as never), 1500)) as never)
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([{ latest: String(NEWEST) }] as never), 1000)) as never);
    const pending = readiness({ newestMigration: NEWEST, timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).checks).toEqual({ database: "timeout", migrations: "unknown" });
  });
});
