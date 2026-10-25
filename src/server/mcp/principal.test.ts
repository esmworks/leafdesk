// MCP bearer tokens: claims to auth info, the principal and the resource metadata URL.
import { describe, expect, it } from "vitest";
import { authInfoFromClaims, bearerToken, principalFromAuthInfo, protectedResourceMetadataUrl } from "./principal";

const resource = "http://localhost:3000/mcp";

describe("authInfoFromClaims", () => {
  it("maps sub, client and scopes", () => {
    const info = authInfoFromClaims(
      { sub: "user-1", azp: "client-1", scope: "openid pages:read  pages:write", exp: 100, iat: 40 },
      "tok",
      resource,
    );
    expect(info).toMatchObject({
      token: "tok",
      clientId: "client-1",
      scopes: ["openid", "pages:read", "pages:write"],
      expiresAt: 100,
      resourceMetadataUrl: "http://localhost:3000/.well-known/oauth-protected-resource/mcp",
      extra: { userId: "user-1", issuedAt: 40 },
    });
    expect(info?.resource?.href).toBe(resource);
    expect(principalFromAuthInfo(info!)).toEqual({ userId: "user-1", clientId: "client-1", scopes: info!.scopes });
  });

  it("prefers client_id and rejects tokens without a user or client", () => {
    expect(authInfoFromClaims({ sub: "u", client_id: "a", azp: "b" }, "t", resource)?.clientId).toBe("a");
    expect(authInfoFromClaims({ azp: "b" }, "t", resource)).toBeNull();
    expect(authInfoFromClaims({ sub: "u" }, "t", resource)).toBeNull();
  });

  it("refuses to build a principal without verified auth", () => {
    expect(() => principalFromAuthInfo(undefined)).toThrow();
    expect(() => principalFromAuthInfo({ token: "t", clientId: "c", scopes: [] })).toThrow();
  });
});

describe("helpers", () => {
  it("extracts bearer and DPoP tokens", () => {
    expect(bearerToken(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(bearerToken(new Request("http://x", { headers: { authorization: "DPoP xyz" } }))).toBe("xyz");
    expect(bearerToken(new Request("http://x"))).toBe("");
  });

  it("builds RFC 9728 metadata URLs", () => {
    expect(protectedResourceMetadataUrl("https://notes.example.com/mcp")).toBe(
      "https://notes.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadataUrl("https://notes.example.com/")).toBe(
      "https://notes.example.com/.well-known/oauth-protected-resource",
    );
  });
});
