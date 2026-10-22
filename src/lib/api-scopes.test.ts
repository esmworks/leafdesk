import { describe, expect, it } from "vitest";
import {
  API_SCOPE_RESOURCES,
  API_TOKEN_SCOPES,
  effectiveScopes,
  isWriteScope,
  normalizeScopes,
  presetOf,
  READ_SCOPES,
  scopesWrite,
  writeScopeOf,
} from "./api-scopes";

describe("API token scopes", () => {
  it("has a read scope for every resource and a write scope where it says so", () => {
    for (const { resource, write } of API_SCOPE_RESOURCES) {
      expect(API_TOKEN_SCOPES).toContain(`${resource}:read`);
      expect(writeScopeOf(resource) !== null).toBe(write);
    }
    expect(API_TOKEN_SCOPES).toHaveLength(API_SCOPE_RESOURCES.length + API_SCOPE_RESOURCES.filter((r) => r.write).length);
  });

  it("normalizes: known scopes only, catalog order, write brings its own read and nothing else", () => {
    expect(normalizeScopes(["rows:write"])).toEqual(["rows:read", "rows:write"]);
    expect(normalizeScopes(["agents:read", "pages:write", "pages:read"])).toEqual(["pages:read", "pages:write", "agents:read"]);
    expect(normalizeScopes(["admin", "files:write", "search:read"])).toEqual(["search:read"]);
    expect(normalizeScopes([])).toEqual([]);
  });

  it("gives a new token exactly its scopes", () => {
    expect(effectiveScopes(["pages:read"], false)).toEqual(["pages:read"]);
    expect(effectiveScopes(["pages:read", "pages:write"], false)).toEqual(["pages:read", "pages:write"]);
    expect(effectiveScopes(["comments:write"], false)).toEqual(["comments:read", "comments:write"]);
  });

  it("reads a legacy pages:read token as every read scope", () => {
    expect(effectiveScopes(["pages:read"], true)).toEqual(READ_SCOPES);
    expect(effectiveScopes(["pages:read"], true).some(isWriteScope)).toBe(false);
  });

  it("reads a legacy pages:write token as every scope, with or without pages:read stored", () => {
    expect(effectiveScopes(["pages:read", "pages:write"], true)).toEqual([...API_TOKEN_SCOPES]);
    expect(effectiveScopes(["pages:write"], true)).toEqual([...API_TOKEN_SCOPES]);
  });

  it("gives a legacy token with nothing it knows nothing", () => {
    expect(effectiveScopes([], true)).toEqual([]);
    expect(effectiveScopes(["admin"], true)).toEqual([]);
  });

  it("tells whether scopes write, and which preset they are", () => {
    expect(scopesWrite(["pages:read", "rows:read"])).toBe(false);
    expect(scopesWrite(["rows:read", "rows:write"])).toBe(true);
    expect(presetOf(READ_SCOPES)).toBe("readAll");
    expect(presetOf([...API_TOKEN_SCOPES].reverse())).toBe("all");
    expect(presetOf([...API_TOKEN_SCOPES.filter(isWriteScope), "workspaces:read", "search:read", "databases:read"])).toBe("all");
    expect(presetOf(["pages:read"])).toBeNull();
  });
});
