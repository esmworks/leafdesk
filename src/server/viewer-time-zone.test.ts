import { beforeEach, describe, expect, it, vi } from "vitest";

// Dashboards and calendar feeds read rows on the server, whose zone isn't the viewer's: "today" in
// a view's filter must count from the viewer's day (the dashboard's viewer, the feed's user).

const results: unknown[][] = [];
/** A query builder that answers each awaited query with the next of `results`. */
function query(): unknown {
  const chain: Record<string, unknown> = {};
  for (const step of ["select", "from", "where", "limit", "update", "set", "innerJoin", "leftJoin"]) chain[step] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => void) => resolve(results.shift() ?? []);
  return chain;
}
vi.mock("@/db", () => ({ db: { select: () => query(), update: () => query() } }));

const date = { id: "due", name: "Due", type: "date", options: {} };
vi.mock("@/server/databases", () => ({
  getDatabase: vi.fn(async () => ({ database: { id: "db1", workspaceId: "ws1", title: "Tasks", icon: null, inTrash: false }, properties: [date] })),
  getProperties: vi.fn(async () => [date]),
  requireDatabase: vi.fn(async () => ({ id: "db1", workspaceId: "ws1", title: "Tasks" })),
  viewedRows: vi.fn(async () => []),
  // The views a person sees (shared ones and their own); the query is mocked, so it adds nothing.
  viewOwnedBy: vi.fn(() => undefined),
  withCode: (error: Error) => error,
  getPeople: vi.fn(async () => []),
  getLookups: vi.fn(async () => null),
}));
vi.mock("@/server/workspaces", () => ({ exportAllowed: vi.fn(async () => true) }));
vi.mock("@/server/connected-app", () => ({ runAsConnectedApp: (_: unknown, run: () => unknown) => run() }));

const { viewedRows } = await import("@/server/databases");
const { widgetData } = await import("./dashboards");
const { readCalendarFeed } = await import("./calendar-feeds");

const today = { filters: [{ propertyId: "due", op: "is_within" as const, value: "today" }] };

beforeEach(() => {
  results.length = 0;
  vi.mocked(viewedRows).mockClear();
});

describe("dashboard widgets", () => {
  it("filter on the viewer's day", async () => {
    await widgetData({ userId: "u1" }, { databaseId: "db1", view: { type: "list", config: today } as never }, { timeZone: "Europe/Istanbul" });
    expect(vi.mocked(viewedRows).mock.calls[0]?.[4]).toEqual({ timeZone: "Europe/Istanbul", now: expect.any(Date) });
  });
});

describe("calendar feeds", () => {
  const secret = `ldcal_${"a".repeat(36)}`;
  const feed = (timeZone: string | null) => ({ id: "f1", userId: "u1", viewId: "v1", workspaceId: null, timeZone, lastUsedAt: new Date() });
  const view = { id: "v1", databaseId: "db1", type: "calendar", name: "Calendar", config: today, deletedAt: null };

  it("filter on the day of the feed's user", async () => {
    const now = new Date("2026-10-12T22:30:00Z");
    results.push([feed("Europe/Istanbul")], [view]);
    expect((await readCalendarFeed(secret, now)).status).toBe(200);
    expect(vi.mocked(viewedRows).mock.calls[0]?.[4]).toEqual({ now, timeZone: "Europe/Istanbul" });
  });

  it("filter on UTC days for a feed without a zone", async () => {
    results.push([feed(null)], [view]);
    expect((await readCalendarFeed(`ldcal_${"b".repeat(36)}`)).status).toBe(200);
    expect(vi.mocked(viewedRows).mock.calls[0]?.[4]).toMatchObject({ timeZone: "UTC" });
  });
});
