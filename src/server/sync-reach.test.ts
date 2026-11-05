import { describe, expect, it, vi } from "vitest";

// Who set up or runs a sync decides whether it may reach CONNECTOR_ALLOWED_HOSTS: owners only.

const roles: Record<string, string> = { owner1: "owner", member1: "member", guest1: "guest" };
vi.mock("@/server/access", () => ({ findMembership: vi.fn(async (userId: string) => (roles[userId] ? { role: roles[userId] } : null)) }));

const { syncFetchReach, syncReachesAllowedHosts, withSyncReach } = await import("./sync-reach");

describe("withSyncReach", () => {
  it("lets an owner's sync reach the allowed hosts, and no one else's", async () => {
    expect(await withSyncReach("owner1", "ws1", async () => syncFetchReach(true))).toEqual({ web: true, untrusted: false });
    for (const userId of ["member1", "guest1", "stranger"]) {
      expect(await withSyncReach(userId, "ws1", async () => syncFetchReach())).toEqual({ web: false, untrusted: true });
    }
  });

  it("holds a call made outside any sync to public addresses", () => {
    expect(syncReachesAllowedHosts()).toBe(false);
    expect(syncFetchReach().untrusted).toBe(true);
  });

  it("keeps the reach across awaits and apart between syncs running together", async () => {
    const later = () => new Promise((resolve) => setTimeout(resolve, 5));
    const [owner, member] = await Promise.all([
      withSyncReach("owner1", "ws1", async () => (await later(), syncReachesAllowedHosts())),
      withSyncReach("member1", "ws1", async () => (await later(), syncReachesAllowedHosts())),
    ]);
    expect([owner, member]).toEqual([true, false]);
  });
});
