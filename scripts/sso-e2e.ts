/**
 * End-to-end check of single sign-on against a running app, with a mock OpenID Connect provider
 * this script runs itself (no real identity provider involved): an owner sets up a workspace
 * connection (server actions), its domain is verified (DNS answered by a stub resolver; the real
 * lookup is checked to fail), "Continue with SSO" routes an email to it, the first sign-in creates
 * the account and joins the workspace, addresses outside its domains are refused, an existing
 * password account is linked, "SSO only" holds back members who signed in otherwise (pages,
 * exports, server actions, collab) but not the owner, two-step verification still asks for its
 * code after SSO and the session keeps counting as SSO, the instance-wide provider from OIDC_*
 * creates accounts, and removing the connection takes its provider with it.
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

const { and, eq, ilike, inArray, or } = await import("drizzle-orm");
const { db } = await import("@/db");
const { account, ssoProvider, user, workspace, workspaceMember, workspaceSso } = await import("@/db/schema");
const { saveSsoConnection, verifySsoDomains, SsoError } = await import("@/server/sso");
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

type Login = { email: string; name: string };
type Grant = Login & { tenant: string; clientId: string; redirectUri: string; nonce?: string; challenge?: string };

const TENANTS: Record<string, { clientId: string; clientSecret: string }> = {
  acme: { clientId: "leafdesk-acme", clientSecret: "acme-secret" },
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
      sub: subOf(grant.email),
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
    return send(res, 200, { sub: subOf(grant.email), email: grant.email, email_verified: true, name: grant.name });
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
  const gateNow = await open(`/sso-required/${workspaceId}`, member0.jar);
  check(gateNow.status === 200 && gateNow.text.includes("Continue with Mock IdP"), "…and the gate offers the instance provider instead", gateNow.status);

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
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
