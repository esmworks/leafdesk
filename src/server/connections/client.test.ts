import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing in to a service that takes no registrations, as the OAuth app an owner (or the instance)
 * registered there, or with Leafdesk's client metadata document where the service takes one. The
 * service is a fake in place of the network: Slack-shaped metadata (no registration endpoint, the
 * secret sent in the body), a token endpoint, and an MCP server behind a bearer token.
 */
process.env.BETTER_AUTH_SECRET = "test-auth-secret-that-is-long-enough-for-tests";

/** What the provider saved last (the connection's sealed secrets). */
let savedSecrets: string | null = null;
vi.mock("@/db", () => ({
  db: {
    update: () => ({
      set: (values: { secrets?: string }) => ({
        where: async () => {
          if (values.secrets !== undefined) savedSecrets = values.secrets;
        },
      }),
    }),
  },
}));

type Seen = { method: string; url: string; body: string; headers: Headers };
let seen: Seen[] = [];
let service: { mcp: string; metadata: Record<string, unknown> };

const SLACK = {
  mcp: "https://mcp.slack.com/mcp",
  metadata: {
    issuer: "https://mcp.slack.com",
    authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
    token_endpoint: "https://slack.com/api/oauth.v2.user.access",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  },
};

/** Google's: metadata under the server's path, naming Google's own sign-in at another host. */
const GOOGLE = {
  mcp: "https://sheetsmcp.googleapis.com/mcp/v1",
  metadata: {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  },
};

const ACCESS_TOKEN = "xoxp-test-access";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

/** The fake service: whatever Leafdesk fetches while signing in and listing tools. */
async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
  const headers = new Headers(init.headers);
  seen.push({ method, url: url.href, body, headers });
  const origin = new URL(service.mcp).origin;

  if (service === GOOGLE && method === "GET") {
    if (url.href === "https://sheetsmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1") {
      const scopes = ["drive.readonly", "spreadsheets.readonly", "drive", "drive.file", "spreadsheets"];
      return json({ resource: GOOGLE.mcp, authorization_servers: ["https://accounts.google.com/"], scopes_supported: scopes.map((s) => `https://www.googleapis.com/auth/${s}`) });
    }
    if (url.href === "https://accounts.google.com/.well-known/oauth-authorization-server") return json(GOOGLE.metadata);
  }
  if (url.href === `${origin}/.well-known/oauth-protected-resource` && method === "GET") {
    return json({ resource: origin, authorization_servers: [origin], scopes_supported: ["channels:read", "chat:write"] });
  }
  if (url.href === `${origin}/.well-known/oauth-authorization-server` && method === "GET") return json(service.metadata);
  if (url.href === service.metadata.token_endpoint && method === "POST") {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") !== "authorization_code" || form.get("code") !== "the-code") return json({ error: "invalid_grant" }, { status: 400 });
    return json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "xoxe-refresh" });
  }
  if (url.href === service.mcp) {
    if (headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
      return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
    }
    if (method !== "POST") return new Response("", { status: 405 });
    const message = JSON.parse(body) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    }
    if (message.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "send_message", description: "Sends a message", inputSchema: { type: "object" } }] },
      });
    }
  }
  return new Response("not found", { status: 404 });
}

vi.mock("./fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch")>()),
  connectionFetch: (input: string | URL | Request, init?: RequestInit) => fakeFetch(input, init),
}));

const { sealJson } = await import("../secret-box");
const { catalogEntryFor } = await import("@/lib/connection-catalog");
const { ConnectionOAuthProvider, dropClient, finishOAuth, listConnectionTools, oauthClientMetadataUrl, ownClientOf, secretsOf, startOAuth } = await import("./client");
type Row = import("./client").ConnectionRow;

function rowOf(url: string, secrets: object): Row {
  return { id: "conn-1", url, authType: "oauth", secrets: sealJson(secrets), kinds: {} } as unknown as Row;
}

/** The row as the provider left it. */
const reread = (row: Row): Row => ({ ...row, secrets: savedSecrets });

const saved = { ...process.env };

beforeEach(() => {
  seen = [];
  savedSecrets = null;
  service = SLACK;
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.CONNECTION_OAUTH_CLIENTS;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  dropClient("conn-1");
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("signing in as an app registered with the service", () => {
  it("signs in as the owner's app where the service takes no registrations, and lists its tools", async () => {
    const row = rowOf(SLACK.mcp, { ownClient: { client_id: "1234.5678", client_secret: "app-secret" } });

    const started = await startOAuth(row);
    expect(started).not.toBeNull();
    const authorize = started!.url;
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("1234.5678");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/connections/oauth/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("state")).toBe(started!.state);
    // The secret never goes to the browser.
    expect(authorize.href).not.toContain("app-secret");
    // Asks for all the service lists, and nothing only Google takes.
    expect(authorize.searchParams.get("scope")).toBe("channels:read chat:write");
    expect(authorize.searchParams.has("access_type")).toBe(false);

    await finishOAuth(reread(row), started!.verifier, "the-code", undefined);
    const token = seen.find((r) => r.url === SLACK.metadata.token_endpoint);
    const form = new URLSearchParams(token!.body);
    expect(form.get("client_id")).toBe("1234.5678");
    expect(form.get("client_secret")).toBe("app-secret");
    expect(form.get("code_verifier")).toBe(started!.verifier);
    expect(form.get("redirect_uri")).toBe("http://localhost:3000/api/connections/oauth/callback");

    const signedIn = reread(row);
    const secrets = secretsOf(signedIn);
    expect(secrets.oauth?.tokens?.access_token).toBe(ACCESS_TOKEN);
    expect(secrets.ownClient).toEqual({ client_id: "1234.5678", client_secret: "app-secret" });
    // The issuer the app was used with is kept next to it; its secret isn't copied there.
    expect(secrets.oauth?.client).toMatchObject({ client_id: "1234.5678", issuer: "https://mcp.slack.com" });
    expect(secrets.oauth?.client?.client_secret).toBeUndefined();

    // What makes a connection ready: its tools listed with the token.
    const tools = await listConnectionTools(signedIn);
    expect(tools.map((t) => t.name)).toEqual(["send_message"]);
    // Nothing tried to register, at any address.
    expect(seen.some((r) => r.method === "POST" && /regist/i.test(r.url))).toBe(false);
  });

  it("signs in as the instance's app for a catalog service when the connection has none of its own", async () => {
    process.env.CONNECTION_OAUTH_CLIENTS = "slack=instance.1:instance-secret";
    const row = rowOf(SLACK.mcp, {});
    expect(ownClientOf(row)).toEqual({ client: { client_id: "instance.1", client_secret: "instance-secret" }, fromInstance: true });
    const started = await startOAuth(row);
    expect(started!.url.searchParams.get("client_id")).toBe("instance.1");

    // An owner's own app comes first.
    expect(ownClientOf(rowOf(SLACK.mcp, { ownClient: { client_id: "own.1" } }))).toEqual({ client: { client_id: "own.1" }, fromInstance: false });
    // The instance's app goes only to that service's address.
    expect(ownClientOf(rowOf("https://slack.example.com/mcp", {}))).toBeNull();
    expect(ownClientOf({ ...rowOf(SLACK.mcp, {}), authType: "token" })).toBeNull();
  });

  it("fails without an app where the service takes no registrations, registering nothing", async () => {
    await expect(startOAuth(rowOf(SLACK.mcp, {}))).rejects.toThrow(/dynamic client registration/i);
    expect(seen.some((r) => r.method === "POST")).toBe(false);
  });

  it("keeps the owner's app when the service throws its credentials away", async () => {
    const own = { client_id: "1234.5678", client_secret: "app-secret" };
    const provider = new ConnectionOAuthProvider("conn-1", { ownClient: own, oauth: { tokens: { access_token: "x", token_type: "Bearer" } } }, null, own);
    await provider.invalidateCredentials("all");
    expect(secretsOf({ secrets: savedSecrets })).toEqual({ ownClient: own, oauth: {} });
    expect(provider.clientInformation()).toEqual(own);
  });
});

describe("signing in to Google", () => {
  it("signs in every Google service as the instance's one app, asking for the entry's scopes and a refresh token", async () => {
    process.env.CONNECTION_OAUTH_CLIENTS = "google=123-abc.apps.googleusercontent.com:GOCSPX-secret";
    service = GOOGLE;
    const row = rowOf(GOOGLE.mcp, {});

    const started = await startOAuth(row);
    const authorize = started!.url;
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("client_id")).toBe("123-abc.apps.googleusercontent.com");
    // The catalog's scopes, not every one the server lists (all of Drive).
    const scope = authorize.searchParams.get("scope")!;
    expect(scope).toBe(catalogEntryFor(GOOGLE.mcp)!.scope);
    expect(scope.split(" ")).not.toContain("https://www.googleapis.com/auth/drive");
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.get("resource")).toBe(GOOGLE.mcp);

    await finishOAuth(reread(row), started!.verifier, "the-code", undefined);
    expect(secretsOf(reread(row)).oauth?.tokens?.refresh_token).toBe("xoxe-refresh");

    // The same app for Google's other services; a service's own app still goes under its id.
    const gmail = ownClientOf(rowOf("https://gmailmcp.googleapis.com/mcp/v1", {}));
    expect(gmail).toEqual({ client: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-secret" }, fromInstance: true });
    expect(ownClientOf(rowOf(SLACK.mcp, {}))).toBeNull();
  });
});

describe("signing in with Leafdesk's client metadata document", () => {
  const CIMD = {
    mcp: "https://api.voice.example/v1/mcp",
    metadata: {
      issuer: "https://api.voice.example",
      authorization_endpoint: "https://voice.example/oauth/authorize",
      token_endpoint: "https://api.voice.example/v1/oauth/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    },
  };

  it("gives the document's address as its client ID, from an https address", async () => {
    process.env.APP_URL = "https://desk.example.com";
    service = CIMD;
    const row = rowOf(CIMD.mcp, {});
    const started = await startOAuth(row);
    expect(started!.url.searchParams.get("client_id")).toBe("https://desk.example.com/api/connections/oauth/client");
    expect(oauthClientMetadataUrl()).toBe("https://desk.example.com/api/connections/oauth/client");
    expect(seen.some((r) => r.method === "POST")).toBe(false);

    await finishOAuth(reread(row), started!.verifier, "the-code", undefined);
    const form = new URLSearchParams(seen.find((r) => r.url === CIMD.metadata.token_endpoint)!.body);
    expect(form.get("client_id")).toBe("https://desk.example.com/api/connections/oauth/client");
    expect(form.has("client_secret")).toBe(false);
    expect(secretsOf(reread(row)).oauth?.tokens?.access_token).toBe(ACCESS_TOKEN);
  });

  it("can't from a plain http address, which the service couldn't fetch", async () => {
    service = CIMD;
    await expect(startOAuth(rowOf(CIMD.mcp, {}))).rejects.toThrow(/dynamic client registration/i);
  });

  it("isn't offered where the service takes registrations", () => {
    process.env.APP_URL = "https://desk.example.com";
    const discovery = (metadata: Record<string, unknown>) => ({
      oauth: { discovery: { authorizationServerUrl: "https://as.example", authorizationServerMetadata: metadata as never } },
    });
    const registers = new ConnectionOAuthProvider("conn-1", discovery({ ...CIMD.metadata, registration_endpoint: "https://as.example/register" }));
    expect(registers.clientMetadataUrl).toBeUndefined();
    const takesDocuments = new ConnectionOAuthProvider("conn-1", discovery(CIMD.metadata));
    expect(takesDocuments.clientMetadataUrl).toBe("https://desk.example.com/api/connections/oauth/client");
  });
});
