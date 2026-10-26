import { beforeEach, describe, expect, it, vi } from "vitest";

// The "For review" queue (server/pending-changes.ts) answers to the workspace's sign-in policies:
// its lists are filtered in SQL only, so they ask first. What a reviewer may see and answer is
// checked against the database in scripts/review-e2e.ts.

const selects = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/db", () => {
  const select = () => {
    selects.count++;
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select } };
});
const access = vi.hoisted(() => ({
  getMembership: vi.fn(async (): Promise<{ role: string } | null> => ({ role: "member" })),
  findMembership: vi.fn(async () => ({ role: "member" })),
  enforceWorkspacePolicy: vi.fn(async () => {}),
}));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("./access")>()), ...access }));

const { listPendingChanges, getPendingChange } = await import("./pending-changes");

const held = new Error("This workspace only allows sign-in from approved networks");

beforeEach(() => {
  selects.count = 0;
  vi.clearAllMocks();
});

describe("listPendingChanges", () => {
  it("asks the workspace's policies before listing", async () => {
    expect(await listPendingChanges("u1", "ws-1")).toEqual([]);
    expect(access.getMembership).toHaveBeenCalledWith("u1", "ws-1");
    expect(access.findMembership).not.toHaveBeenCalled();
  });

  it("lists nothing for a session they hold back", async () => {
    access.getMembership.mockRejectedValueOnce(held);
    await expect(listPendingChanges("u1", "ws-1")).rejects.toBe(held);
    expect(selects.count).toBe(0);
  });

  it("turns away someone outside the workspace", async () => {
    access.getMembership.mockResolvedValueOnce(null);
    await expect(listPendingChanges("u1", "ws-1")).rejects.toThrow(/access denied/i);
  });
});

describe("getPendingChange", () => {
  it("is null for a change the viewer doesn't see, without telling its workspace", async () => {
    expect(await getPendingChange("u1", "chg-1")).toBeNull();
    expect(access.enforceWorkspacePolicy).not.toHaveBeenCalled();
  });
});
