import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({ findMembership: vi.fn(async () => null) }));

const { ApiTokenError, createApiToken, generateTokenSecret, hashToken, TOKEN_PATTERN, verifyApiToken } = await import("./tokens");

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

describe("verifyApiToken", () => {
  it("turns away anything that isn't shaped like a token without looking it up", async () => {
    for (const value of ["", "esi_short", `ghp_${"a".repeat(40)}`, `esi_${"a".repeat(39)}!`]) {
      expect(await verifyApiToken(value)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});
