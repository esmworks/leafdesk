/**
 * End-to-end check of the ways around the workspaces' sign-in policies and the account checks
 * that keep one person from taking another's place, against a running app:
 *
 * - an Authorization header alone doesn't take a held-back browser session out of the policy
 *   (files, the print view), while a real API token still is;
 * - a held-back session can't make what would reach its workspaces outside the policy: an API
 *   token for that workspace or for all of them, or an app connected over OAuth (consent page and
 *   consent endpoint);
 * - the reset link emailed to an address takes over an account someone else had signed up for
 *   with it, unproven, without what they set up: passkeys, two-step verification, API tokens,
 *   connected apps, sessions (an account with a verified address keeps its own);
 * - pointing a workspace's SSO connection at another identity provider, or removing it, forgets
 *   who was linked through it and signs them out, so the new provider can't sign in as them.
 *
 * Creates its own @example.test users and workspaces and deletes them afterwards.
 *
 * Server actions are called the way the browser calls them, by id; the ids come from the running
 * app's build output (`.next`, or NEXT_DIR), so run this from the checkout the app runs from.
 *
 *   APP_URL=http://localhost:3302 pnpm tsx scripts/security-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from
 * .env when present). Migrations must be applied.
 */
export {};

const appUrl = process.env.APP_URL;
try {
  process.loadEnvFile();
} catch {}

const { createHash, randomBytes } = await import("node:crypto");
const { existsSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { account, apiToken, file, oauthClient, oauthConsent, passkey, session, twoFactor, user, verification, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const files = await import("@/server/files");
const { createApiToken } = await import("@/server/api/tokens");
const { removeSsoConnection, saveSsoConnection } = await import("@/server/sso");
const { workspaceProviderId } = await import("@/lib/sso-config");

const BASE = (appUrl ?? "http://localhost:3000").replace(/\/$/, "");
const RUN = `sec-${Date.now().toString(36)}`;

// The real collab service: pages made here get their documents.
const { hocuspocus, service } = createCollab();
registerCollab(service);

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

// ---------------------------------------------------------------------------- browser

/** The cookies of one browser, starting from a session made in the database. */
class Jar {
  private cookies = new Map<string, string>();
  constructor(cookie: string) {
    const eq = cookie.indexOf("=");
    this.cookies.set(cookie.slice(0, eq), cookie.slice(eq + 1));
  }
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1).trim();
      if (value && !/max-age=0/i.test(line)) this.cookies.set(pair.slice(0, eq).trim(), value);
      else this.cookies.delete(pair.slice(0, eq).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** A password sign-in made in the database: it passes no two-step policy. */
async function signedIn(userId: string) {
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session-${randomBytes(4).toString("hex")}`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return new Jar(`better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`);
}

const get = (path: string, jar?: Jar, extra: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { headers: { accept: "text/html", "accept-language": "en", ...(jar ? { cookie: jar.header() } : {}), ...extra }, redirect: "manual" });

/** The server action's id, from the manifests of the running server (the page using it must have compiled). */
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
    const { node = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { node?: Record<string, { exportedName?: string; filename?: string }> };
    for (const [id, entry] of Object.entries(node)) if (entry.filename === file && entry.exportedName === name) return id;
  }
  throw new Error(`No id for ${file}#${name} under ${root}: open a page that uses it first`);
}

async function callAction(jar: Jar, path: string, file: string, name: string, args: unknown[], extra: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId(file, name),
      origin: BASE,
      cookie: jar.header(),
      ...extra,
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("x-action-redirect"), text: await res.text() };
}

// ---------------------------------------------------------------------------- OAuth

const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33419/callback";
const b64url = (buf: Buffer) => buf.toString("base64url");
const clientIds: string[] = [];

async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${res.url} (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** What the consent form sends: only the signed parameters of the page's query. */
function signedQuery(pageUrl: string) {
  const params = new URL(pageUrl, BASE).searchParams;
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
}

/** Registers an MCP client and starts its authorization for the user signed in to `jar`: the consent page's URL. */
async function consentPageFor(jar: Jar) {
  const prm = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await json(await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`));
  const scope = "openid profile offline_access pages:read pages:write";
  const client = await json(
    await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `Security e2e ${RUN}`,
        application_type: "native",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope,
      }),
    }),
  );
  check(client.client_id, "an MCP client registers", client);
  clientIds.push(client.client_id);
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "e2e",
    code_challenge: b64url(createHash("sha256").update(b64url(randomBytes(32))).digest()),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(), accept: "text/html" } });
  jar.store(res);
  let location = res.headers.get("location");
  if (res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json")) location = (await json(res)).url;
  check(location && new URL(location, BASE).pathname === "/oauth/consent", "the authorization goes to the consent page", { status: res.status, location });
  return new URL(location, BASE).toString();
}

/** Allows the app on the consent page, as its form does. */
const allow = (jar: Jar, consentPage: string) =>
  fetch(`${BASE}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
    body: JSON.stringify({ accept: true, oauth_query: signedQuery(consentPage) }),
  });

// ---------------------------------------------------------------------------- run

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, free: `${RUN}-free`, squatter: `${RUN}-squatter`, keeper: `${RUN}-keeper` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const open = `${RUN}-open`;
const BOGUS = { authorization: "Bearer x" };
const storageKeys: string[] = [];

try {
  const up = await fetch(`${BASE}/api/auth/ok`).then(
    (r) => r.ok,
    () => false,
  );
  if (!up) throw new Error(`No server at ${BASE}: start one (pnpm dev) and set APP_URL`);

  // Every address counts as verified but the squatter's: someone signed up with it, unproven.
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: id !== ids.squatter })));
  await db.insert(workspace).values([
    { id: ws, name: `${RUN} Strict` },
    { id: open, name: `${RUN} Open` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: open, userId: ids.member, role: "owner" },
    { workspaceId: open, userId: ids.free, role: "member" },
  ]);
  const plan = await createPage({ userId: ids.owner }, { workspaceId: ws, title: `Plan ${RUN}` });
  await setPagePermission(ids.owner, plan.id, ids.owner, "full");
  await setPagePermission(ids.owner, plan.id, null, "edit");
  const stored = await files.uploadFile(ids.owner, plan.id, { name: "notes.txt", contentType: "text/plain", body: Readable.from([Buffer.from("secret notes")]) });
  storageKeys.push(...(await db.select({ key: file.storageKey }).from(file).where(eq(file.id, stored.id))).map((r) => r.key));
  const member = await signedIn(ids.member);
  const fileUrl = `/api/files/${stored.id}`;

  check((await get(fileUrl, member)).status === 200, "before the policy, the member's session reads the file");
  // Set in the database: the settings action wants the owner to have two-step verification first.
  await db
    .update(workspace)
    .set({ settings: sql`coalesce(${workspace.settings}, '{}'::jsonb) || '{"requireTwoFactor": true}'::jsonb` })
    .where(eq(workspace.id, ws));

  // ---------------------------------------------------------------- an Authorization header proves nothing
  check((await get(fileUrl, member)).status === 404, "with two-step required, the password-only session can't read the file");
  const bogus = await get(fileUrl, member, BOGUS);
  check(bogus.status === 404, "…nor with `Authorization: Bearer x` added", bogus.status);
  const print = await get(`/print/${plan.id}`, member, BOGUS);
  check(print.status === 307 && (print.headers.get("location") ?? "").includes(`/two-step/${ws}`), "…and the print view sends it to the two-step page", {
    status: print.status,
    location: print.headers.get("location"),
  });
  // A token the request really carries is outside the sign-in policy, the browser's cookie or not.
  const restToken = (await createApiToken(ids.member, { name: RUN, scopes: ["pages:read"] })).secret;
  const rest = await fetch(`${BASE}/api/v1/pages/${plan.id}`, { headers: { authorization: `Bearer ${restToken}`, cookie: member.header() } });
  check(rest.status === 200, "a REST API token still reads the page, even sent along with the held session's cookie", rest.status);

  // ---------------------------------------------------------------- no way around it: API tokens
  const TOKENS = "src/app/actions/api-tokens.ts";
  const free = await signedIn(ids.free);
  // Their account settings open under the workspace that doesn't hold them back.
  const accountPage = await get("/account?tab=apps", member);
  const settings = accountPage.headers.get("location") ?? "";
  check(accountPage.status === 307 && settings.startsWith(`/w/${open}/settings`), "the held-back member opens their account settings in the other workspace", { status: accountPage.status, settings });
  check((await get(settings, member)).status === 200, "…where API tokens are made");
  const newToken = (jar: Jar, workspaceId: string | null) =>
    callAction(jar, "/account", TOKENS, "createApiTokenAction", [{ name: RUN, write: true, workspaceId, expiresInDays: 30 }]);
  const tokensOf = async (userId: string) => (await db.select({ id: apiToken.id }).from(apiToken).where(eq(apiToken.userId, userId))).length;
  const before = await tokensOf(ids.member);
  const unbound = await newToken(member, null);
  check(unbound.text.includes('"error":"policy"') && unbound.text.includes(`/two-step/${ws}`), "a token for all workspaces is refused, and the session sent to the two-step page", unbound.text.slice(0, 300));
  const bound = await newToken(member, ws);
  check(bound.text.includes('"error":"policy"') && bound.text.includes(`/two-step/${ws}`), "…so is one for the workspace that holds it back", bound.text.slice(0, 300));
  const unboundBogus = await callAction(member, "/account", TOKENS, "createApiTokenAction", [{ name: RUN, write: true, workspaceId: null, expiresInDays: 30 }], BOGUS);
  check(unboundBogus.text.includes('"error":"policy"'), "…with an Authorization header too", unboundBogus.text.slice(0, 300));
  check((await tokensOf(ids.member)) === before, "…and no token was made");
  const elsewhere = await newToken(member, open);
  check(elsewhere.text.includes('"ok":true') && elsewhere.text.includes("esi_"), "a token for a workspace that doesn't hold it back is made", elsewhere.text.slice(0, 300));
  const freeToken = await newToken(free, null);
  check(freeToken.text.includes('"ok":true'), "someone no workspace holds back makes a token for all of theirs", freeToken.text.slice(0, 300));

  // ---------------------------------------------------------------- no way around it: connected apps
  const heldConsent = await consentPageFor(member);
  const consentPage = await get(new URL(heldConsent).pathname + new URL(heldConsent).search, member);
  check(consentPage.status === 307 && (consentPage.headers.get("location") ?? "").includes(`/two-step/${ws}`), "the consent page sends the held-back session to the two-step page", {
    status: consentPage.status,
    location: consentPage.headers.get("location"),
  });
  const refusedConsent = await allow(member, heldConsent);
  const refusedBody = await refusedConsent.text();
  check(refusedConsent.status === 403 && !refusedBody.includes("code="), "allowing the app anyway is refused", { status: refusedConsent.status, body: refusedBody.slice(0, 300) });
  const freeConsent = await consentPageFor(free);
  check((await get(new URL(freeConsent).pathname + new URL(freeConsent).search, free)).status === 200, "someone no workspace holds back sees the consent page");
  const allowed = await allow(free, freeConsent);
  const allowedUrl = allowed.ok ? new URL((await json(allowed)).url) : null;
  check(allowedUrl?.searchParams.get("code"), "…and allows the app", allowed.status);

  // ---------------------------------------------------------------- the reset link takes an account over cleanly
  /** What the holder of `userId` set up: a passkey, two-step verification, an API token, a connected app, a session. */
  const setUp = async (userId: string) => {
    await db.insert(passkey).values({ id: `${userId}-key`, publicKey: "key", userId, credentialID: `${userId}-cred`, counter: 0, deviceType: "singleDevice", backedUp: false });
    await db.insert(twoFactor).values({ id: `${userId}-2fa`, secret: "secret", backupCodes: "codes", userId });
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
    await createApiToken(userId, { name: RUN, scopes: ["pages:read"] });
    const now = new Date();
    await db.insert(oauthConsent).values({ id: `${userId}-consent`, clientId: clientIds[0], userId, scopes: ["pages:read"], createdAt: now, updatedAt: now });
    await signedIn(userId);
  };
  const leftOf = async (userId: string) => {
    const count = async (table: typeof passkey | typeof twoFactor | typeof apiToken | typeof oauthConsent | typeof session) =>
      (await db.select({ id: table.id }).from(table).where(eq(table.userId, userId))).length;
    const [row] = await db.select({ twoFactorEnabled: user.twoFactorEnabled, emailVerified: user.emailVerified }).from(user).where(eq(user.id, userId));
    return {
      passkeys: await count(passkey),
      twoFactor: await count(twoFactor),
      twoFactorEnabled: row.twoFactorEnabled,
      apiTokens: await count(apiToken),
      apps: await count(oauthConsent),
      sessions: await count(session),
      emailVerified: row.emailVerified,
    };
  };
  /** Uses a reset link for `userId`, as the emailed one would be (the token is put in its place). */
  const resetPassword = async (userId: string) => {
    const token = randomBytes(16).toString("hex");
    await db.insert(verification).values({ id: `${RUN}-reset-${userId}`, identifier: `reset-password:${token}`, value: userId, expiresAt: new Date(Date.now() + 600_000) });
    return fetch(`${BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ token, newPassword: `new-${RUN}-password` }),
    });
  };
  await setUp(ids.squatter);
  await setUp(ids.keeper);
  const squatted = await leftOf(ids.squatter);
  check(squatted.passkeys && squatted.twoFactor && squatted.twoFactorEnabled && squatted.apiTokens && squatted.apps && squatted.sessions, "an unverified account has a passkey, two-step verification, a token, an app and a session", squatted);
  const reset = await resetPassword(ids.squatter);
  check(reset.ok, "the reset link sets a new password", reset.status);
  const claimed = await leftOf(ids.squatter);
  check(claimed.emailVerified, "…and proves the address", claimed);
  check(!claimed.passkeys && !claimed.twoFactor && !claimed.twoFactorEnabled, "…and the passkeys and two-step verification the earlier holder set up are gone", claimed);
  check(!claimed.apiTokens && !claimed.apps && !claimed.sessions, "…so are their API tokens, connected apps and sessions", claimed);
  check((await resetPassword(ids.keeper)).ok, "the owner of a verified address resets their password");
  const kept = await leftOf(ids.keeper);
  check(kept.passkeys && kept.twoFactor && kept.twoFactorEnabled && kept.apiTokens && kept.apps && !kept.sessions, "…keeping their passkeys, two-step verification, tokens and apps (signed out everywhere)", kept);

  // ---------------------------------------------------------------- another identity provider behind an SSO connection
  // Saved the way the settings save it, with discovery answered here (no identity provider runs).
  const discover = async (issuer: string) => ({
    issuer,
    authorizationEndpoint: `${issuer}/auth`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/certs`,
    tokenEndpointAuthentication: "client_secret_basic" as const,
  });
  const connect = (issuer: string, domains = `acme-${RUN}.test`) =>
    saveSsoConnection(ids.member, open, { protocol: "oidc", issuer, clientId: "leafdesk", clientSecret: "secret", domains }, { discover });
  const providerId = workspaceProviderId(open);
  /** Someone who signed in through the connection: the account linking them, and their session. */
  const signInThrough = async (userId: string) => {
    await db.insert(account).values({ id: `${RUN}-sso-${userId}-${randomBytes(3).toString("hex")}`, accountId: `sub-${userId}`, providerId, userId, updatedAt: new Date() });
    // Only this session: their earlier ones came another way.
    await db.delete(session).where(eq(session.userId, userId));
    const jar = await signedIn(userId);
    await db.update(session).set({ ssoProviderId: providerId }).where(eq(session.userId, userId));
    return jar;
  };
  const throughConnection = async () => ({
    accounts: (await db.select({ id: account.id }).from(account).where(eq(account.providerId, providerId))).length,
    sessions: (await db.select({ id: session.id }).from(session).where(eq(session.ssoProviderId, providerId))).length,
  });
  await connect("https://idp-a.example.test/realm");
  await signInThrough(ids.free);
  check((await throughConnection()).accounts === 1 && (await throughConnection()).sessions === 1, "someone signed in through the workspace's connection", await throughConnection());
  await connect("https://idp-a.example.test/realm", `acme-${RUN}.test, beta-${RUN}.test`);
  check((await throughConnection()).accounts === 1 && (await throughConnection()).sessions === 1, "changing only the domains keeps them linked and signed in", await throughConnection());
  await connect("https://idp-b.example.test/realm");
  check(JSON.stringify(await throughConnection()) === JSON.stringify({ accounts: 0, sessions: 0 }), "another identity provider forgets them and signs them out", await throughConnection());
  await signInThrough(ids.free);
  await removeSsoConnection(ids.member, open);
  check(JSON.stringify(await throughConnection()) === JSON.stringify({ accounts: 0, sessions: 0 }), "removing the connection does too", await throughConnection());

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(`\n${passed} checks passed before the failure.`);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Deleting the users drops their sessions and tokens; the workspaces take their pages and files along.
  await db.delete(workspace).where(inArray(workspace.id, [ws, open]));
  await db.delete(user).where(inArray(user.id, userIds));
  if (clientIds.length) await db.delete(oauthClient).where(inArray(oauthClient.clientId, clientIds));
  await files.removeStored(storageKeys);
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
