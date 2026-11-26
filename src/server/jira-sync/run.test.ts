import { afterEach, describe, expect, it, vi } from "vitest";

// One sync whose source never answers must not hold every other sync behind it.

const updates: Record<string, unknown>[] = [];
vi.mock("@/db", () => ({
  db: {
    update: () => ({ set: (values: Record<string, unknown>) => (updates.push(values), { where: async () => [] }) }),
  },
}));
vi.mock("@/server/databases", () => ({ getProperties: vi.fn(), requireDatabase: vi.fn(async () => ({ id: "db1", workspaceId: "ws1", archivedAt: null })) }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ broadcast: () => {} }) }));
vi.mock("@/server/postgres-sync/run", () => ({ runPostgres: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/server/ical-sync/run", () => ({ runIcal: vi.fn(async () => ({ count: 3, created: 3, updated: 0 })) }));
vi.mock("@/server/github-pulls/run", () => ({ runGithubPulls: vi.fn() }));
vi.mock("@/server/zendesk-sync/run", () => ({ runZendesk: vi.fn() }));
vi.mock("@/server/salesforce-sync/run", () => ({ runSalesforce: vi.fn() }));
vi.mock("@/server/import/board", () => ({ matcher: vi.fn() }));
vi.mock("@/server/synced-rows", () => ({ addOptions: vi.fn(), applyRows: vi.fn(), liveFields: vi.fn() }));
vi.mock("@/server/secret-box", () => ({ openJson: vi.fn() }));
vi.mock("@/server/sync-reach", () => ({ withSyncReach: (_userId: string, _workspaceId: string, fn: () => Promise<unknown>) => fn() }));

const { runAndRecord, RUN_TIMEOUT_MS } = await import("./run");
const { PAUSE_AFTER_FAILURES } = await import("@/lib/jira-sync");

const sync = (source: string, more: Record<string, unknown> = {}) => ({ id: `s-${source}`, source, databaseId: "db1", runAs: "u1", failedRuns: 0, ...more }) as never;

afterEach(() => {
  vi.useRealTimers();
  updates.length = 0;
});

describe("runAndRecord", () => {
  it("gives up on a run that takes too long and keeps its hold", async () => {
    vi.useFakeTimers();
    const outcome = runAndRecord(sync("postgres"));
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    expect(await outcome).toEqual({ error: "unreachable", count: null });
    expect(updates[0]).toMatchObject({ lastError: "unreachable" });
    expect(updates[0]).not.toHaveProperty("runningUntil");
  });

  it("lets a run that finishes go", async () => {
    expect(await runAndRecord(sync("ical"))).toEqual({ error: null, count: 3 });
    expect(updates[0]).toMatchObject({ runningUntil: null, lastError: null, lastCount: 3, failedRuns: 0 });
  });

  it("keeps a sync on after one failure that looks lasting, and pauses it once failures repeat", async () => {
    expect(await runAndRecord(sync("ical", { runAs: null }))).toEqual({ error: "runAsGone", count: null });
    expect(updates[0]).toMatchObject({ lastError: "runAsGone", failedRuns: 1 });
    expect(updates[0]).not.toHaveProperty("enabled");
    await runAndRecord(sync("ical", { runAs: null, failedRuns: PAUSE_AFTER_FAILURES - 1 }));
    expect(updates[1]).toMatchObject({ failedRuns: PAUSE_AFTER_FAILURES, enabled: false, nextRunAt: null });
  });

  it("never pauses for a passing problem", async () => {
    vi.useFakeTimers();
    const outcome = runAndRecord(sync("postgres", { failedRuns: 50 }));
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    await outcome;
    expect(updates[0]).toMatchObject({ failedRuns: 51 });
    expect(updates[0]).not.toHaveProperty("enabled");
  });
});
