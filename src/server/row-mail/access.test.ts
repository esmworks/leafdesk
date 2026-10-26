import { beforeEach, describe, expect, it, vi } from "vitest";

// Who reads a row's email (server/row-mail/access.ts): what the person of a request reads and
// writes answers to their workspace's sign-in policies; checks for others and background work don't.

vi.mock("@/db", () => {
  const select = () => {
    const chain = { from: () => chain, where: () => Promise.resolve([]) };
    return chain;
  };
  return { db: { select } };
});
const access = vi.hoisted(() => ({
  pageAccessOf: vi.fn(async (_userId: string, pageId: string) =>
    pageId === "row-1"
      ? { page: { id: "row-1", parentId: "db-1", workspaceId: "ws-1", archivedAt: null, properties: {}, createdBy: "u2" }, level: "edit" }
      : { page: { id: pageId, parentId: null, workspaceId: "ws-1", kind: "database" }, level: "full" },
  ),
  enforceWorkspacePolicy: vi.fn(async () => {}),
}));
vi.mock("@/server/access", () => access);
vi.mock("@/server/property-access", () => ({ propertyAccessFor: vi.fn() }));

const { requestRowMailAccess, rowMailAccess, seeRowMail } = await import("./access");

const held = new Error("This workspace requires two-step verification");

beforeEach(() => vi.clearAllMocks());

describe("requestRowMailAccess", () => {
  it("is rowMailAccess for a session the workspace's policies let in", async () => {
    expect(await requestRowMailAccess("u1", "row-1")).toMatchObject({ rowId: "row-1", databaseId: "db-1", workspaceId: "ws-1", level: "edit", databaseFull: true });
    expect(access.enforceWorkspacePolicy).toHaveBeenCalledWith("u1", "ws-1");
  });

  it("throws the policy's error for a session it holds back", async () => {
    access.enforceWorkspacePolicy.mockRejectedValueOnce(held);
    await expect(requestRowMailAccess("u1", "row-1")).rejects.toBe(held);
  });

  it("leaves checks on others' behalf and background work to rowMailAccess, which doesn't ask", async () => {
    access.enforceWorkspacePolicy.mockRejectedValue(held);
    expect(await rowMailAccess("u1", "row-1")).not.toBeNull();
    expect(await seeRowMail(["u1", "u2"], "row-1")).toEqual(["u1", "u2"]);
    expect(access.enforceWorkspacePolicy).not.toHaveBeenCalled();
    access.enforceWorkspacePolicy.mockReset();
  });
});
