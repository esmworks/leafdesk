/**
 * An agent's daily limit on changes (daily-changes.ts): a change is taken while the day's count is
 * under the limit, refused once it is reached, and refused too when the count can't be written or
 * read; an agent without a limit never touches the database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ returned: [] as { count: number }[], selected: [] as { count: number }[], fail: false, calls: 0 }));

vi.mock("@/db", () => {
  const chain = (result: () => unknown) => {
    const step: Record<string, unknown> = {};
    for (const name of ["values", "onConflictDoUpdate", "from", "where", "set"]) step[name] = () => step;
    step.returning = async () => result();
    step.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(result).then(resolve, reject);
    return step;
  };
  const run = (value: () => unknown) => () => {
    store.calls++;
    if (store.fail) throw new Error("connection refused");
    return value();
  };
  return {
    db: {
      insert: () => chain(run(() => store.returned)),
      select: () => chain(run(() => store.selected)),
      update: () => chain(run(() => [])),
    },
  };
});

const { dailyLimitReached, takeDailyChange } = await import("./daily-changes");

const agent = { id: "agent-1", dailyChangeLimit: 3, quietHours: null };
const now = new Date("2026-10-07T12:00:00Z");

describe("takeDailyChange", () => {
  beforeEach(() => {
    store.returned = [];
    store.selected = [];
    store.fail = false;
    store.calls = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("takes one while the day's count is under the limit", async () => {
    store.returned = [{ count: 2 }];
    expect(await takeDailyChange(agent, now)).toEqual({ day: "2026-10-07" });
  });

  it("refuses once the limit is reached (no row comes back)", async () => {
    expect(await takeDailyChange(agent, now)).toBeNull();
  });

  it("refuses when the count can't be written", async () => {
    store.fail = true;
    expect(await takeDailyChange(agent, now)).toBeNull();
  });

  it("counts on the quiet hours' day", async () => {
    store.returned = [{ count: 1 }];
    const quiet = { ...agent, quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Istanbul" } };
    expect(await takeDailyChange(quiet, new Date("2026-10-07T22:30:00Z"))).toEqual({ day: "2026-10-08" });
  });

  it("leaves the database alone without a limit", async () => {
    store.fail = true;
    expect(await takeDailyChange({ ...agent, dailyChangeLimit: null }, now)).toEqual({ day: "2026-10-07" });
    expect(store.calls).toBe(0);
  });
});

describe("dailyLimitReached", () => {
  beforeEach(() => {
    store.selected = [];
    store.fail = false;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("reads the day's count against the limit", async () => {
    expect(await dailyLimitReached(agent, now)).toBe(false);
    store.selected = [{ count: 3 }];
    expect(await dailyLimitReached(agent, now)).toBe(true);
  });

  it("counts an unreadable count as reached", async () => {
    store.fail = true;
    expect(await dailyLimitReached(agent, now)).toBe(true);
  });
});
