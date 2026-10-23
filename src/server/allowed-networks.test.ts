import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving a workspace's approved networks: owners only, canonical entries, and never a list that
 * leaves out the saving owner's own address. The database is a stub that keeps the stored list.
 */
let stored: unknown = [];
const writes: unknown[] = [];

function selectChain() {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from", "where"]) node[method] = () => node;
  node.limit = async () => [{ networks: stored }];
  node.for = async () => [{ networks: stored }];
  return node;
}
const tx = {
  select: () => selectChain(),
  update: () => ({
    set: (values: { allowedNetworks: unknown }) => ({
      where: async () => {
        stored = values.allowedNetworks;
        writes.push(values.allowedNetworks);
      },
    }),
  }),
};

vi.mock("@/db", () => ({ db: { ...tx, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }));

const requireMembership = vi.fn(async () => ({ role: "owner" }));
vi.mock("@/server/access", () => ({ requireMembership, requireMember: vi.fn(async () => ({ role: "member" })) }));
const recordAudit = vi.fn(async () => {});
vi.mock("@/server/audit", () => ({ recordAudit }));
const disconnectHeldBack = vi.fn(async () => {});
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ disconnectHeldBack }) }));
vi.mock("@/server/local-mode", () => ({ refuseInLocalMode: () => {} }));
vi.mock("@/server/workspaces", () => ({
  WorkspaceError: class WorkspaceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly detail = "",
    ) {
      super(message);
    }
  },
}));

const { setAllowedNetworks } = await import("./allowed-networks");

const save = (input: unknown, clientIp: string | null) => setAllowedNetworks("owner1", "ws1", input, { clientIp });

beforeEach(() => {
  stored = [];
  writes.length = 0;
  vi.clearAllMocks();
});

describe("setAllowedNetworks", () => {
  it("refuses a list that leaves out the owner's own address, naming it", async () => {
    await expect(save([{ range: "198.51.100.0/24", label: "Office" }], "203.0.113.9")).rejects.toMatchObject({
      code: "ipLocksYouOut",
      detail: "203.0.113.9",
    });
    expect(writes).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("shows a mapped address as the IPv4 address it carries", async () => {
    await expect(save([{ range: "198.51.100.0/24" }], "::ffff:203.0.113.9")).rejects.toMatchObject({ code: "ipLocksYouOut", detail: "203.0.113.9" });
  });

  it("refuses a list when the owner's address isn't known", async () => {
    await expect(save([{ range: "0.0.0.0/0" }], null)).rejects.toMatchObject({ code: "ipLocksYouOut", detail: "" });
    await expect(save([{ range: "0.0.0.0/0" }], "unknown")).rejects.toMatchObject({ code: "ipLocksYouOut", detail: "" });
  });

  it("saves a list that covers the owner, made canonical, with its audit event, and closes held-back connections", async () => {
    const saved = await save(
      [
        { range: "192.0.2.77/24", label: " Office " },
        { range: "2001:DB8::/32", label: "" },
      ],
      "::ffff:192.0.2.10",
    );
    expect(saved).toEqual([
      { range: "192.0.2.0/24", label: "Office" },
      { range: "2001:db8::/32", label: "" },
    ]);
    expect(stored).toEqual(saved);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        actorId: "owner1",
        action: "workspace.networks_changed",
        details: expect.objectContaining({ names: ["192.0.2.0/24 (Office)", "2001:db8::/32"], count: 2, previous: 0 }),
      }),
      expect.anything(),
    );
    expect(disconnectHeldBack).toHaveBeenCalledWith("ws1");
  });

  it("always lets an owner clear the list, from any address", async () => {
    stored = [{ range: "192.0.2.0/24", label: "" }];
    expect(await save([], null)).toEqual([]);
    expect(stored).toEqual([]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ count: 0, previous: 1 }) }), expect.anything());
    expect(disconnectHeldBack).not.toHaveBeenCalled();
  });

  it("writes and records nothing when the list didn't change", async () => {
    stored = [{ range: "192.0.2.0/24", label: "" }];
    await save([{ range: "192.0.2.0/24" }], "192.0.2.1");
    expect(writes).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("names the entry it can't read", async () => {
    await expect(save([{ range: "192.0.2.1" }, { range: "example.com" }], "192.0.2.1")).rejects.toMatchObject({
      code: "invalidNetwork",
      detail: "example.com",
    });
    await expect(save([{ range: "10.0.0.0/33" }], "10.0.0.1")).rejects.toMatchObject({ code: "invalidNetwork", detail: "10.0.0.0/33" });
    await expect(save([{ range: "10.0.0.1", label: "x".repeat(101) }], "10.0.0.1")).rejects.toMatchObject({ code: "invalidNetworkLabel" });
    const many = Array.from({ length: 101 }, (_, i) => ({ range: `10.0.0.${i}` }));
    await expect(save(many, "10.0.0.1")).rejects.toMatchObject({ code: "tooManyNetworks" });
  });

  it("is for owners only", async () => {
    requireMembership.mockRejectedValueOnce(new Error("Not found or access denied"));
    await expect(save([], "192.0.2.1")).rejects.toThrow("Not found or access denied");
    expect(requireMembership).toHaveBeenCalledWith("owner1", "ws1", "owner");
  });
});
