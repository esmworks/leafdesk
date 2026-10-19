import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { pickDestination } = await import("./moves");

const owner = (userId: string, account: { id: string; status?: string } | null = null) => ({
  userId,
  defaultAccount: account ? { id: account.id, status: account.status ?? "active" } : null,
});
const disk = { s3: false, room: Number.MAX_SAFE_INTEGER };
const s3 = (room: number) => ({ s3: true, room });

describe("pickDestination", () => {
  it("is the first owner's default storage, leaving out the person going and the storage being left", () => {
    const owners = [owner("leaver", { id: "a-leaver" }), owner("second", { id: "a-second" }), owner("third", { id: "a-third" })];
    expect(pickDestination({ owners, excludeUserId: "leaver", server: disk, bytes: 10 })).toEqual({ toAccountId: "a-second" });
    expect(pickDestination({ owners, excludeAccountIds: ["a-leaver", "a-second"], server: disk, bytes: 10 })).toEqual({ toAccountId: "a-third" });
  });

  it("skips an owner without a default, or whose default doesn't work", () => {
    const owners = [owner("a"), owner("b", { id: "a-b", status: "broken" }), owner("c", { id: "a-c" })];
    expect(pickDestination({ owners, server: disk, bytes: 1 })).toEqual({ toAccountId: "a-c" });
  });

  it("is never the server's disk, however much room it has", () => {
    expect(pickDestination({ owners: [owner("leaver", { id: "a-leaver" })], excludeUserId: "leaver", server: disk, bytes: 0 })).toBeNull();
    expect(pickDestination({ owners: [], server: disk, bytes: 0 })).toBeNull();
  });

  it("is the server's S3 storage when no owner has storage and the files fit the quota there", () => {
    expect(pickDestination({ owners: [owner("a")], server: s3(1000), bytes: 1000 })).toEqual({ toServer: true });
    expect(pickDestination({ owners: [owner("a")], server: s3(1000), bytes: 1001 })).toBeNull();
    // Another owner's storage comes first.
    expect(pickDestination({ owners: [owner("a", { id: "a-a" })], server: s3(1000), bytes: 1 })).toEqual({ toAccountId: "a-a" });
  });
});
