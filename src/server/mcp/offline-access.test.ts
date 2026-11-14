import { beforeEach, describe, expect, it, vi } from "vitest";

let client: { scopes: string[] | null; grantTypes: string[] | null } | undefined;

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (client ? [client] : []) }) }) }) },
}));
vi.mock("@/db/schema", () => ({ oauthClient: { clientId: "client_id", scopes: "scopes", grantTypes: "grant_types" } }));

const { clientTakesOfflineAccess, offlineAccessPlugin, withOfflineAccess } = await import("./offline-access");

const MCP = "pages:read pages:write notifications:read files:write";

type Hook = { matcher: (ctx: { path: string }) => boolean; handler: (ctx: unknown) => Promise<unknown> };
const hooks = offlineAccessPlugin().hooks.before as unknown as Hook[];
const hookFor = (path: string) => hooks.find((hook) => hook.matcher({ path }))!;

async function run(path: string, ctx: Record<string, unknown>) {
  const result = await hookFor(path).handler({ path, context: {}, headers: new Headers(), ...ctx });
  // createAuthMiddleware may wrap what the handler returned.
  return (result as { response?: unknown })?.response ?? result;
}

beforeEach(() => {
  client = { scopes: [...MCP.split(" "), "offline_access"], grantTypes: ["authorization_code", "refresh_token"] };
});

describe("withOfflineAccess", () => {
  it("adds offline_access once", () => {
    expect(withOfflineAccess(MCP)).toBe(`${MCP} offline_access`);
    expect(withOfflineAccess(`openid offline_access`)).toBe("openid offline_access");
  });
});

describe("clientTakesOfflineAccess", () => {
  it("allows a client whose scopes list it or that has none", async () => {
    expect(await clientTakesOfflineAccess("c")).toBe(true);
    client = { scopes: null, grantTypes: null };
    expect(await clientTakesOfflineAccess("c")).toBe(true);
  });

  it("refuses a client whose scopes leave it out, one without the code grant, and an unknown one", async () => {
    client = { scopes: MCP.split(" "), grantTypes: ["authorization_code"] };
    expect(await clientTakesOfflineAccess("c")).toBe(false);
    client = { scopes: null, grantTypes: ["client_credentials"] };
    expect(await clientTakesOfflineAccess("c")).toBe(false);
    client = undefined;
    expect(await clientTakesOfflineAccess("c")).toBe(false);
  });
});

describe("offlineAccessPlugin", () => {
  it("asks for offline_access when an app authorizes with only the MCP scopes", async () => {
    const query = { client_id: "c", scope: MCP, response_type: "code" };
    const result = (await run("/oauth2/authorize", { method: "GET", query })) as { context: { query: { scope: string } } };
    expect(result.context.query.scope).toBe(`${MCP} offline_access`);
    expect(query.scope).toBe(`${MCP} offline_access`);
  });

  it("reads a POST authorization's body", async () => {
    const body = { client_id: "c", scope: MCP };
    await run("/oauth2/authorize", { method: "POST", body, query: {} });
    expect(body.scope).toBe(`${MCP} offline_access`);
  });

  it("leaves an authorization alone when the client may not take it or asks for no scope", async () => {
    client = { scopes: MCP.split(" "), grantTypes: ["authorization_code"] };
    const query = { client_id: "c", scope: MCP };
    expect(await run("/oauth2/authorize", { method: "GET", query })).toBeFalsy();
    expect(query.scope).toBe(MCP);
    const bare = { client_id: "c" };
    expect(await run("/oauth2/authorize", { method: "GET", query: bare })).toBeFalsy();
    expect(bare).toEqual({ client_id: "c" });
  });

  it("registers a code-grant client with offline_access", async () => {
    const body: Record<string, unknown> = { redirect_uris: ["http://127.0.0.1:1/cb"], grant_types: ["authorization_code", "refresh_token"], scope: MCP };
    await run("/oauth2/register", { method: "POST", body });
    expect(body.scope).toBe(`${MCP} offline_access`);
    const machine: Record<string, unknown> = { grant_types: ["client_credentials"], scope: "pages:read" };
    await run("/oauth2/register", { method: "POST", body: machine });
    expect(machine.scope).toBe("pages:read");
  });
});
