import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => {
  class AccessError extends Error {}
  const ranks = { none: 0, view: 1, comment: 2, edit: 3, full: 4 } as const;
  return {
    AccessError,
    findMembership: vi.fn(async () => ({ role: "member" })),
    hasLevel: (level: keyof typeof ranks, needed: keyof typeof ranks) => ranks[level] >= ranks[needed],
    pageAccessOf: vi.fn(),
    policyError: vi.fn(),
    policyHoldFor: vi.fn(async () => null),
  };
});
vi.mock("@/server/access", () => access);

const { authorizeCollab } = await import("./authorize");

const page = (kind: "page" | "database", lockedAt: Date | null) => ({ id: "p1", workspaceId: "ws-1", kind, lockedAt });

beforeEach(() => vi.clearAllMocks());

describe("authorizeCollab", () => {
  it("lets editors write to an unlocked page", async () => {
    access.pageAccessOf.mockResolvedValue({ page: page("page", null), level: "edit" });
    expect(await authorizeCollab("u1", { kind: "page", id: "p1" })).toEqual({ readOnly: false });
  });

  it("makes a locked page read-only for everyone, full access included", async () => {
    access.pageAccessOf.mockResolvedValue({ page: page("page", new Date()), level: "full" });
    expect(await authorizeCollab("u1", { kind: "page", id: "p1" })).toEqual({ readOnly: true });
  });

  it("leaves a locked database's title and description editable: its lock is about the schema", async () => {
    access.pageAccessOf.mockResolvedValue({ page: page("database", new Date()), level: "edit" });
    expect(await authorizeCollab("u1", { kind: "page", id: "p1" })).toEqual({ readOnly: false });
  });

  it("still refuses people who can't see the page", async () => {
    access.pageAccessOf.mockResolvedValue({ page: page("page", new Date()), level: "none" });
    await expect(authorizeCollab("u1", { kind: "page", id: "p1" })).rejects.toBeInstanceOf(access.AccessError);
  });
});
