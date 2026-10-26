import { describe, expect, it, vi } from "vitest";

// The tokens a select answers (the one updateApiTokenScopes reads first), and transactions started.
const store = vi.hoisted(() => ({ tokens: [] as { workspaceId: string | null }[], transaction: vi.fn(async () => null) }));
vi.mock("@/db", () => {
  const select = () => {
    const chain = { from: () => chain, where: () => Promise.resolve(store.tokens.splice(0)) };
    return chain;
  };
  return { db: { select, transaction: store.transaction } };
});
const access = vi.hoisted(() => ({
  findMembership: vi.fn(async (): Promise<{ role: string } | null> => null),
  getMembership: vi.fn(async (): Promise<{ role: string } | null> => null),
  memberWorkspaceIds: vi.fn(async () => ["ws-1", "ws-2"]),
  signInPolicyRefusal: vi.fn(async (): Promise<Error | null> => null),
}));
vi.mock("@/server/access", () => access);

const { ApiTokenError, createApiToken, generateTokenSecret, hashToken, TOKEN_PATTERN, updateApiTokenScopes, verifyApiToken } = await import("./tokens");

describe("token secrets", () => {
  it("are esi_ plus 40 letters and digits, and differ every time", () => {
    const secrets = new Set(Array.from({ length: 200 }, generateTokenSecret));
    expect(secrets.size).toBe(200);
    for (const secret of secrets) expect(secret).toMatch(TOKEN_PATTERN);
  });

  it("use the whole alphabet", () => {
    const seen = new Set(Array.from({ length: 200 }, generateTokenSecret).join("").slice(4));
    expect(seen.size).toBeGreaterThan(60);
  });

  it("are stored as a SHA-256 hash", () => {
    expect(hashToken("esi_abc")).toBe(hashToken("esi_abc"));
    expect(hashToken("esi_abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("esi_abc")).not.toBe(hashToken("esi_abd"));
  });
});


describe("createApiToken input checks", () => {
  const refuse = async (input: Parameters<typeof createApiToken>[1], code: string) => {
    const error = await createApiToken("u1", input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiTokenError);
    expect((error as InstanceType<typeof ApiTokenError>).code).toBe(code);
  };

  it("needs a name of at most 100 characters", async () => {
    await refuse({ name: "  ", scopes: ["pages:read"] }, "name");
    await refuse({ name: "x".repeat(101), scopes: ["pages:read"] }, "name");
  });

  it("needs known scopes", async () => {
    await refuse({ name: "t", scopes: [] }, "scopes");
    await refuse({ name: "t", scopes: ["pages:read", "admin"] }, "scopes");
    // Scopes of the MCP server's OAuth tokens aren't the API's.
    await refuse({ name: "t", scopes: ["files:write"] }, "scopes");
  });

  it("expires after 1 to 3650 whole days, or never", async () => {
    await refuse({ name: "t", scopes: ["pages:read"], expiresInDays: 0 }, "expiry");
    await refuse({ name: "t", scopes: ["pages:read"], expiresInDays: 1.5 }, "expiry");
    await refuse({ name: "t", scopes: ["pages:read"], expiresInDays: 3651 }, "expiry");
  });

  it("can only be bound to a workspace the user belongs to", async () => {
    await refuse({ name: "t", scopes: ["pages:read"], workspaceId: "someone-elses" }, "workspace");
  });
});

describe("the workspaces' sign-in policies", () => {
  const held = new Error("This workspace requires two-step verification");

  it("keep a session they hold back from changing a token's scopes, before anything changes", async () => {
    store.tokens.push({ workspaceId: "ws-1" });
    access.signInPolicyRefusal.mockResolvedValueOnce(held);
    await expect(updateApiTokenScopes("u1", "tok-1", ["pages:read"])).rejects.toBe(held);
    expect(access.signInPolicyRefusal).toHaveBeenLastCalledWith("u1", ["ws-1"]);
    expect(store.transaction).not.toHaveBeenCalled();
  });

  it("are asked of every workspace for a token that reaches all of them", async () => {
    store.tokens.push({ workspaceId: null });
    access.signInPolicyRefusal.mockResolvedValueOnce(held);
    await expect(updateApiTokenScopes("u1", "tok-1", ["pages:read"])).rejects.toBe(held);
    expect(access.signInPolicyRefusal).toHaveBeenLastCalledWith("u1", ["ws-1", "ws-2"]);
  });

  it("aren't asked about someone else's token", async () => {
    access.signInPolicyRefusal.mockClear();
    const error = await updateApiTokenScopes("u1", "theirs", ["pages:read"]).catch((e: unknown) => e);
    expect((error as InstanceType<typeof ApiTokenError>).code).toBe("notFound");
    expect(access.signInPolicyRefusal).not.toHaveBeenCalled();
  });

  it("apply to an owner giving a token the audit log too", async () => {
    access.findMembership.mockResolvedValueOnce({ role: "owner" });
    access.getMembership.mockRejectedValueOnce(held);
    await expect(createApiToken("u1", { name: "t", scopes: ["audit:read"], workspaceId: "ws-1" })).rejects.toBe(held);
    expect(access.getMembership).toHaveBeenCalledWith("u1", "ws-1");
  });
});

describe("verifyApiToken", () => {
  it("turns away anything that isn't shaped like a token without looking it up", async () => {
    for (const value of ["", "esi_short", `ghp_${"a".repeat(40)}`, `esi_${"a".repeat(39)}!`]) {
      expect(await verifyApiToken(value)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});
