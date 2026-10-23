/**
 * End-to-end check of a workspace's approved networks against a running app:
 *
 * - an owner can't save a list that leaves out their own address (the refusal names it), and can
 *   save one that covers it, which the audit log records;
 * - a member's browser session from another address is sent to the "approved networks" page, which
 *   shows the address the server sees, while the same session from an approved address gets in and
 *   their other workspace keeps working from anywhere;
 * - a client can't claim an address by sending the server's own header, on requests or on the
 *   live collaboration websocket;
 * - the live connection is checked by the address it comes from, and saving a list closes the open
 *   connections it now holds back;
 * - REST API tokens stay outside the list (they answer to the connected-apps setting);
 * - an instance administrator can clear the list, after which the member gets in from anywhere.
 *
 * Addresses are simulated with X-Forwarded-For: with TRUSTED_PROXIES unset (or 1), the server takes
 * the last entry when the request comes from the same machine. The websocket of this script
 * carries none, so it comes from the loopback address.
 *
 * Creates its own @example.test users and workspaces and deletes them afterwards. Server actions are
 * called by id, from the running app's build output (`.next`, or NEXT_DIR): run it from the
 * checkout the app runs from.
 *
 *   APP_URL=http://localhost:3354 node --env-file=.env --import tsx scripts/ip-allowlist-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from
 * .env when present). Migrations must be applied.
 */
export {};

const appUrl = process.env.APP_URL;
try {
  process.loadEnvFile();
} catch {}
const RUN = `ipa-${Date.now().toString(36)}`;
// This script acts as an instance administrator for the last step (clearing a list from /admin).
const ADMIN_EMAIL = `${RUN}-admin@example.test`;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;

const { randomBytes } = await import("node:crypto");
const { existsSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");

const { and, eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { HocuspocusProvider } = await import("@hocuspocus/provider");
const { db } = await import("@/db");
const { auditEvent, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { READ_SCOPES } = await import("@/lib/api-scopes");
const { COLLAB_IP } = await import("@/lib/offline");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createApiToken } = await import("@/server/api/tokens");
const { clearWorkspaceNetworks } = await import("@/server/instance-admin");

const BASE = (appUrl ?? "http://localhost:3000").replace(/\/$/, "");
const { service } = createCollab();
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

/** A session cookie for `userId`, made in the database. */
async function signedIn(userId: string) {
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session-${randomBytes(4).toString("hex")}`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
}

/** A request from `ip`, as the proxy in front of the app would forward it. */
const from = (ip: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": ip, ...extra });

const get = (path: string, cookie: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { headers: { accept: "text/html", "accept-language": "en", cookie, ...headers }, redirect: "manual" });

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

async function saveNetworks(cookie: string, ip: string, networks: { range: string; label: string }[]) {
  const res = await fetch(`${BASE}/w/${ws}/settings?tab=security`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "accept-language": "en",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId("src/app/actions/workspaces.ts", "setAllowedNetworksAction"),
      origin: BASE,
      cookie,
      ...from(ip),
    },
    body: JSON.stringify([ws, networks]),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

/** The stored list, keys in a fixed order (jsonb keeps its own). */
const stored = async () =>
  ((await db.select({ networks: workspace.allowedNetworks }).from(workspace).where(eq(workspace.id, ws)))[0]?.networks ?? []).map(({ range, label }) => ({ range, label }));
const auditActions = async () =>
  (await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.workspaceId, ws))).map((r) => r.action);

/** Opens the workspace's live signals as a browser tab would, from this machine (loopback). */
async function openLive(cookie: string, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/api/collab-token`, { headers: { cookie, ...from("192.0.2.10") } });
  const { token, build } = (await res.json()) as { token: string; build?: string | null };
  const outcome: { synced: boolean; reason: string | null; closes: number[] } = { synced: false, reason: null, closes: [] };
  // The provider can't set headers; a WebSocket that adds them shows the server ignores what a client claims.
  const Socket = Object.keys(extraHeaders).length
    ? class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          // Node's WebSocket (undici) takes headers in its options.
          super(url, { protocols, headers: extraHeaders } as unknown as string[]);
        }
      }
    : WebSocket;
  const provider = new HocuspocusProvider({
    url: `${BASE.replace(/^http/, "ws")}/collab${build ? `?build=${encodeURIComponent(build)}` : ""}`,
    name: `ws:${ws}`,
    document: new Y.Doc(),
    token,
    WebSocketPolyfill: Socket,
    onAuthenticationFailed: ({ reason }) => void (outcome.reason = reason),
    onClose: ({ event }) => void outcome.closes.push(event.code),
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  provider.on("synced", () => void (outcome.synced = true));
  await waitFor(() => outcome.synced || outcome.reason !== null, 10_000);
  return { provider, outcome };
}
async function waitFor(condition: () => boolean, ms = 5_000) {
  for (let waited = 0; waited < ms && !condition(); waited += 50) await new Promise((r) => setTimeout(r, 50));
  return condition();
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, admin: `${RUN}-admin` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const other = `${RUN}-other`;
const OFFICE = "192.0.2.10";
const OFFICE_PEER = "192.0.2.44";
const HOME = "203.0.113.5";
const providers: { destroy(): void }[] = [];

try {
  const up = await fetch(`${BASE}/api/auth/ok`).then(
    (r) => r.ok,
    () => false,
  );
  if (!up) throw new Error(`No server at ${BASE}: start one and set APP_URL`);

  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));
  await db.insert(workspace).values([
    { id: ws, name: `${RUN} Office only` },
    { id: other, name: `${RUN} Anywhere` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: other, userId: ids.member, role: "owner" },
  ]);
  const plan = await createPage({ userId: ids.owner }, { workspaceId: ws, title: `Plan ${RUN}` });
  const owner = await signedIn(ids.owner);
  const member = await signedIn(ids.member);

  // ------------------------------------------------------------------ settings and the lock-out check

  const settings = await get(`/w/${ws}/settings?tab=security`, owner, from(OFFICE));
  const settingsHtml = await settings.text();
  check(settings.status === 200 && settingsHtml.includes("Approved networks"), "the owner sees the approved networks in Settings → Security", settings.status);
  check(settingsHtml.includes(OFFICE), "…with the address the server sees for them");

  const refused = await saveNetworks(owner, OFFICE, [{ range: "198.51.100.0/24", label: "Elsewhere" }]);
  check(refused.text.includes('"ok":false') && refused.text.includes("ipLocksYouOut") && refused.text.includes(OFFICE), "a list without the owner's address is refused, naming it", refused.text.slice(0, 400));
  check(JSON.stringify(await stored()) === "[]", "…and nothing is saved");

  const invalid = await saveNetworks(owner, OFFICE, [{ range: "192.0.2.0/33", label: "" }]);
  check(invalid.text.includes("invalidNetwork") && invalid.text.includes("192.0.2.0/33"), "an entry that isn't a range is refused, naming it", invalid.text.slice(0, 400));

  const saved = await saveNetworks(owner, OFFICE, [
    { range: "192.0.2.99/24", label: "Office" },
    { range: "2001:DB8::/32", label: "" },
  ]);
  check(saved.text.includes('"ok":true'), "a list that covers the owner is saved", saved.text.slice(0, 400));
  check(
    JSON.stringify(await stored()) === JSON.stringify([
      { range: "192.0.2.0/24", label: "Office" },
      { range: "2001:db8::/32", label: "" },
    ]),
    "…made canonical",
    await stored(),
  );
  check((await auditActions()).includes("workspace.networks_changed"), "…and recorded in the audit log");

  // ------------------------------------------------------------------ browser sessions

  const away = await get(`/w/${ws}`, member, from(HOME));
  check(away.status === 307 && (away.headers.get("location") ?? "").endsWith(`/network-required/${ws}`), "a member from another network is sent to the approved-networks page", {
    status: away.status,
    location: away.headers.get("location"),
  });
  const gate = await get(`/network-required/${ws}`, member, from(HOME));
  const gateHtml = await gate.text();
  check(gate.status === 200 && gateHtml.includes("only allows sign-in from approved networks") && gateHtml.includes(HOME), "…which says why and shows their address", gate.status);
  check(gateHtml.includes(`${RUN} Anywhere`), "…and links to their other workspaces");

  const page = await get(`/w/${ws}/p/${plan.id}`, member, from(HOME));
  check(page.status === 307 && (page.headers.get("location") ?? "").includes(`/network-required/${ws}`), "a page of the workspace sends them there too", page.status);
  const exported = await get(`/w/${ws}/p/${plan.id}/export`, member, from(HOME));
  check(exported.status === 403 || exported.status === 404, "an export of its page is refused", exported.status);

  const spoofed = await get(`/w/${ws}`, member, from(HOME, { "x-leafdesk-client-ip": OFFICE_PEER }));
  check(spoofed.status === 307 && (spoofed.headers.get("location") ?? "").includes("/network-required/"), "claiming an address with the server's own header changes nothing", spoofed.status);

  const elsewhere = await get(`/w/${other}`, member, from(HOME));
  check(elsewhere.status === 200, "their other workspace keeps working from the same network", elsewhere.status);

  const atOffice = await get(`/w/${ws}`, member, from(OFFICE_PEER));
  check(atOffice.status === 200, "from an approved network they get in", atOffice.status);
  const mapped = await get(`/w/${ws}`, member, from(`::ffff:${OFFICE_PEER}`));
  check(mapped.status === 200, "…an IPv4-mapped IPv6 address of it too", mapped.status);
  const gateAtOffice = await get(`/network-required/${ws}`, member, from(OFFICE_PEER));
  check(gateAtOffice.status === 307 && (gateAtOffice.headers.get("location") ?? "").endsWith(`/w/${ws}`), "…and the approved-networks page sends them on to the workspace", gateAtOffice.status);

  // ------------------------------------------------------------------ apps stay outside

  const { secret } = await createApiToken(ids.member, { name: RUN, scopes: READ_SCOPES });
  const api = await fetch(`${BASE}/api/v1/workspaces`, { headers: { authorization: `Bearer ${secret}`, ...from(HOME) } });
  const apiBody = await api.text();
  check(api.status === 200 && apiBody.includes(ws), "a REST API token still reaches the workspace from another network", { status: api.status, body: apiBody.slice(0, 300) });

  // ------------------------------------------------------------------ live collaboration

  const refusedLive = await openLive(member);
  providers.push(refusedLive.provider);
  check(!refusedLive.outcome.synced && refusedLive.outcome.reason === COLLAB_IP, "the live connection from an address off the list is refused, saying why", refusedLive.outcome);
  const spoofedLive = await openLive(member, { "x-leafdesk-client-ip": OFFICE_PEER });
  providers.push(spoofedLive.provider);
  check(!spoofedLive.outcome.synced && spoofedLive.outcome.reason === COLLAB_IP, "…whatever address the websocket claims in the server's own header", spoofedLive.outcome);
  // Through the proxy in front of the app (here: a forwarded address from this machine), the
  // websocket counts by the address the proxy saw, like any request.
  const proxied = await openLive(member, { "x-forwarded-for": OFFICE_PEER });
  providers.push(proxied.provider);
  check(proxied.outcome.synced, "a websocket the proxy forwards from an approved address is let in", proxied.outcome);

  const withLoopback = await saveNetworks(owner, OFFICE, [
    { range: "192.0.2.0/24", label: "Office" },
    { range: "127.0.0.1", label: "This machine" },
    { range: "::1", label: "This machine" },
  ]);
  check(withLoopback.text.includes('"ok":true'), "the owner adds this machine to the list", withLoopback.text.slice(0, 300));
  const live = await openLive(member);
  providers.push(live.provider);
  check(live.outcome.synced, "the live connection from an approved address is let in", live.outcome);

  const narrowed = await saveNetworks(owner, OFFICE, [{ range: "192.0.2.0/24", label: "Office" }]);
  check(narrowed.text.includes('"ok":true'), "the owner takes this machine off the list again", narrowed.text.slice(0, 300));
  check(await waitFor(() => live.outcome.closes.length > 0), "…which closes the open connection from it", live.outcome);

  // ------------------------------------------------------------------ the instance administrator's way back in

  const admin = { user: { id: ids.admin, email: ADMIN_EMAIL, emailVerified: true }, session: { id: "e2e" } };
  await clearWorkspaceNetworks(admin, ws);
  check(JSON.stringify(await stored()) === "[]", "an instance administrator clears the list");
  check((await auditActions()).includes("workspace.networks_cleared"), "…which the workspace's audit log records");
  const back = await get(`/w/${ws}`, member, from(HOME));
  check(back.status === 200, "…and the member gets in from any network again", back.status);
  const notAdmin = await clearWorkspaceNetworks({ user: { id: ids.member, email: `${ids.member}@example.test`, emailVerified: true }, session: { id: "x" } }, ws).catch((e: unknown) => e);
  check(notAdmin instanceof Error && (notAdmin as { code?: string }).code === "notFound", "someone else can't clear it", String(notAdmin));

  console.log(`\n${passed} checks passed`);
} finally {
  for (const provider of providers) provider.destroy();
  await db.delete(auditEvent).where(inArray(auditEvent.workspaceId, [ws, other]));
  await db.delete(workspaceMember).where(and(inArray(workspaceMember.workspaceId, [ws, other])));
  await db.delete(workspace).where(inArray(workspace.id, [ws, other]));
  await db.delete(user).where(inArray(user.id, userIds));
}
process.exit(0);
