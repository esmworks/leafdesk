import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OAuth app an owner registered with a service, as connections keep it: sealed with the
 * connection, shown only by its client ID, kept when signing out, and never taken to a new address
 * unless entered again. The database holds one connection row.
 */
process.env.BETTER_AUTH_SECRET = "test-auth-secret-that-is-long-enough-for-tests";

type Row = import("./client").ConnectionRow;
let current: Row | null = null;

function select() {
  const node: Record<string, unknown> = {};
  node.from = () => node;
  node.where = () => Object.assign(Promise.resolve([]), node);
  node.limit = async () => (current ? [current] : []);
  return node;
}
const update = () => ({
  set: (values: Partial<Row>) => ({
    where: () => {
      current = { ...current!, ...values };
      return { returning: async () => [current] };
    },
  }),
});
const insert = () => ({
  values: (values: Partial<Row>) => ({
    returning: async () => {
      current = {
        id: "conn-1",
        icon: null,
        status: "needsAuth",
        statusError: null,
        tools: [],
        kinds: {},
        toolsAt: null,
        createdAt: new Date(),
        ...values,
      } as Row;
      return [current];
    },
  }),
});
/** The conditions deletes were made with. */
const deletedWhere: unknown[] = [];
const remove = () => ({
  where: (condition: unknown) => {
    deletedWhere.push(condition);
    return Object.assign(Promise.resolve(), { returning: async () => [] });
  },
});
const tx = { select, update, insert, delete: remove };

vi.mock("@/db", () => ({ db: { ...tx, transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/access", async () => {
  const actual = await vi.importActual<typeof import("@/server/access")>("@/server/access");
  return { ...actual, requireMembership: vi.fn(async () => undefined) };
});
const startOAuth = vi.fn();
vi.mock("./client", async () => ({ ...(await vi.importActual<typeof import("./client")>("./client")), startOAuth: (...args: unknown[]) => startOAuth(...args) }));

const { beginConnectionOAuth, completeConnectionOAuth, createConnection, signOutConnection, updateConnection } = await import("./manage");
const { oauthRedirectUrl, secretsOf } = await import("./client");
const { RegistrationRejectedError } = await import("@modelcontextprotocol/client");

const SLACK = "https://mcp.slack.com/mcp";
const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code ?? "other");

async function addSlack() {
  return createConnection("owner", "ws", { name: "Slack", url: SLACK, authType: "oauth", oauthClient: { clientId: " 1234.5678 ", clientSecret: "app-secret" } });
}

beforeEach(() => {
  current = null;
  delete process.env.CONNECTION_OAUTH_CLIENTS;
  startOAuth.mockReset();
});

describe("finishing a sign-in", () => {
  it("takes the waiting sign-in only for the person who began it, so another's request leaves it", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    deletedWhere.length = 0;
    expect(await codeOf(completeConnectionOAuth("intruder", { state: "state-1", code: "c" }))).toBe("oauthFailed");
    const { sql, params } = new PgDialect().sqlToQuery(deletedWhere[0] as never);
    expect(sql).toContain('"state" = $1');
    expect(sql).toContain('"user_id" = $2');
    expect(params).toEqual(["state-1", "intruder"]);
  });
});

describe("a connection's own OAuth app", () => {
  it("is sealed with the connection and shown only by its client ID", async () => {
    const view = await addSlack();
    expect(view.oauthClient).toEqual({ clientId: "1234.5678", hasSecret: true, fromInstance: false });
    expect(JSON.stringify(view)).not.toContain("app-secret");
    expect(current!.secrets).not.toContain("app-secret");
    expect(secretsOf(current!).ownClient).toEqual({ client_id: "1234.5678", client_secret: "app-secret" });
  });

  it("takes an app without a secret, but not a client ID that isn't one", async () => {
    const view = await createConnection("owner", "ws", { name: "Discord", url: "https://mcp.discord.com/mcp", authType: "oauth", oauthClient: { clientId: "998877" } });
    expect(view.oauthClient).toEqual({ clientId: "998877", hasSecret: false, fromInstance: false });
    expect(await codeOf(createConnection("owner", "ws", { name: "S", url: SLACK, authType: "oauth", oauthClient: { clientId: "has space" } }))).toBe("invalidClient");
    expect(await codeOf(createConnection("owner", "ws", { name: "S", url: SLACK, authType: "oauth", oauthClient: { clientId: "" } }))).toBe("invalidClient");
  });

  it("shows the instance's app for a catalog service, and a token connection none", async () => {
    process.env.CONNECTION_OAUTH_CLIENTS = "slack=instance.1:instance-secret";
    expect((await createConnection("owner", "ws", { name: "Slack", url: SLACK, authType: "oauth" })).oauthClient).toEqual({
      clientId: "instance.1",
      hasSecret: true,
      fromInstance: true,
    });
    expect((await createConnection("owner", "ws", { name: "Slack", url: SLACK, authType: "token", token: "xoxp-1" })).oauthClient).toBeNull();
  });

  it("stays when signing out, which forgets only what the service gave", async () => {
    await addSlack();
    current = { ...current!, secrets: (await import("../secret-box")).sealJson({ ...secretsOf(current!), oauth: { tokens: { access_token: "t", token_type: "Bearer" } } }) };
    const view = await signOutConnection("owner", "conn-1");
    expect(view.status).toBe("needsAuth");
    expect(secretsOf(current!)).toEqual({ ownClient: { client_id: "1234.5678", client_secret: "app-secret" } });
  });

  it("keeps its secret when the same client ID comes back with the secret left empty", async () => {
    await addSlack();
    const view = await updateConnection("owner", "conn-1", { oauthClient: { clientId: "1234.5678", clientSecret: "" } });
    expect(view.oauthClient?.hasSecret).toBe(true);
    expect(secretsOf(current!).ownClient).toEqual({ client_id: "1234.5678", client_secret: "app-secret" });
    // Another app doesn't inherit it.
    await updateConnection("owner", "conn-1", { oauthClient: { clientId: "9999.0000" } });
    expect(secretsOf(current!).ownClient).toEqual({ client_id: "9999.0000" });
  });

  it("isn't taken to a new address unless entered again, and then without the old secret", async () => {
    await addSlack();
    expect(await codeOf(updateConnection("owner", "conn-1", { url: "https://mcp.other.example/mcp" }))).toBe("clientForNewUrl");
    expect(current!.url).toBe(SLACK);
    await updateConnection("owner", "conn-1", { url: "https://mcp.other.example/mcp", oauthClient: { clientId: "1234.5678", clientSecret: "" } });
    expect(secretsOf(current!).ownClient).toEqual({ client_id: "1234.5678" });
  });

  it("is forgotten when set to null, or when the connection stops signing in with OAuth", async () => {
    await addSlack();
    const view = await updateConnection("owner", "conn-1", { oauthClient: null });
    expect(view.oauthClient).toBeNull();
    expect(secretsOf(current!)).toEqual({});
    await addSlack();
    await updateConnection("owner", "conn-1", { authType: "token", token: "xoxp-1" });
    expect(secretsOf(current!)).toEqual({ token: "xoxp-1" });
  });

  it("is asked for when the service won't let Leafdesk register itself", async () => {
    await createConnection("owner", "ws", { name: "Slack", url: SLACK, authType: "oauth" });
    startOAuth.mockRejectedValue(new Error("Incompatible auth server: does not support dynamic client registration"));
    expect(await codeOf(beginConnectionOAuth("owner", "conn-1"))).toBe("needsClient");
    // With an app set, the same failure is the app's (or the service's) to explain.
    await updateConnection("owner", "conn-1", { oauthClient: { clientId: "1234.5678", clientSecret: "s" } });
    expect(await codeOf(beginConnectionOAuth("owner", "conn-1"))).toBe("oauthFailed");
  });

  it("says why when the service turns Leafdesk's registration down", async () => {
    const reject = (status: number, body: string) => startOAuth.mockRejectedValue(new RegistrationRejectedError({ status, body, submittedMetadata: { redirect_uris: [] } }));
    const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; params?: Record<string, string> }) => ({ code: error.code, params: error.params }));
    await createConnection("owner", "ws", { name: "Server", url: "https://mcp.example.com/mcp", authType: "oauth" });

    reject(400, JSON.stringify({ error: "invalid_redirect_uri", error_description: "Not allowed: https://work.example/cb" }));
    expect(await errorOf(beginConnectionOAuth("owner", "conn-1"))).toEqual({ code: "redirectRejected", params: { address: oauthRedirectUrl() } });

    reject(400, JSON.stringify({ error: "invalid_client_metadata", error_description: " Scopes not allowed " }));
    expect(await errorOf(beginConnectionOAuth("owner", "conn-1"))).toEqual({ code: "registrationRejected", params: { reason: "Scopes not allowed" } });

    reject(503, "<html>Service unavailable</html>");
    expect(await errorOf(beginConnectionOAuth("owner", "conn-1"))).toEqual({ code: "registrationRejected", params: { reason: "HTTP 503" } });

    // With an app set, Leafdesk doesn't register itself: whatever failed is the app's to explain.
    await updateConnection("owner", "conn-1", { oauthClient: { clientId: "1234.5678" } });
    expect(await codeOf(beginConnectionOAuth("owner", "conn-1"))).toBe("oauthFailed");
  });
});
