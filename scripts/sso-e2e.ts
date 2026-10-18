/**
 * End-to-end check of single sign-on against a running app, with a mock OpenID Connect provider
 * this script runs itself (no real identity provider involved): an owner sets up a workspace
 * connection (server actions), its domain is verified (DNS answered by a stub resolver; the real
 * lookup is checked to fail) but not when the connection changes or another workspace verifies the
 * domain while DNS is asked, "Continue with SSO" routes an email to it, the first sign-in creates
 * the account and joins the workspace, addresses outside its domains are refused, an existing
 * password account is linked, "SSO only" holds back members who signed in otherwise (pages,
 * exports, server actions, collab) but not the owner, two-step verification still asks for its
 * code after SSO and the session keeps counting as SSO, the instance-wide provider from OIDC_*
 * creates accounts, and removing the connection takes its provider with it. Changing the identity
 * provider behind the connection, and removing it, revokes the API tokens and connected apps of
 * everyone who signed in through it, and of nobody else; a change that keeps the identity provider
 * revokes nothing. Someone who left or was removed stays out when a changed connection links them
 * again, unless an owner or their identity provider (SCIM) brings them back. A new connection does
 * the same to the sign-ins still on record under the workspace's provider id, so an id its identity
 * provider sends finds only the address it vouches for; migration 0085 did it once to those earlier
 * releases left (its SQL runs here). A change to the connection waits for an account deletion that
 * holds the workspace, rather than deadlocking with it and losing its audit entry.
 *
 * The app must run with the mock provider trusted and configured as the instance provider:
 *
 *   SSO_TRUSTED_ORIGINS=http://127.0.0.1:5199 OIDC_ISSUER=http://127.0.0.1:5199/instance \
 *   OIDC_CLIENT_ID=leafdesk-instance OIDC_CLIENT_SECRET=instance-secret OIDC_NAME="Mock IdP" \
 *   OIDC_DOMAINS=instance-sso.test PORT=5100 pnpm dev
 *
 *   APP_URL=http://localhost:5100 pnpm tsx scripts/sso-e2e.ts
 *
 * Env: APP_URL, DATABASE_URL (from .env), MOCK_IDP_PORT (default 5199; the OIDC_* values above
 * are assumed and set for this process too). Creates its own users and workspaces and deletes them.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { waitOutAuthRateLimits } from "./auth-rate-limit";

try {
  process.loadEnvFile();
} catch {}

const IDP_PORT = Number(process.env.MOCK_IDP_PORT ?? 5199);
const IDP = `http://127.0.0.1:${IDP_PORT}`;
// This process saves connections (discovery) and checks domains like the app does.
process.env.SSO_TRUSTED_ORIGINS ??= IDP;
process.env.OIDC_ISSUER ??= `${IDP}/instance`;
process.env.OIDC_CLIENT_ID ??= "leafdesk-instance";
process.env.OIDC_CLIENT_SECRET ??= "instance-secret";
process.env.OIDC_NAME ??= "Mock IdP";
process.env.OIDC_DOMAINS ??= "instance-sso.test";

const { and, desc, eq, ilike, inArray, like, or, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const {
  account,
  auditEvent,
  connectedAppUse,
  oauthClient,
  oauthConsent,
  session,
  ssoProvider,
  user,
  workspace,
  workspaceInvitation,
  workspaceMember,
  workspaceSso,
} = await import("@/db/schema");
const { saveSsoConnection, verifySsoDomains, SsoError } = await import("@/server/sso");
const { createApiToken } = await import("@/server/api/tokens");
const { AccessError } = await import("@/server/access");
const { domainRecordName } = await import("@/lib/sso-config");
const { totpCode, totpKeyFromUri } = await import("@/lib/totp");
const Y = await import("yjs");
const { HocuspocusProvider } = await import("@hocuspocus/provider");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
waitOutAuthRateLimits(BASE);
const RUN = Date.now().toString(36);
const PASSWORD = "sso-e2e-password-123";
const DOMAIN = `acme-${RUN}.test`;
const INSTANCE_DOMAIN = process.env.OIDC_DOMAINS!.split(",")[0].trim();

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

// ───────────────────────────────────────────────────────────────────────── mock OIDC provider

/** `sub`: the id the provider gives the person; one made from the address unless given. */
type Login = { email: string; name: string; sub?: string };
type Grant = Login & { tenant: string; clientId: string; redirectUri: string; nonce?: string; challenge?: string };

const TENANTS: Record<string, { clientId: string; clientSecret: string }> = {
  acme: { clientId: "leafdesk-acme", clientSecret: "acme-secret" },
  /** The identity provider the workspace moves its connection to. */
  acme2: { clientId: "leafdesk-acme2", clientSecret: "acme2-secret" },
  instance: { clientId: process.env.OIDC_CLIENT_ID!, clientSecret: process.env.OIDC_CLIENT_SECRET! },
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "mock-1", alg: "RS256", use: "sig" };
const codes = new Map<string, Grant>();
const accessTokens = new Map<string, Grant>();
/** Who the next authorization signs in as (the "user" at the identity provider). */
let nextLogin: Login | null = null;
const idpRequests: string[] = [];

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
/** The workspace tenant names its issuer with a trailing slash, as Authentik does; owners type it without. */
const issuerOf = (tenant: string) => (tenant === "acme" ? `${IDP}/acme/` : `${IDP}/${tenant}`);
const subOf = (email: string) => `sub-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;

function idToken(grant: Grant) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: issuerOf(grant.tenant),
      aud: grant.clientId,
      sub: grant.sub ?? subOf(grant.email),
      email: grant.email,
      email_verified: true,
      name: grant.name,
      iat: now,
      exp: now + 300,
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
    }),
  );
  const signature = rsaSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const idp = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", IDP);
  const [, tenant, ...rest] = url.pathname.split("/");
  const route = rest.join("/");
  const client = TENANTS[tenant];
  idpRequests.push(`${req.method} ${url.pathname}`);
  if (!client) return send(res, 404, { error: "unknown tenant" });
  const base = `${IDP}/${tenant}`;
  const issuer = issuerOf(tenant);
  if (route === ".well-known/openid-configuration") {
    return send(res, 200, {
      issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      userinfo_endpoint: `${base}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (route === "jwks") return send(res, 200, { keys: [jwk] });
  if (route === "authorize") {
    const q = url.searchParams;
    if (q.get("client_id") !== client.clientId) return send(res, 400, { error: "unauthorized_client" });
    const redirectUri = q.get("redirect_uri") ?? "";
    const login = nextLogin;
    const target = new URL(redirectUri);
    if (!login) {
      target.searchParams.set("error", "access_denied");
    } else {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        ...login,
        tenant,
        clientId: client.clientId,
        redirectUri,
        nonce: q.get("nonce") ?? undefined,
        challenge: q.get("code_challenge") ?? undefined,
      });
      target.searchParams.set("code", code);
    }
    const state = q.get("state");
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }
  if (route === "token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const [id, secret] = basic
      ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent)
      : [form.get("client_id"), form.get("client_secret")];
    if (id !== client.clientId || secret !== client.clientSecret) return send(res, 401, { error: "invalid_client" });
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    if (!grant || grant.clientId !== id || grant.redirectUri !== form.get("redirect_uri")) {
      return send(res, 400, { error: "invalid_grant" });
    }
    if (grant.challenge) {
      const verifier = form.get("code_verifier") ?? "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) return send(res, 400, { error: "invalid_grant" });
    }
    const accessToken = randomBytes(16).toString("hex");
    accessTokens.set(accessToken, grant);
    return send(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken(grant) });
  }
  if (route === "userinfo") {
    const grant = accessTokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    if (!grant) return send(res, 401, { error: "invalid_token" });
    return send(res, 200, { sub: grant.sub ?? subOf(grant.email), email: grant.email, email_verified: true, name: grant.name });
  }
  return send(res, 404, { error: "not found" });
});

// ───────────────────────────────────────────────────────────────────────────── browser helpers

/** The cookies of one browser. */
class Jar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1).trim();
      if (value && !/max-age=0/i.test(line)) this.cookies.set(pair.slice(0, eq).trim(), value);
      else this.cookies.delete(pair.slice(0, eq).trim());
    }
  }
  has(name: string) {
    return [...this.cookies.keys()].some((key) => key.endsWith(name));
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function authPost(path: string, body: unknown, jar: Jar) {
  const res = await fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
    body: JSON.stringify(body),
  });
  jar.store(res);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

type SessionBody = {
  user: { id: string; email: string; emailVerified?: boolean; twoFactorEnabled?: boolean };
  session: { authMethod?: string; ssoProviderId?: string | null };
};
async function sessionOf(jar: Jar) {
  const res = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: jar.header() } });
  return (await res.json().catch(() => null)) as SessionBody | null;
}

async function open(path: string, jar: Jar) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: jar.header(), accept: "text/html" }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: res.status === 200 ? await res.text() : "" };
}

/**
 * A single sign-on as a browser does it: start at /sign-in/sso, follow the provider's redirect
 * (the mock signs in as `login`), then open the app's callback. Returns where the app sent it.
 */
async function ssoSignIn(jar: Jar, body: Record<string, unknown>, login: Login | null) {
  nextLogin = login;
  const start = await authPost(
    "/sign-in/sso",
    { callbackURL: "/", errorCallbackURL: "/sign-in", ...body },
    jar,
  );
  if (start.status !== 200 || typeof start.body?.url !== "string") return { start, location: null as string | null, status: start.status };
  const atIdp = await fetch(start.body.url, { redirect: "manual" });
  const back = atIdp.headers.get("location");
  if (atIdp.status !== 302 || !back) return { start, location: null, status: atIdp.status };
  const callback = await fetch(back, { headers: { cookie: jar.header() }, redirect: "manual" });
  jar.store(callback);
  const location = callback.headers.get("location");
  return {
    start,
    status: callback.status,
    location: location ? new URL(location, BASE).pathname + new URL(location, BASE).search : null,
    /** Names of the cookies the callback set or cleared, for failure output. */
    cookies: callback.headers.getSetCookie().map((line) => line.split(";").slice(0, 1).concat(/max-age=0/i.test(line) ? ["cleared"] : []).join(" ").replace(/=.*? /, " ").replace(/=.*$/, "")),
  };
}

function actionId(file: string, name: string) {
  const root = process.env.NEXT_DIR ?? ".next";
  const manifests: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "server-reference-manifest.json") manifests.push(path);
    }
  };
  walk(join(root, "dev", "server"));
  walk(join(root, "server"));
  for (const manifest of manifests) {
    const { node = {} } = JSON.parse(readFileSync(manifest, "utf8")) as {
      node?: Record<string, { exportedName?: string; filename?: string }>;
    };
    for (const [id, entry] of Object.entries(node)) if (entry.filename === file && entry.exportedName === name) return id;
  }
  throw new Error(`No id for ${file}#${name} under ${root}: open a page that uses it first`);
}

async function callAction(jar: Jar, path: string, file: string, name: string, args: unknown[]) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId(file, name),
      origin: BASE,
      cookie: jar.header(),
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

const connections: InstanceType<typeof HocuspocusProvider>[] = [];
async function connect(jar: Jar, name: string) {
  const tokenRes = await fetch(`${BASE}/api/collab-token`, { headers: { cookie: jar.header() } });
  const { token, build } = (await tokenRes.json()) as { token: string; build?: string | null };
  let settle: (outcome: "synced" | "refused") => void = () => {};
  const settled = new Promise<"synced" | "refused">((resolve) => (settle = resolve));
  const provider = new HocuspocusProvider({
    // A production server refuses a tab that names no build (lib/build-id); this one runs the server's.
    url: `${BASE.replace(/^http/, "ws")}/collab${build ? `?build=${encodeURIComponent(build)}` : ""}`,
    name,
    document: new Y.Doc(),
    token,
    onSynced: () => settle("synced"),
    onAuthenticationFailed: () => settle("refused"),
  });
  connections.push(provider);
  return Promise.race([settled, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
}

async function codeFor(key: Uint8Array) {
  if (Date.now() % 30_000 > 27_000) await new Promise((r) => setTimeout(r, 3_500));
  return totpCode(key);
}

const userIds: string[] = [];
const workspaceIds: string[] = [];

async function signUp(who: string, email = `sso-${who}-${RUN}@example.test`) {
  const jar = new Jar();
  const res = await authPost("/sign-up/email", { name: `SSO ${who}`, email, password: PASSWORD }, jar);
  check(res.status === 200, `sign up ${who} with a password`, res.body);
  const id = (await sessionOf(jar))!.user.id;
  userIds.push(id);
  const [personal] = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, id));
  if (personal) workspaceIds.push(personal.id);
  return { jar, id, email, workspaceId: personal?.id };
}

const roleOf = async (workspaceId: string, userId: string) =>
  (
    await db
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
  )[0]?.role ?? null;

// ──────────────────────────────────────────────────────────── API tokens and connected apps

const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33420/callback";
const APP_SCOPES = "openid offline_access pages:read";
const clientIds: string[] = [];

/** One step of the authorization in a browser: where it goes next (Better Auth answers fetch with JSON redirects). */
async function nextStep(jar: Jar, url: string) {
  const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(), accept: "text/html" } });
  jar.store(res);
  if (res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await res.json()) as { url?: string };
    return body.url ? new URL(body.url, BASE).toString() : null;
  }
  const location = res.headers.get("location");
  return location ? new URL(location, BASE).toString() : null;
}

/** What the consent page posts back: only the signed parameters. */
function signedQuery(pageUrl: string) {
  const params = new URL(pageUrl, BASE).searchParams;
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
}

type App = { clientId: string; tokenEndpoint: string; accessToken: string; refreshToken: string };

/** Connects an MCP client as the person signed in in `jar`: registers it, consents, exchanges the code. */
async function connectApp(jar: Jar, label: string): Promise<App> {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json();
  const registered = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `SSO e2e ${label} ${RUN}`,
      application_type: "native",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: APP_SCOPES,
    }),
  });
  const client = (await registered.json()) as { client_id?: string };
  check(registered.ok && client.client_id, `${label} connects an MCP client`, client);
  clientIds.push(client.client_id);
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(as.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: APP_SCOPES,
    state: RUN,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  const consentPage = await nextStep(jar, authorize.toString());
  check(consentPage && new URL(consentPage).pathname === "/oauth/consent", `…reaching its consent page`, consentPage);
  const consent = await authPost("/oauth2/consent", { accept: true, oauth_query: signedQuery(consentPage) }, jar);
  const code = typeof consent.body?.url === "string" ? new URL(consent.body.url).searchParams.get("code") : null;
  check(consent.status === 200 && code, "…allowing it", consent.body);
  const exchanged = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  const tokens = (await exchanged.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
  check(exchanged.ok && tokens?.access_token && tokens.refresh_token, "…which gets its tokens", tokens);
  return { clientId: client.client_id, tokenEndpoint: as.token_endpoint, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** The status /mcp answers the app's access token with. */
async function mcpStatus(app: App) {
  const res = await fetch(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${app.accessToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await res.text();
  return res.status;
}

/** Whether the app's refresh token still works; a working one is used up and replaced. */
async function refreshes(app: App) {
  const res = await fetch(app.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.refreshToken, client_id: app.clientId, resource: RESOURCE }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
  if (!res.ok || !body?.access_token) return false;
  app.accessToken = body.access_token;
  if (body.refresh_token) app.refreshToken = body.refresh_token;
  return true;
}

/** What a person reaches the app with besides a session: an API token and a connected app. */
type Access = { token: string; app: App };
async function giveAccess(userId: string, jar: Jar, label: string): Promise<Access> {
  const { secret } = await createApiToken(userId, { name: `SSO e2e ${label}`, scopes: ["pages:read"] });
  return { token: secret, app: await connectApp(jar, label) };
}

/** The status the API answers the token with, the one /mcp answers the app with, and whether it refreshes. */
async function accessNow(access: Access) {
  const api = await fetch(`${BASE}/api/v1/me`, { headers: { authorization: `Bearer ${access.token}` } });
  await api.text();
  return { api: api.status, mcp: await mcpStatus(access.app), refreshes: await refreshes(access.app) };
}
const works = (now: Awaited<ReturnType<typeof accessNow>>) => now.api === 200 && now.mcp === 200 && now.refreshes;
const cutOff = (now: Awaited<ReturnType<typeof accessNow>>) => now.api === 401 && now.mcp === 401 && !now.refreshes;

/** Whether a query on the database waits for a lock within a few seconds. */
async function waitingForLock() {
  for (let i = 0; i < 100; i++) {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if (row.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** The details of the workspace's latest audit event with this action. */
const lastAudit = async (workspaceId: string, action: string) =>
  (
    await db
      .select({ details: auditEvent.details })
      .from(auditEvent)
      .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.createdAt))
      .limit(1)
  )[0]?.details ?? null;

async function main() {
  await new Promise<void>((resolve) => idp.listen(IDP_PORT, "127.0.0.1", resolve));
  const shared = await fetch(`${BASE}/api/auth/sso/callback?code=x&state=y`, { redirect: "manual" });
  check(shared.status === 404, "the plugin's shared callback is off", shared.status);
  const management = await authPost("/sso/register", { providerId: "x", issuer: IDP, domain: DOMAIN }, new Jar());
  check(management.status === 404, "…and so is its own provider management", management.status);

  // ── Setting up a connection ──────────────────────────────────────────────────────────────
  const owner = await signUp("owner");
  const workspaceId = owner.workspaceId!;
  const providerId = `ws-${workspaceId}`;
  const settingsPath = `/w/${workspaceId}/settings`;
  const SSO_ACTIONS = "src/app/actions/sso.ts";
  const settings = await open(`${settingsPath}?tab=security`, owner.jar);
  check(
    settings.status === 200 && settings.text.includes("Single sign-on (SSO)") && settings.text.includes(`/api/auth/sso/callback/${providerId}`),
    "the owner's security settings show the SSO box with the redirect URI",
    settings.status,
  );
  check(settings.text.includes(`/scim/v2`), "…and the SCIM base URL");

  const badIssuer = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/nobody`, clientId: "x", clientSecret: "y", domains: DOMAIN },
  ]);
  check(badIssuer.text.includes('"error":"discoveryFailed"'), "an issuer without a discovery document is refused", badIssuer.text);
  const publicDomain = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/acme`, clientId: "leafdesk-acme", clientSecret: "acme-secret", domains: "gmail.com" },
  ]);
  check(publicDomain.text.includes('"error":"invalidDomain"'), "a public mail domain can't be claimed", publicDomain.text);
  const saved = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/acme`, clientId: "leafdesk-acme", clientSecret: "acme-secret", domains: DOMAIN },
  ]);
  check(saved.status === 200 && saved.text.includes('"ok":true') && saved.text.includes('"verified":false'), "the owner saves an OIDC connection", saved.text);
  check(!saved.text.includes("acme-secret"), "…whose secret never comes back to the browser");
  check(saved.text.includes(domainRecordName(DOMAIN)), "…and gets the DNS record to add");

  const unverified = await authPost("/sign-in/sso", { email: `alice@${DOMAIN}`, callbackURL: "/" }, new Jar());
  check(unverified.status === 404 && unverified.body?.code === "SSO_NOT_FOUND", "an unverified connection signs nobody in by email", unverified.body);
  const unverifiedById = await ssoSignIn(new Jar(), { providerId }, { email: `alice@${DOMAIN}`, name: "Alice" });
  check(unverifiedById.status !== 302 || !unverifiedById.location?.startsWith("/w/"), "…nor by provider id", unverifiedById);

  const realDns = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "verifySsoDomainsAction", [workspaceId]);
  check(realDns.text.includes('"error":"dnsMismatch"'), "verifying without the TXT record fails", realDns.text);

  const member0 = await signUp("bystander");
  await db.insert(workspaceMember).values({ workspaceId, userId: member0.id, role: "member" });
  const byMember = await saveSsoConnection(member0.id, workspaceId, {
    protocol: "oidc",
    issuer: `${IDP}/acme`,
    clientId: "x",
    clientSecret: "y",
    domains: DOMAIN,
  }).catch((e: unknown) => e);
  check(byMember instanceof AccessError, "members can't change the connection", String(byMember));

  // ── Verifying while the connection changes ───────────────────────────────────────────────
  // The TXT lookups take as long as the domains' DNS servers like, and an owner's own DNS answers
  // as slowly as they want. Only what the records proved gets verified: not other domains saved
  // meanwhile (an owner could claim anyone's and sign in as the people there), nor the same ones
  // behind another identity provider, nor a domain another workspace verified in the meantime.
  const tokenOf = async (id: string) =>
    (await db.select({ token: workspaceSso.verificationToken }).from(workspaceSso).where(eq(workspaceSso.workspaceId, id)))[0].token;
  const providerOf = async (id: string) =>
    (await db.select({ domain: ssoProvider.domain, verified: ssoProvider.domainVerified }).from(ssoProvider).where(eq(ssoProvider.providerId, `ws-${id}`)))[0];
  const recordFor = (domain: string, token: string) => async (name: string) => (name === domainRecordName(domain) ? [[`leafdesk-sso=${token}`]] : []);
  const acmeOidc = { protocol: "oidc" as const, issuer: `${IDP}/acme`, clientId: "leafdesk-acme", clientSecret: "acme-secret" };
  const VICTIM = `victim-${RUN}.test`;

  const firstToken = await tokenOf(workspaceId);
  const swapped = await verifySsoDomains(owner.id, workspaceId, async (name) => {
    await saveSsoConnection(owner.id, workspaceId, { ...acmeOidc, domains: VICTIM });
    return recordFor(DOMAIN, firstToken)(name);
  }).catch((e: unknown) => e);
  check(swapped instanceof SsoError && swapped.code === "connectionChanged", "domains saved while the old ones are looked up aren't verified", String(swapped));
  const afterSwap = await providerOf(workspaceId);
  check(afterSwap.domain === VICTIM && afterSwap.verified !== true, "…the connection keeps them unverified", afterSwap);
  check((await lastAudit(workspaceId, "sso.domains_verified")) === null, "…the audit log records no verification");
  const victimRouted = await authPost("/sign-in/sso", { email: `someone@${VICTIM}`, callbackURL: "/" }, new Jar());
  check(victimRouted.status === 404 && victimRouted.body?.code === "SSO_NOT_FOUND", "…and nobody at them is sent to it", victimRouted.body);

  await saveSsoConnection(owner.id, workspaceId, { ...acmeOidc, domains: DOMAIN });
  const keptToken = await tokenOf(workspaceId);
  const idpSwapped = await verifySsoDomains(owner.id, workspaceId, async (name) => {
    await saveSsoConnection(owner.id, workspaceId, { protocol: "oidc", issuer: `${IDP}/acme2`, clientId: "leafdesk-acme2", clientSecret: "acme2-secret", domains: DOMAIN });
    return recordFor(DOMAIN, keptToken)(name);
  }).catch((e: unknown) => e);
  check(idpSwapped instanceof SsoError && idpSwapped.code === "connectionChanged", "nor are the same domains moved to another identity provider meanwhile", String(idpSwapped));
  check((await tokenOf(workspaceId)) === keptToken && (await providerOf(workspaceId)).verified !== true, "…though their record didn't change", await providerOf(workspaceId));
  await saveSsoConnection(owner.id, workspaceId, { ...acmeOidc, domains: DOMAIN });

  const rival = await signUp("rival");
  const RACE = `race-${RUN}.test`;
  await saveSsoConnection(member0.id, member0.workspaceId!, { ...acmeOidc, domains: RACE });
  await saveSsoConnection(rival.id, rival.workspaceId!, { ...acmeOidc, domains: `eu.${RACE}` });
  const raced = await verifySsoDomains(member0.id, member0.workspaceId!, async (name) => {
    await verifySsoDomains(rival.id, rival.workspaceId!, recordFor(`eu.${RACE}`, await tokenOf(rival.workspaceId!)));
    return recordFor(RACE, await tokenOf(member0.workspaceId!))(name);
  }).catch((e: unknown) => e);
  check((await providerOf(rival.workspaceId!)).verified === true, "another workspace verifies a subdomain while a domain is looked up");
  check(raced instanceof SsoError && raced.code === "domainTaken" && raced.detail === RACE, "…so the domain is refused once its record is found", String(raced));
  check((await providerOf(member0.workspaceId!)).verified !== true, "…and stays unverified");

  const [row] = await db.select({ token: workspaceSso.verificationToken }).from(workspaceSso).where(eq(workspaceSso.workspaceId, workspaceId));
  const wrongRecord = await verifySsoDomains(owner.id, workspaceId, async () => [["leafdesk-sso=wrong"]]).catch((e: unknown) => e);
  check(wrongRecord instanceof SsoError && wrongRecord.code === "dnsMismatch", "a TXT record with another value doesn't verify", String(wrongRecord));
  const verified = await verifySsoDomains(owner.id, workspaceId, async (name) =>
    name === domainRecordName(DOMAIN) ? [[`leafdesk-sso=`, row.token]] : [],
  );
  check(verified?.verified === true, "the right TXT record verifies the domain (split TXT strings joined)", verified);

  const instanceDomain = await saveSsoConnection(member0.id, member0.workspaceId!, {
    protocol: "oidc",
    issuer: `${IDP}/acme`,
    clientId: "leafdesk-acme",
    clientSecret: "acme-secret",
    domains: `eu.${DOMAIN}`,
  });
  const taken = await verifySsoDomains(member0.id, member0.workspaceId!, async () => [[`leafdesk-sso=${row.token}`]]).catch((e: unknown) => e);
  check(taken instanceof SsoError && taken.code === "domainTaken", "another workspace can't verify a domain already in use", String(taken));
  check(instanceDomain?.verified === false, "…and its connection stays unverified");

  // ── Signing in ───────────────────────────────────────────────────────────────────────────
  const alice = new Jar();
  const aliceIn = await ssoSignIn(alice, { email: `Alice@${DOMAIN}`, callbackURL: `/w/${workspaceId}` }, { email: `alice@${DOMAIN}`, name: "Alice Doe" });
  check(aliceIn.start.status === 200 && aliceIn.start.body.url.startsWith(`${IDP}/acme/authorize`), "Continue with SSO sends the email's domain to its provider", aliceIn.start.body);
  check(aliceIn.status === 302 && aliceIn.location === `/w/${workspaceId}`, "the first sign-in comes back signed in", aliceIn);
  const aliceSession = await sessionOf(alice);
  check(aliceSession?.user.email === `alice@${DOMAIN}` && aliceSession.user.emailVerified === true, "…with a new account, its address verified", aliceSession?.user);
  check(aliceSession.session.authMethod === "sso" && aliceSession.session.ssoProviderId === providerId, "…and a session marked as this workspace's single sign-on", aliceSession.session);
  userIds.push(aliceSession.user.id);
  check((await roleOf(workspaceId, aliceSession.user.id)) === "member", "…who joined the workspace as a member");
  const aliceWorkspaces = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, aliceSession.user.id));
  check(aliceWorkspaces.length === 1, "…without a personal workspace of their own", aliceWorkspaces);
  const aliceHome = await open(`/w/${workspaceId}`, alice);
  check(aliceHome.status === 200, "…and opens it", aliceHome.status);

  const aliceAgain = await ssoSignIn(new Jar(), { email: `alice@${DOMAIN}` }, { email: `alice@${DOMAIN}`, name: "Alice Doe" });
  const againSession = aliceAgain.location === "/" ? await sessionOf(alice) : null;
  check(aliceAgain.status === 302 && againSession?.user.id === aliceSession.user.id, "signing in again finds the same account", aliceAgain);

  // An API token and a connected app each, for someone who signed in through the connection and a
  // member who never did (before "SSO only" holds the latter back from making them).
  const aliceAccess = await giveAccess(aliceSession.user.id, alice, "Alice");
  const bystanderAccess = await giveAccess(member0.id, member0.jar, "A member signed in with a password");
  check(works(await accessNow(aliceAccess)) && works(await accessNow(bystanderAccess)), "both reach the API and /mcp");

  const outside = await authPost("/sign-in/sso", { email: `mallory@other-${RUN}.test`, callbackURL: "/" }, new Jar());
  check(outside.status === 404 && outside.body?.code === "SSO_NOT_FOUND", "an email outside every connection's domains gets no provider", outside.body);
  const foreign = await ssoSignIn(new Jar(), { providerId }, { email: `mallory@other-${RUN}.test`, name: "Mallory" });
  check(
    foreign.status === 302 && foreign.location?.startsWith("/sign-in?error="),
    "the provider vouching for an address outside its domains is refused",
    foreign,
  );
  const mallory = await db.select({ id: user.id }).from(user).where(eq(user.email, `mallory@other-${RUN}.test`));
  check(mallory.length === 0, "…and no account is created for it", mallory);

  // An existing password account in the domain, its address never verified, is claimed: the
  // provider just proved who owns the address, so whoever set that password loses it.
  const carol = await signUp("carol", `carol@${DOMAIN}`);
  const carolSso = new Jar();
  const carolIn = await ssoSignIn(carolSso, { email: `carol@${DOMAIN}`, callbackURL: `/w/${workspaceId}` }, { email: `carol@${DOMAIN}`, name: "Carol" });
  const carolSession = await sessionOf(carolSso);
  check(carolIn.status === 302 && carolSession?.user.id === carol.id, "an existing account in the domain is linked and signed in", { carolIn, carolSession });
  check((await roleOf(workspaceId, carol.id)) === "member", "…and joins the workspace");
  const links = await db.select({ provider: account.providerId }).from(account).where(eq(account.userId, carol.id));
  check(links.some((l) => l.provider === providerId) && !links.some((l) => l.provider === "credential"), "…and, its address unverified, the earlier password goes", links);
  check((await sessionOf(carol.jar)) === null, "…with the sessions from before");

  // Joining happens on the first sign-in through the connection only: someone an owner removed stays out.
  const frank = new Jar();
  await ssoSignIn(frank, { email: `frank@${DOMAIN}` }, { email: `frank@${DOMAIN}`, name: "Frank" });
  const frankId = (await sessionOf(frank))!.user.id;
  userIds.push(frankId);
  check((await roleOf(workspaceId, frankId)) === "member", "another person joins through SSO");
  const removedFrank = await callAction(owner.jar, settingsPath, "src/app/actions/workspaces.ts", "removeMemberAction", [workspaceId, frankId]);
  check(removedFrank.status === 200 && (await roleOf(workspaceId, frankId)) === null, "…the owner removes them", removedFrank.status);
  const frankAgain = await ssoSignIn(new Jar(), { email: `frank@${DOMAIN}` }, { email: `frank@${DOMAIN}`, name: "Frank" });
  check(frankAgain.status === 302 && (await roleOf(workspaceId, frankId)) === null, "…and signing in again doesn't bring them back", frankAgain);
  // Nor someone who left.
  const gwen = new Jar();
  await ssoSignIn(gwen, { email: `gwen@${DOMAIN}` }, { email: `gwen@${DOMAIN}`, name: "Gwen" });
  const gwenId = (await sessionOf(gwen))!.user.id;
  userIds.push(gwenId);
  const gwenLeft = await callAction(gwen, settingsPath, "src/app/actions/workspaces.ts", "removeMemberAction", [workspaceId, gwenId]);
  check(gwenLeft.status === 200 && (await roleOf(workspaceId, gwenId)) === null, "a member who joined through SSO leaves", gwenLeft.status);

  // ── SSO only ─────────────────────────────────────────────────────────────────────────────
  const PAGES_ACTIONS = "src/app/actions/pages.ts";
  const created = await callAction(owner.jar, settingsPath, PAGES_ACTIONS, "createPageAction", [{ workspaceId, title: "Roadmap" }]);
  const pageId = /"id":"([\w-]+)"/.exec(created.text)?.[1];
  check(created.status === 200 && pageId, "the owner creates a page", created.status);
  const turnedOn = await callAction(owner.jar, settingsPath, "src/app/actions/workspaces.ts", "updateWorkspaceSettingsAction", [
    workspaceId,
    { loginMethod: "sso" },
  ]);
  check(turnedOn.text.includes('"ok":true'), "the owner turns on SSO only", turnedOn.text);

  const ownerHome = await open(`/w/${workspaceId}`, owner.jar);
  check(ownerHome.status === 200, "the owner, signed in with a password, still gets in", ownerHome);
  const gated = await open(`/w/${workspaceId}`, member0.jar);
  check(gated.status === 307 && gated.location?.endsWith(`/sso-required/${workspaceId}`), "a member signed in with a password is sent to single sign-on", gated);
  const gate = await open(`/sso-required/${workspaceId}`, member0.jar);
  check(gate.status === 200 && gate.text.includes("requires single sign-on"), "…whose page explains why", gate.status);
  const csv = await fetch(`${BASE}/w/${workspaceId}/settings/members.csv`, { headers: { cookie: member0.jar.header() } });
  check(csv.status === 403 && (await csv.text()).includes("Single sign-on required"), "…exports refuse them", csv.status);
  const tree = await callAction(member0.jar, settingsPath, PAGES_ACTIONS, "getSidebarAction", [workspaceId]);
  check(tree.status === 500 && !tree.text.includes("Roadmap"), "…and so do server actions", tree.status);
  check((await connect(member0.jar, `page:${pageId}`)) === "refused", "…and the collab websocket");
  const passwordGate = await open(`/two-step/${workspaceId}`, member0.jar);
  check(passwordGate.status === 307 && passwordGate.location?.endsWith(`/sso-required/${workspaceId}`), "the two-step page sends them on to the right gate", passwordGate);
  check((await open(`/w/${workspaceId}`, carolSso)).status === 200, "a member signed in with SSO gets in");
  check((await connect(carolSso, `page:${pageId}`)) === "synced", "…and edits live");
  const bystanderHome = await open(`/w/${member0.workspaceId}`, member0.jar);
  check(bystanderHome.status === 200, "their other workspaces are unaffected", bystanderHome.status);

  // ── Two-step verification after single sign-on ──────────────────────────────────────────
  const dave = new Jar();
  const daveIn = await ssoSignIn(dave, { email: `dave@${DOMAIN}` }, { email: `dave@${DOMAIN}`, name: "Dave" });
  const daveSession = await sessionOf(dave);
  check(daveIn.status === 302 && daveSession, "another member signs in with SSO", daveIn);
  userIds.push(daveSession.user.id);
  const enable = await authPost("/two-factor/enable", {}, dave);
  check(enable.status === 200 && enable.body?.totpURI, "…and, having no password, turns on an authenticator app", enable.body);
  const key = totpKeyFromUri(enable.body.totpURI);
  const on = await authPost("/two-factor/verify-totp", { code: await codeFor(key) }, dave);
  check(on.status === 200, "…with its first code", on.body);
  const daveAgain = new Jar();
  const held = await ssoSignIn(daveAgain, { email: `dave@${DOMAIN}`, callbackURL: `/w/${workspaceId}` }, { email: `dave@${DOMAIN}`, name: "Dave" });
  check(
    held.status === 302 && held.location?.startsWith("/sign-in?step=two-factor") && held.location.includes(encodeURIComponent(`/w/${workspaceId}`)),
    "the next single sign-on asks for the code, keeping where it was headed",
    held,
  );
  check((await sessionOf(daveAgain)) === null && daveAgain.has("leafdesk.sso_pending"), "…with no session yet, the provider remembered for the code step");
  const coded = await authPost("/two-factor/verify-totp", { code: await codeFor(key) }, daveAgain);
  const codedSession = await sessionOf(daveAgain);
  check(coded.status === 200 && codedSession?.session.authMethod === "totp", "the code signs in", coded.body);
  check(codedSession.session.ssoProviderId === providerId, "…and the session still counts as the single sign-on", codedSession.session);
  check((await open(`/w/${workspaceId}`, daveAgain)).status === 200, "…so SSO only lets it in");

  // ── The instance provider ────────────────────────────────────────────────────────────────
  const erinEmail = `erin-${RUN}@${INSTANCE_DOMAIN}`;
  const erin = new Jar();
  const erinIn = await ssoSignIn(erin, { providerId: "oidc", callbackURL: "/" }, { email: erinEmail, name: "Erin" });
  check(erinIn.start.status === 200 && erinIn.start.body.url.startsWith(`${IDP}/instance/authorize`), "the instance button goes to OIDC_ISSUER", erinIn.start.body);
  const erinSession = await sessionOf(erin);
  check(erinIn.status === 302 && erinSession?.user.email === erinEmail, "…and creates the account", erinIn);
  userIds.push(erinSession.user.id);
  check(erinSession.session.ssoProviderId === "oidc", "…with a session marked as the instance's", erinSession.session);
  const erinWorkspaces = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, erinSession.user.id));
  check(erinWorkspaces.length === 1, "…and a personal workspace, like any new account", erinWorkspaces);
  workspaceIds.push(...erinWorkspaces.map((w) => w.id));
  const routed = await authPost("/sign-in/sso", { email: `someone-${RUN}@${INSTANCE_DOMAIN}`, callbackURL: "/" }, new Jar());
  check(routed.status === 200 && String(routed.body?.url).startsWith(`${IDP}/instance/authorize`), "Continue with SSO routes OIDC_DOMAINS to it", routed.body);
  const signInPage = await open("/sign-in", new Jar());
  check(signInPage.text.includes("Continue with Mock IdP") && signInPage.text.includes("Continue with SSO"), "the sign-in page offers both buttons");

  // ── Changing the identity provider ───────────────────────────────────────────────────────
  // Another client secret for the same issuer is the same identity provider: nothing is revoked.
  const rotated = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/acme`, clientId: "leafdesk-acme", clientSecret: "acme-rotated", domains: DOMAIN },
  ]);
  check(rotated.text.includes('"ok":true') && rotated.text.includes('"verified":true'), "the owner changes the client secret", rotated.text);
  const afterRotation = await accessNow(aliceAccess);
  check(works(afterRotation), "…and the API token and connected app of whoever signed in through it keep working", afterRotation);
  check((await sessionOf(alice))?.user.id === aliceSession.user.id, "…as does their session");
  check(!(await lastAudit(workspaceId, "sso.configured"))?.revokedApiTokens, "…and the audit log records nothing revoked", await lastAudit(workspaceId, "sso.configured"));

  // Another issuer could vouch for anyone's id at the provider: whatever those people set up while
  // signed in through the connection is cut off with their sessions.
  const moved = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/acme2`, clientId: "leafdesk-acme2", clientSecret: "acme2-secret", domains: DOMAIN },
  ]);
  check(moved.text.includes('"ok":true') && moved.text.includes('"verified":false'), "the owner moves the connection to another identity provider", moved.text);
  check((await sessionOf(alice)) === null, "…which ends the sessions signed in through it");
  const afterMove = await accessNow(aliceAccess);
  check(cutOff(afterMove), "…revokes the API tokens and connected apps of the people who signed in through it", afterMove);
  const bystanderAfterMove = await accessNow(bystanderAccess);
  check(works(bystanderAfterMove), "…but not those of a member who never did", bystanderAfterMove);
  const movedAudit = await lastAudit(workspaceId, "sso.configured");
  check(movedAudit?.revokedApiTokens === 1 && movedAudit.revokedConnectedApps === 1, "…and records how many in the audit log", movedAudit);

  await verifySsoDomains(owner.id, workspaceId, async (name) => (name === domainRecordName(DOMAIN) ? [[`leafdesk-sso=${row.token}`]] : []));
  const aliceBack = await ssoSignIn(alice, { email: `alice@${DOMAIN}`, callbackURL: `/w/${workspaceId}` }, { email: `alice@${DOMAIN}`, name: "Alice Doe" });
  check(aliceBack.start.body?.url?.startsWith(`${IDP}/acme2/authorize`), "once verified again, Continue with SSO goes to the new provider", aliceBack.start.body);
  check(aliceBack.status === 302 && (await sessionOf(alice))?.user.id === aliceSession.user.id, "…and links the same account by its address", aliceBack);
  const aliceAccessAgain = await giveAccess(aliceSession.user.id, alice, "Alice, signed in again");

  // ── Coming back after the connection changed ─────────────────────────────────────────────
  // The move forgot everyone's sign-in through the connection, so each person's next one is their
  // first through it again. That brings in nobody who was in the workspace and is out now: an
  // owner removed them, or they left. Their identity provider (over SCIM) and an owner do.
  const linksOf = async (userId: string) =>
    (await db.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, providerId)))).length;
  check((await linksOf(frankId)) === 0, "the move forgot the sign-ins of people no longer in the workspace too");
  const frankAfterMove = await ssoSignIn(new Jar(), { email: `frank@${DOMAIN}` }, { email: `frank@${DOMAIN}`, name: "Frank" });
  check(frankAfterMove.status === 302 && (await linksOf(frankId)) === 1, "someone the owner removed signs in through the new identity provider", frankAfterMove);
  check((await roleOf(workspaceId, frankId)) === null, "…which links them again but doesn't bring them back");
  const gwenAfterMove = await ssoSignIn(new Jar(), { email: `gwen@${DOMAIN}` }, { email: `gwen@${DOMAIN}`, name: "Gwen" });
  check(gwenAfterMove.status === 302 && (await linksOf(gwenId)) === 1 && (await roleOf(workspaceId, gwenId)) === null, "…nor someone who left", gwenAfterMove);

  const MEMBER_ACTIONS = "src/app/actions/workspaces.ts";
  const gwenAdded = await callAction(owner.jar, settingsPath, MEMBER_ACTIONS, "addMembersAction", [workspaceId, [`gwen@${DOMAIN}`], "member"]);
  check(gwenAdded.text.includes('"kind":"added"') && (await roleOf(workspaceId, gwenId)) === "member", "an owner adding them again brings them back", gwenAdded.text);
  const scimCreated = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "createScimTokenAction", [workspaceId, "SSO e2e"]);
  const scimToken = /"data":"(scim_[A-Za-z0-9]{40})"/.exec(scimCreated.text)?.[1];
  check(scimToken, "the owner creates a SCIM token", scimCreated.text);
  const provisioned = await fetch(`${BASE}/scim/v2/Users`, {
    method: "POST",
    headers: { authorization: `Bearer ${scimToken}`, "content-type": "application/scim+json" },
    body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `frank@${DOMAIN}`, active: true }),
  });
  await provisioned.text();
  check(provisioned.status === 201 && (await roleOf(workspaceId, frankId)) === "member", "…and so does their identity provider over SCIM", provisioned.status);

  // An invitation for the address of someone the owner removed lets their first sign-in through
  // the connection bring them back: their account's address was never verified, so adding them
  // again invited them, and the sign-in proves the address.
  const grace = await signUp("grace", `grace@${DOMAIN}`);
  await db.insert(workspaceMember).values({ workspaceId, userId: grace.id, role: "member" });
  const graceRemoved = await callAction(owner.jar, settingsPath, MEMBER_ACTIONS, "removeMemberAction", [workspaceId, grace.id]);
  check(graceRemoved.status === 200 && (await roleOf(workspaceId, grace.id)) === null, "the owner removes a member who signed up with a password", graceRemoved.status);
  const graceInvited = await callAction(owner.jar, settingsPath, MEMBER_ACTIONS, "addMembersAction", [workspaceId, [`grace@${DOMAIN}`], "member"]);
  check(graceInvited.text.includes('"kind":"invited"'), "…and, their address unverified, invites them again", graceInvited.text);
  const graceIn = await ssoSignIn(new Jar(), { email: `grace@${DOMAIN}` }, { email: `grace@${DOMAIN}`, name: "Grace" });
  const graceInvitations = await db
    .select({ id: workspaceInvitation.id })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, `grace@${DOMAIN}`)));
  check(
    graceIn.status === 302 && (await roleOf(workspaceId, grace.id)) === "member" && graceInvitations.length === 0,
    "…so their first single sign-on brings them back, using up the invitation",
    { graceIn, graceInvitations },
  );

  // ── Removing the connection ──────────────────────────────────────────────────────────────
  const removed = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "removeSsoConnectionAction", [workspaceId]);
  check(removed.text.includes('"ok":true'), "the owner removes the connection", removed.text);
  const leftover = await db.select({ id: ssoProvider.id }).from(ssoProvider).where(eq(ssoProvider.providerId, providerId));
  check(leftover.length === 0, "…and its provider goes with it", leftover);
  const afterRemoval = await open(`/w/${workspaceId}`, alice);
  check(
    afterRemoval.status === 307 && afterRemoval.location?.startsWith("/sign-in") && (await sessionOf(alice)) === null,
    "sessions signed in through the removed connection end",
    afterRemoval,
  );
  const afterRemove = await accessNow(aliceAccessAgain);
  check(cutOff(afterRemove), "…as do the API tokens and connected apps of the people who signed in through it", afterRemove);
  const bystanderAfterRemove = await accessNow(bystanderAccess);
  check(works(bystanderAfterRemove), "…but not those of a member who never did", bystanderAfterRemove);
  const removedAudit = await lastAudit(workspaceId, "sso.removed");
  check(removedAudit?.revokedApiTokens === 1 && removedAudit.revokedConnectedApps === 1, "…and the audit log records how many", removedAudit);
  const gateNow = await open(`/sso-required/${workspaceId}`, member0.jar);
  check(gateNow.status === 200 && gateNow.text.includes("Continue with Mock IdP"), "…and the gate offers the instance provider instead", gateNow.status);

  // ── A new connection ─────────────────────────────────────────────────────────────────────
  // The workspace's next connection gets the same provider id. A sign-in still on record under it
  // (as older versions left them when a workspace's connection went some other way, and a backup can
  // bring the id back): Alice's, with her id at the old identity provider and a session it signed
  // in, and an API token and a connected app of hers.
  const aliceId = aliceSession.user.id;
  const at = new Date();
  const staleId = `sso-e2e-${RUN}-stale`;
  await db.insert(account).values({ id: staleId, accountId: subOf(`alice@${DOMAIN}`), providerId, userId: aliceId, createdAt: at, updatedAt: at });
  await db.insert(session).values({
    id: staleId,
    token: randomBytes(16).toString("hex"),
    userId: aliceId,
    expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000),
    createdAt: at,
    updatedAt: at,
    authMethod: "sso",
    ssoProviderId: providerId,
  });
  await db.insert(oauthConsent).values({ id: staleId, clientId: aliceAccessAgain.app.clientId, userId: aliceId, scopes: APP_SCOPES.split(" "), createdAt: at, updatedAt: at });
  const { secret: aliceLaterToken } = await createApiToken(aliceId, { name: "SSO e2e Alice, after the connection went", scopes: ["pages:read"] });
  const recreated = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "saveSsoConnectionAction", [
    workspaceId,
    { protocol: "oidc", issuer: `${IDP}/acme2`, clientId: "leafdesk-acme2", clientSecret: "acme2-secret", domains: DOMAIN },
  ]);
  check(recreated.text.includes('"ok":true'), "the owner sets up a connection again", recreated.text);
  const stale = await db.select({ id: account.id }).from(account).where(eq(account.providerId, providerId));
  check(stale.length === 0, "…which forgets the sign-ins still on record under its provider id", stale);
  const staleSessions = await db.select({ id: session.id }).from(session).where(eq(session.ssoProviderId, providerId));
  check(staleSessions.length === 0, "…ending the sessions they signed in", staleSessions);
  const laterApi = await fetch(`${BASE}/api/v1/me`, { headers: { authorization: `Bearer ${aliceLaterToken}` } });
  await laterApi.text();
  const aliceConsents = await db.select({ clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, aliceId));
  check(
    laterApi.status === 401 && aliceConsents.length === 0,
    "…and revokes the API tokens and connected apps of the people they were for",
    { api: laterApi.status, aliceConsents },
  );
  const recreatedAudit = await lastAudit(workspaceId, "sso.configured");
  check(
    recreatedAudit?.created === true && recreatedAudit.revokedApiTokens === 1 && recreatedAudit.revokedConnectedApps === 1,
    "…recording how many in the audit log",
    recreatedAudit,
  );

  const [renewed] = await db.select({ token: workspaceSso.verificationToken }).from(workspaceSso).where(eq(workspaceSso.workspaceId, workspaceId));
  await verifySsoDomains(owner.id, workspaceId, async (name) => (name === domainRecordName(DOMAIN) ? [[`leafdesk-sso=${renewed.token}`]] : []));
  // Its identity provider gives someone of the domain the id Alice had at the old one.
  const oscar = new Jar();
  const oscarIn = await ssoSignIn(oscar, { email: `oscar@${DOMAIN}` }, { email: `oscar@${DOMAIN}`, name: "Oscar", sub: subOf(`alice@${DOMAIN}`) });
  const oscarSession = await sessionOf(oscar);
  if (oscarSession) userIds.push(oscarSession.user.id);
  check(
    oscarIn.status === 302 && oscarSession?.user.email === `oscar@${DOMAIN}` && oscarSession.user.id !== aliceId,
    "an id the new identity provider sends signs in the address it vouches for, not whoever had that id before",
    { oscarIn, user: oscarSession?.user },
  );

  // ── Sign-ins left by earlier releases (migration 0085) ───────────────────────────────────
  // Before the cut-off above, a connection set up again kept the sign-ins through the earlier one,
  // and a connection lost with the account of the owner who set it up kept everyone's. The
  // migration forgets those once, as removing a connection does; its own SQL runs here, twice.
  const [connection] = await db.select({ createdAt: workspaceSso.createdAt }).from(workspaceSso).where(eq(workspaceSso.workspaceId, workspaceId));
  const earlier = new Date(connection.createdAt.getTime() - 60 * 60 * 1000);
  const seedSignIn = async (userId: string, provider: string, linkedAt: Date | null, signedInAt: Date | null) => {
    const id = `sso-e2e-${RUN}-${randomBytes(4).toString("hex")}`;
    if (linkedAt) await db.insert(account).values({ id, accountId: `sub-${id}`, providerId: provider, userId, createdAt: linkedAt, updatedAt: linkedAt });
    if (signedInAt) {
      await db.insert(session).values({
        id,
        token: randomBytes(16).toString("hex"),
        userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: signedInAt,
        updatedAt: signedInAt,
        authMethod: "sso",
        ssoProviderId: provider,
      });
    }
  };
  const signInsOf = async (userId: string, provider: string) => ({
    links: (await db.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, provider)))).length,
    sessions: (await db.select({ id: session.id }).from(session).where(and(eq(session.userId, userId), eq(session.ssoProviderId, provider)))).length,
  });
  const apiStatus = async (token: string) => {
    const res = await fetch(`${BASE}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    await res.text();
    return res.status;
  };
  // Peggy: linked through the earlier connection, and signed in through that link since.
  const peggy = await signUp("peggy");
  await seedSignIn(peggy.id, providerId, earlier, new Date());
  const peggyAccess = await giveAccess(peggy.id, peggy.jar, "Peggy");
  await db.insert(connectedAppUse).values({ workspaceId: peggy.workspaceId!, userId: peggy.id, appKind: "connected_app", appId: peggyAccess.app.clientId, lastUsedAt: new Date() });
  // Sid: a session through the earlier connection, without a link.
  const sid = await signUp("sid");
  await seedSignIn(sid.id, providerId, null, earlier);
  const { secret: sidToken } = await createApiToken(sid.id, { name: "SSO e2e Sid", scopes: ["pages:read"] });
  // Ivy: a link and a session under a workspace whose connection is gone, its "SSO only" kept.
  const ivy = await signUp("ivy");
  const goneProvider = `ws-${ivy.workspaceId}`;
  await seedSignIn(ivy.id, goneProvider, earlier, new Date());
  const { secret: ivyToken } = await createApiToken(ivy.id, { name: "SSO e2e Ivy", scopes: ["pages:read"] });
  const [ivyWs] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, ivy.workspaceId!));
  await db.update(workspace).set({ settings: { ...ivyWs.settings, loginMethod: "sso" } }).where(eq(workspace.id, ivy.workspaceId!));
  // Oscar signed in through the connection as it is.
  const oscarId = oscarSession!.user.id;
  const oscarAccess = await giveAccess(oscarId, oscar, "Oscar");

  const migration = readFileSync(join("drizzle", "0085_forget_leftover_sso_sign_ins.sql"), "utf8");
  const migrate = async () => {
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
  };
  await migrate();

  const peggyNow = await signInsOf(peggy.id, providerId);
  check(
    peggyNow.links === 0 && peggyNow.sessions === 0,
    "migration 0085 forgets a sign-in older than the workspace's connection, and a later session signed in through it",
    peggyNow,
  );
  const peggyAfter = await accessNow(peggyAccess);
  const peggyUse = await db.select({ appId: connectedAppUse.appId }).from(connectedAppUse).where(eq(connectedAppUse.userId, peggy.id));
  check(cutOff(peggyAfter) && peggyUse.length === 0, "…revoking that person's API tokens and connected apps, and forgetting when they were used", {
    peggyAfter,
    peggyUse,
  });
  const sidNow = await signInsOf(sid.id, providerId);
  const sidApi = await apiStatus(sidToken);
  check(sidNow.sessions === 0 && sidApi === 401, "…ends a session older than the connection, revoking its person's API tokens", { sidNow, sidApi });
  const ivyNow = await signInsOf(ivy.id, goneProvider);
  const ivyApi = await apiStatus(ivyToken);
  check(ivyNow.links === 0 && ivyNow.sessions === 0 && ivyApi === 401, "…forgets the sign-ins under a connection that is gone, revoking those too", {
    ivyNow,
    ivyApi,
  });
  const [ivyWsNow] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, ivy.workspaceId!));
  check(ivyWsNow.settings.loginMethod === "sso", "…and leaves that workspace's login method to its owners", ivyWsNow.settings);
  const oscarNow = await signInsOf(oscarId, providerId);
  const oscarAfter = await accessNow(oscarAccess);
  check(
    oscarNow.links === 1 && oscarNow.sessions > 0 && works(oscarAfter),
    "…but keeps a sign-in through the connection as it is, with what it reaches the app with",
    { oscarNow, oscarAfter },
  );
  const onRecord = async () => ({
    links: (await db.select({ id: account.id }).from(account).where(like(account.providerId, "ws-%"))).length,
    sessions: (await db.select({ id: session.id }).from(session).where(like(session.ssoProviderId, "ws-%"))).length,
    oscar: await signInsOf(oscarId, providerId),
  });
  const beforeAgain = await onRecord();
  await migrate();
  const afterAgain = await onRecord();
  check(
    JSON.stringify(afterAgain) === JSON.stringify(beforeAgain) && works(await accessNow(oscarAccess)),
    "running it again changes nothing",
    { beforeAgain, afterAgain },
  );

  // ── Lock order ───────────────────────────────────────────────────────────────────────────
  // Deleting an account locks its workspaces, then hands over the connections it set up (the
  // provider's row). A change to the connection meanwhile waits for the workspace before it writes
  // the provider's row. In the other order the two deadlocked, and PostgreSQL cancelled the change's
  // audit entry, which went missing without a trace.
  const configured = async () =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditEvent)
        .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "sso.configured")))
    )[0].n;
  const configuredBefore = await configured();
  let locked!: () => void;
  let handOver!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const handingOver = new Promise<void>((resolve) => (handOver = resolve));
  const deletion = db.transaction(async (tx) => {
    await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    locked();
    await handingOver;
    await tx.update(ssoProvider).set({ userId: owner.id }).where(eq(ssoProvider.providerId, providerId));
  });
  await isLocked;
  const settled = Promise.allSettled([
    deletion,
    saveSsoConnection(owner.id, workspaceId, { protocol: "oidc", issuer: `${IDP}/acme2`, clientId: "leafdesk-acme2", clientSecret: "", domains: DOMAIN }),
  ]);
  const saveWaits = await waitingForLock();
  handOver();
  const outcomes = (await settled).map((o) => o.status);
  const configuredAfter = await configured();
  check(
    saveWaits && outcomes.every((o) => o === "fulfilled") && configuredAfter === configuredBefore + 1,
    "a change to the connection while an account deletion holds the workspace waits for it, and keeps its audit entry",
    { saveWaits, outcomes, configuredBefore, configuredAfter },
  );

  check(idpRequests.some((r) => r.endsWith("/acme/token")) && idpRequests.some((r) => r.endsWith("/acme/jwks")), "the app used the provider's token and key endpoints");
  console.log(`\n${passed} checks passed`);
}

try {
  await main();
} finally {
  for (const provider of connections) provider.destroy();
  idp.close();
  const byRun = await db
    .select({ id: user.id })
    .from(user)
    .where(or(ilike(user.email, `%@${DOMAIN}`), ilike(user.email, `%-${RUN}@%`), ilike(user.email, `%@other-${RUN}.test`)));
  const ids = [...new Set([...userIds, ...byRun.map((u) => u.id)])];
  const owned = ids.length
    ? await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(and(inArray(workspaceMember.userId, ids), eq(workspaceMember.role, "owner")))
    : [];
  const wsIds = [...new Set([...workspaceIds, ...owned.map((w) => w.id)])];
  if (wsIds.length) await db.delete(workspace).where(inArray(workspace.id, wsIds));
  if (ids.length) await db.delete(user).where(inArray(user.id, ids));
  if (clientIds.length) await db.delete(oauthClient).where(inArray(oauthClient.clientId, clientIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
