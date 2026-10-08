import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAudit = vi.fn();
const memberWorkspaceIds = vi.fn();
const deleted = [
  { clientId: "client-a", scopes: ["pages:read"] },
  { clientId: "client-b", scopes: ["pages:read", "pages:write"] },
];
const updates: string[] = [];
const selects = vi.fn();

const tx = {
  delete: () => ({ where: () => ({ returning: async () => deleted }) }),
  update: (table: { _name: string }) => ({ set: () => ({ where: async () => void updates.push(table._name) }) }),
};

vi.mock("@/db", () => ({
  db: {
    transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    select: () => ({
      from: () => ({
        where: async () => {
          selects();
          return [
            { clientId: "client-a", name: "Assistant A" },
            { clientId: "client-b", name: null },
          ];
        },
      }),
    }),
  },
}));
vi.mock("@/db/schema", () => ({
  oauthAccessToken: { _name: "access", userId: "u", revoked: "r" },
  oauthRefreshToken: { _name: "refresh", userId: "u", revoked: "r" },
  oauthConsent: { _name: "consent", userId: "u", clientId: "c", scopes: "s" },
  oauthClient: { _name: "client", clientId: "c", name: "n" },
}));
vi.mock("@/server/audit", () => ({ recordAudit }));
vi.mock("@/server/access", () => ({ memberWorkspaceIds, firstPolicyHold: vi.fn() }));
vi.mock("@/lib/auth-security", () => ({ isStrongSession: vi.fn() }));

const { revokeAllConnectedApps } = await import("./grants");

beforeEach(() => {
  recordAudit.mockReset();
  memberWorkspaceIds.mockReset().mockResolvedValue(["ws-1", "ws-2"]);
  selects.mockReset();
  updates.length = 0;
});

describe("revokeAllConnectedApps", () => {
  it("revokes every token and records each app in each workspace with one lookup", async () => {
    await revokeAllConnectedApps("user-1");
    expect(updates).toEqual(["refresh", "access"]);
    expect(selects).toHaveBeenCalledTimes(1);
    expect(memberWorkspaceIds).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const events = recordAudit.mock.calls[0][0] as { workspaceId: string; target: { id: string; label: string } }[];
    expect(events.map((e) => `${e.workspaceId}:${e.target.id}:${e.target.label}`)).toEqual([
      "ws-1:client-a:Assistant A",
      "ws-2:client-a:Assistant A",
      "ws-1:client-b:Unnamed app",
      "ws-2:client-b:Unnamed app",
    ]);
  });

  it("still finishes when the audit log can't be written: the apps are cut off already", async () => {
    recordAudit.mockRejectedValue(new Error("audit insert failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(revokeAllConnectedApps("user-1")).resolves.toBeUndefined();
    expect(updates).toEqual(["refresh", "access"]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
