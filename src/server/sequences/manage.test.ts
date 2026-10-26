import { beforeEach, describe, expect, it, vi } from "vitest";

// Follow-up sequences (server/sequences/manage.ts) answer to the workspace's sign-in policies for
// the person of the request: reading them, starting them on rows and stopping them. Sending and
// who may are checked against the database in scripts/follow-ups-e2e.ts.

const results = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/db", () => {
  const select = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select } };
});
const access = vi.hoisted(() => ({
  resolvePageAccess: vi.fn(async (): Promise<unknown> => ({ page: { id: "db-1", kind: "database", workspaceId: "ws-1" }, level: "edit" })),
  pageAccessOf: vi.fn(),
}));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("../access")>()), ...access }));
const rowMail = vi.hoisted(() => ({ rowMailAccess: vi.fn(), requestRowMailAccess: vi.fn() }));
vi.mock("@/server/row-mail/access", () => rowMail);

const { enrollRows, getSequence, listSequences, stopEnrollment } = await import("./manage");

const held = new Error("This workspace requires signing in with single sign-on");
const sequence = { id: "seq-1", workspaceId: "ws-1", databaseId: "db-1", name: "Welcome", steps: [], window: null };

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
});

describe("the workspace's sign-in policies", () => {
  it("hold back reading a database's sequences", async () => {
    access.resolvePageAccess.mockRejectedValueOnce(held);
    await expect(listSequences("u1", "db-1")).rejects.toBe(held);
    expect(access.resolvePageAccess).toHaveBeenCalledWith("u1", "db-1");
    expect(access.pageAccessOf).not.toHaveBeenCalled();
  });

  it("…reading one", async () => {
    results.push([sequence]);
    access.resolvePageAccess.mockRejectedValueOnce(held);
    await expect(getSequence("u1", "seq-1")).rejects.toBe(held);
  });

  it("…starting one on rows", async () => {
    results.push([sequence]);
    access.resolvePageAccess.mockRejectedValueOnce(held);
    await expect(enrollRows("u1", "seq-1", ["row-1"], "row")).rejects.toBe(held);
  });

  it("…and stopping one, through the person's own access to the row's email", async () => {
    results.push([{ id: "enr-1", rowId: "row-1", senderId: "u1", status: "active" }]);
    rowMail.requestRowMailAccess.mockRejectedValueOnce(held);
    await expect(stopEnrollment("u1", "enr-1")).rejects.toBe(held);
    expect(rowMail.requestRowMailAccess).toHaveBeenCalledWith("u1", "row-1");
    expect(rowMail.rowMailAccess).not.toHaveBeenCalled();
  });
});
