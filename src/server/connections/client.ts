import { randomBytes } from "node:crypto";
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type CallToolResult,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type Tool,
} from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connection } from "@/db/schema";
import { CONNECTION_CALL_TIMEOUT_MS, MAX_CONNECTION_TOOLS, type ConnectionTool, type ToolKind } from "@/lib/connections";
import { env } from "@/lib/env";
import { openJson, sealJson } from "../secret-box";
import { connectionFetch } from "./fetch";

/**
 * Leafdesk as an MCP client of a connection's server: one client per connection and process,
 * made on first use (two asking at once share it), closed after IDLE_MS unused or when the
 * connection changes. Calls to a connection's server and its sign-in run one at a time per
 * connection, so two runs can't both refresh a token that may be used only once.
 */

export type ConnectionRow = typeof connection.$inferSelect;

/** What a connection keeps sealed: a token, or what its OAuth sign-in found and was given. */
export type ConnectionSecrets = {
  token?: string;
  oauth?: {
    client?: StoredOAuthClientInformation;
    tokens?: StoredOAuthTokens;
    discovery?: OAuthDiscoveryState;
  };
};

export class ConnectionClientError extends Error {
  constructor(
    readonly code: "unauthorized" | "unreachable" | "notMcp" | "timeout" | "tool",
    message: string,
  ) {
    super(message);
  }
}

const IDLE_MS = 5 * 60_000;
const MAX_CLIENTS = 100;
const CONNECT_TIMEOUT_MS = 15_000;

export const oauthRedirectUrl = () => `${env.appUrl}/api/connections/oauth/callback`;

export function secretsOf(row: Pick<ConnectionRow, "secrets">): ConnectionSecrets {
  if (!row.secrets) return {};
  return openJson<ConnectionSecrets>(row.secrets);
}

async function saveSecrets(connectionId: string, secrets: ConnectionSecrets) {
  await db.update(connection).set({ secrets: sealJson(secrets) }).where(eq(connection.id, connectionId));
}

// --------------------------------------------------------------------------------- OAuth

/**
 * Leafdesk's side of a connection's OAuth sign-in, keeping what the service gives in the
 * connection's sealed secrets. Leafdesk registers itself with the service's authorization server
 * (dynamic client registration) and uses PKCE; `start` is a sign-in an owner begins in the
 * browser, `finish` its return, `use` everything else (refreshing tokens as they run out).
 */
export class ConnectionOAuthProvider implements OAuthClientProvider {
  /** Where the browser should go, once auth() asked to redirect. */
  authorizationUrl: URL | null = null;
  private stateValue: string | null = null;
  private verifier: string | null;

  constructor(
    private readonly connectionId: string,
    private secrets: ConnectionSecrets,
    verifier: string | null = null,
  ) {
    this.verifier = verifier;
  }

  get redirectUrl() {
    return oauthRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Leafdesk",
      client_uri: env.appUrl,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    this.stateValue ??= randomBytes(24).toString("base64url");
    return this.stateValue;
  }

  /** The state of the sign-in begun (after auth() asked to redirect). */
  get startedState() {
    return this.stateValue;
  }

  get codeVerifierValue() {
    return this.verifier;
  }

  clientInformation() {
    return this.secrets.oauth?.client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation) {
    this.secrets = { ...this.secrets, oauth: { ...this.secrets.oauth, client } };
    await saveSecrets(this.connectionId, this.secrets);
  }

  tokens() {
    return this.secrets.oauth?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    this.secrets = { ...this.secrets, oauth: { ...this.secrets.oauth, tokens } };
    await saveSecrets(this.connectionId, this.secrets);
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new ConnectionClientError("unauthorized", "No sign-in is under way");
    return this.verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.secrets = { ...this.secrets, oauth: { ...this.secrets.oauth, discovery } };
    await saveSecrets(this.connectionId, this.secrets);
  }

  discoveryState() {
    return this.secrets.oauth?.discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const oauth = { ...this.secrets.oauth };
    if (scope === "all" || scope === "client") delete oauth.client;
    if (scope === "all" || scope === "tokens") delete oauth.tokens;
    if (scope === "all" || scope === "discovery") delete oauth.discovery;
    if (scope === "all" || scope === "verifier") this.verifier = null;
    this.secrets = { ...this.secrets, oauth };
    await saveSecrets(this.connectionId, this.secrets);
  }
}

/** Begins an OAuth sign-in to a connection's service: the address to send the browser to, or null when already signed in. */
export async function startOAuth(row: ConnectionRow) {
  const provider = new ConnectionOAuthProvider(row.id, secretsOf(row));
  const result = await serialized(row.id, () => auth(provider, { serverUrl: row.url, fetchFn: connectionFetch }));
  if (result === "AUTHORIZED") return null;
  if (!provider.authorizationUrl || !provider.startedState || !provider.codeVerifierValue) {
    throw new ConnectionClientError("unauthorized", "The service didn't start a sign-in");
  }
  return { url: provider.authorizationUrl, state: provider.startedState, verifier: provider.codeVerifierValue };
}

/** Finishes an OAuth sign-in with the code the service sent back. */
export async function finishOAuth(row: ConnectionRow, verifier: string, code: string, iss: string | undefined) {
  const provider = new ConnectionOAuthProvider(row.id, secretsOf(row), verifier);
  const result = await serialized(row.id, () => auth(provider, { serverUrl: row.url, authorizationCode: code, iss, fetchFn: connectionFetch }));
  if (result !== "AUTHORIZED") throw new ConnectionClientError("unauthorized", "The service didn't accept the sign-in");
  dropClient(row.id);
}

// ---------------------------------------------------------------------------------- pool

type Entry = { client: Promise<Client>; usedAt: number; key: string };
type Pool = { entries: Map<string, Entry>; queues: Map<string, Promise<unknown>>; timer?: NodeJS.Timeout };
const g = globalThis as typeof globalThis & { __leafdeskConnectionPool?: Pool };
const pool: Pool = (g.__leafdeskConnectionPool ??= { entries: new Map(), queues: new Map() });

/** Runs `fn` after whatever runs on the same connection (one call at a time per connection). */
function serialized<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const before = pool.queues.get(connectionId) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(fn);
  pool.queues.set(connectionId, next);
  void next.finally(() => {
    if (pool.queues.get(connectionId) === next) pool.queues.delete(connectionId);
  }).catch(() => undefined);
  return next;
}

/** What makes a pooled client stale: the server, how it signs in, or the token changed. */
function keyOf(row: ConnectionRow) {
  return `${row.url}|${row.authType}|${row.authType === "token" ? row.secrets ?? "" : ""}`;
}

function authProviderOf(row: ConnectionRow): AuthProvider | OAuthClientProvider | undefined {
  if (row.authType === "none") return undefined;
  if (row.authType === "token") {
    const token = secretsOf(row).token;
    return { token: async () => token };
  }
  return new ConnectionOAuthProvider(row.id, secretsOf(row));
}

async function connect(row: ConnectionRow): Promise<Client> {
  const client = new Client({ name: "Leafdesk", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(row.url), { authProvider: authProviderOf(row), fetch: connectionFetch });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw classify(error);
  }
  return client;
}

/** Maps what the SDK or the network threw to a ConnectionClientError. */
export function classify(error: unknown): ConnectionClientError {
  if (error instanceof ConnectionClientError) return error;
  const name = (error as { name?: string })?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number; code?: number | string })?.status;
  if (name === "UnauthorizedError" || status === 401 || /unauthori[sz]ed|401|invalid_token/i.test(message)) {
    return new ConnectionClientError("unauthorized", message);
  }
  if (/timed? ?out|timeout/i.test(message) || name === "TimeoutError") return new ConnectionClientError("timeout", message);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EBLOCKED|private address|blocked|redirect/i.test(message) || name === "ConnectionFetchError") {
    return new ConnectionClientError("unreachable", message);
  }
  return new ConnectionClientError("notMcp", message);
}

function sweepIdle() {
  const now = Date.now();
  for (const [id, entry] of pool.entries) {
    if (now - entry.usedAt > IDLE_MS) {
      pool.entries.delete(id);
      void entry.client.then((c) => c.close()).catch(() => undefined);
    }
  }
  if (!pool.entries.size && pool.timer) {
    clearInterval(pool.timer);
    pool.timer = undefined;
  }
}

function clientFor(row: ConnectionRow): Promise<Client> {
  const key = keyOf(row);
  const entry = pool.entries.get(row.id);
  if (entry && entry.key === key) {
    entry.usedAt = Date.now();
    return entry.client;
  }
  if (entry) dropClient(row.id);
  if (pool.entries.size >= MAX_CLIENTS) {
    const oldest = [...pool.entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (oldest) dropClient(oldest[0]);
  }
  const client = connect(row);
  pool.entries.set(row.id, { client, usedAt: Date.now(), key });
  // A failed connection isn't kept: the next use tries again.
  client.catch(() => {
    if (pool.entries.get(row.id)?.client === client) pool.entries.delete(row.id);
  });
  pool.timer ??= setInterval(sweepIdle, 60_000);
  pool.timer.unref?.();
  return client;
}

/** Closes a connection's pooled client (it changed, was signed out of or removed). */
export function dropClient(connectionId: string) {
  const entry = pool.entries.get(connectionId);
  if (!entry) return;
  pool.entries.delete(connectionId);
  void entry.client.then((c) => c.close()).catch(() => undefined);
}

/** Runs `fn` with the connection's client, one at a time; a failure drops the client for the next try. */
async function withClient<T>(row: ConnectionRow, fn: (client: Client) => Promise<T>): Promise<T> {
  return serialized(row.id, async () => {
    try {
      return await fn(await clientFor(row));
    } catch (error) {
      const failure = classify(error);
      if (failure.code !== "tool") dropClient(row.id);
      throw failure;
    }
  });
}

// ---------------------------------------------------------------------------------- tools

/** How the server marked a tool: read-only, or (no mark, or any other) writing. */
export function hintedKind(tool: Pick<Tool, "annotations">): ToolKind {
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

/** Lists a connection's tools (at most MAX_CONNECTION_TOOLS), classed, keeping owners' overrides. */
export async function listConnectionTools(row: ConnectionRow): Promise<ConnectionTool[]> {
  return withClient(row, async (client) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECTION_CALL_TIMEOUT_MS });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_CONNECTION_TOOLS);
    return tools.slice(0, MAX_CONNECTION_TOOLS).map((tool) => {
      const hinted = hintedKind(tool);
      return {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: (tool.description ?? "").slice(0, 2_000),
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        hinted,
        kind: row.kinds[tool.name] ?? hinted,
      };
    });
  });
}

/** Calls a connection's tool. Throws a ConnectionClientError when it can't be reached; a tool's own error comes back in the result. */
export async function callConnectionTool(row: ConnectionRow, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return withClient(row, (client) =>
    client.callTool({ name: tool, arguments: args }, { timeout: CONNECTION_CALL_TIMEOUT_MS, maxTotalTimeout: CONNECTION_CALL_TIMEOUT_MS, signal }),
  ) as Promise<CallToolResult>;
}
