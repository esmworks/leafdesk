/**
 * End-to-end check of a workspace's security switches (Settings → Security) against a running app:
 * only owners change them, through the settings server action; with export off every export route
 * and the print view refuse, and come back when it is on; with publishing off published pages, the
 * workspace site and public forms answer 404 and nothing new can be published, while the
 * publications are kept and served again once it is back on; and connected apps (an MCP client
 * authorized over OAuth, a REST API token) get full access, read-only access (writes refused, reads
 * fine) or none (the workspace hidden from lists and its pages not found), while the browser
 * session is left alone and another workspace keeps its own setting.
 * Creates its own users, workspaces and OAuth client, and deletes them afterwards.
 *
 *   APP_URL=http://localhost:3102 pnpm tsx scripts/security-switches-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from
 * .env when present), NEXT_DIR (the server's .next folder, default ./.next, for server action ids).
 * Migrations must be applied.
 */
import { waitOutAuthRateLimits } from "./auth-rate-limit";
export {};

const appUrl = process.env.APP_URL;
try {
  process.loadEnvFile();
} catch {}

const { createHash, randomBytes } = await import("node:crypto");
const { existsSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { oauthClient, pagePublication, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addView } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const publication = await import("@/server/publication");
const forms = await import("@/server/forms");
const site = await import("@/server/site");
const { createApiToken } = await import("@/server/api/tokens");
const { workspaceSettings } = await import("@/server/workspaces");

const BASE = (appUrl ?? "http://localhost:3000").replace(/\/$/, "");
waitOutAuthRateLimits(BASE);
const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33419/callback";
const RUN = `secsw-${Date.now().toString(36)}`;
const SETTINGS_ACTIONS = "src/app/actions/workspaces.ts";

// The real collab service: pages made here get their documents, so the public routes can draw them.
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

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
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

async function signedIn(userId: string) {
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session-${userId}`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return new Jar(`better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`);
}

const get = (path: string, jar?: Jar) =>
  fetch(`${BASE}${path}`, { headers: { accept: "text/html", "accept-language": "en", ...(jar ? { cookie: jar.header() } : {}) }, redirect: "manual" });

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

// ---------------------------------------------------------------------------- MCP over OAuth

const b64url = (buf: Buffer) => buf.toString("base64url");

async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${res.url} (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** What the oauthProviderClient fetch plugin sends: only the signed parameters. */
function signedQuery(pageUrl: string) {
  const params = new URL(pageUrl, BASE).searchParams;
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
}

async function redirectOf(jar: Jar, url: string) {
  const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(), accept: "text/html" } });
  jar.store(res);
  // Node fetch sends `sec-fetch-mode: cors`, so Better Auth may answer with the JSON form of a redirect.
  if (res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await json(res);
    return new URL(body.url, BASE).toString();
  }
  const location = res.headers.get("location");
  check(res.status >= 300 && res.status < 400 && location, `GET ${new URL(url).pathname} redirects`, res.status);
  return new URL(location, BASE).toString();
}

const clientIds: string[] = [];

/** An MCP client's access token for the user signed in to `jar`: DCR, authorize, consent, exchange. */
async function mcpToken(jar: Jar) {
  const prm = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await json(await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`));
  const scope = "openid profile offline_access pages:read pages:write";
  const registered = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `Security switches e2e ${RUN}`,
      application_type: "native",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
  const client = await json(registered);
  if (client.client_id) clientIds.push(client.client_id);
  check(registered.ok && client.client_id, "an MCP client registers", client);

  const verifier = b64url(randomBytes(32));
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "e2e",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  const consentPage = await redirectOf(jar, url.toString());
  check(new URL(consentPage).pathname === "/oauth/consent", "the signed-in owner reaches the consent page", consentPage);
  const decided = await fetch(`${BASE}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
    body: JSON.stringify({ accept: true, oauth_query: signedQuery(consentPage) }),
  });
  const back = new URL((await json(decided)).url);
  const code = back.searchParams.get("code");
  check(code, "consent gives the client a code", back.toString());
  const tokens = await json(
    await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }),
    }),
  );
  check(tokens.access_token, "the code exchanges for an access token", tokens);
  return tokens.access_token as string;
}

class Mcp {
  private nextId = 1;
  constructor(private token: string) {}
  private async rpc(body: Record<string, unknown>) {
    const res = await fetch(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    const text = await res.text();
    if (!text) return { status: res.status, message: null as any };
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const messages = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()));
      return { status: res.status, message: messages.find((m) => m.id === body.id) ?? messages.at(-1) };
    }
    return { status: res.status, message: JSON.parse(text) };
  }
  async init() {
    const r = await this.rpc({ id: this.nextId++, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "security-switches-e2e", version: "1" } } });
    check(r.status === 200 && r.message?.result?.serverInfo, "the MCP session starts", r);
    await this.rpc({ method: "notifications/initialized" });
  }
  async call(name: string, args: Record<string, unknown>) {
    const r = await this.rpc({ id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    if (r.status !== 200 || !r.message?.result) throw new Error(`tools/call ${name} failed: ${JSON.stringify(r)}`);
    const result = r.message.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content?.[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: Boolean(result.isError), data, text };
  }
}

// ---------------------------------------------------------------------------- REST

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

// ---------------------------------------------------------------------------- run

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const other = `${RUN}-other`;
const SLUG = `${RUN}-site`;

try {
  const up = await fetch(`${BASE}/api/auth/ok`).then(
    (r) => r.ok,
    () => false,
  );
  if (!up) throw new Error(`No server at ${BASE}: start one (pnpm dev) and set APP_URL`);

  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: ws, name: `${RUN} Acme` },
    { id: other, name: `${RUN} Other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: other, userId: ids.owner, role: "owner" },
  ]);
  const actor = { userId: ids.owner };
  const plan = await createPage(actor, { workspaceId: ws, title: `Plan ${RUN}` });
  const leads = await createPage(actor, { workspaceId: ws, kind: "database", title: "Leads" });
  const draft = await createPage(actor, { workspaceId: ws, title: "Draft" });
  const elsewhere = await createPage(actor, { workspaceId: other, title: `Elsewhere ${RUN}` });
  for (const p of [plan, leads, draft]) {
    await setPagePermission(ids.owner, p.id, ids.owner, "full");
    await setPagePermission(ids.owner, p.id, null, "edit");
  }
  await setPagePermission(ids.owner, elsewhere.id, ids.owner, "full");
  const form = await addView(ids.owner, leads.id, { name: "Contact", type: "form" });

  const owner = await signedIn(ids.owner);
  const member = await signedIn(ids.member);
  const settingsPath = `/w/${ws}/settings?tab=security`;
  const settingsOf = () => workspaceSettings(ws);
  const setAs = (jar: Jar, patch: Record<string, unknown>) => callAction(jar, settingsPath, SETTINGS_ACTIONS, "updateWorkspaceSettingsAction", [ws, patch]);
  const set = async (patch: Record<string, unknown>, label: string) => {
    const res = await setAs(owner, patch);
    check(res.status === 200 && res.text.includes('"ok":true'), label, res.text.slice(0, 300));
  };

  // ---------------------------------------------------------------- the settings, owners only
  const settingsPage = await get(settingsPath, owner);
  const settingsHtml = await settingsPage.text();
  check(settingsPage.status === 200 && settingsHtml.includes("Connected apps and API tokens"), "the owner's Security tab shows the switches", settingsPage.status);
  const defaults = await settingsOf();
  check(defaults.export === true && defaults.connectedApps === "full" && defaults.publishing === "members", "a new workspace exports, lets members publish and gives apps full access", defaults);
  for (const patch of [{ export: false }, { publishing: "off" }, { connectedApps: "off" }]) {
    const res = await setAs(member, patch);
    check(res.text.includes('"ok":false'), `a member can't change ${Object.keys(patch)[0]}`, res.text.slice(0, 300));
  }
  for (const patch of [{ export: "no" }, { publishing: "everyone" }, { connectedApps: "write" }]) {
    const res = await setAs(owner, patch);
    check(res.text.includes('"ok":false'), `an unknown ${Object.keys(patch)[0]} value is refused`, res.text.slice(0, 300));
  }
  check(JSON.stringify(await settingsOf()) === JSON.stringify(defaults), "…and nothing changed");

  // ---------------------------------------------------------------- export
  const pageExport = `/w/${ws}/p/${plan.id}/export`;
  const csvExport = `/w/${ws}/p/${leads.id}/export`;
  const zipCheck = `${pageExport}?subpages=1&check=1`;
  const wsZipCheck = `/w/${ws}/settings/export.zip?check=1`;
  check((await get(pageExport, owner)).status === 200, "with export on, a page exports as Markdown");
  check((await get(csvExport, owner)).status === 200, "…a database as CSV");
  check((await get(zipCheck, owner)).status === 200, "…a page with its subpages as a ZIP");
  check((await get(wsZipCheck, owner)).status === 200, "…and the owner the whole workspace");
  const printOnRes = await get(`/print/${plan.id}`, owner);
  const printOn = await printOnRes.text();
  check(
    printOnRes.status === 200 && printOn.includes(`<title>Plan ${RUN}</title>`),
    "…and the print view draws the page",
    { status: printOnRes.status, location: printOnRes.headers.get("location"), body: printOn.slice(0, 400) },
  );

  await set({ export: false }, "the owner turns export off");
  for (const [path, label] of [
    [pageExport, "Markdown"],
    [csvExport, "CSV"],
    [zipCheck, "ZIP (dry run)"],
    [`${pageExport}?subpages=1`, "ZIP"],
    [wsZipCheck, "whole-workspace ZIP (dry run)"],
    [`/w/${ws}/settings/export.zip`, "whole-workspace ZIP"],
  ] as const) {
    const res = await get(path, owner);
    const body = await res.json().catch(() => null);
    check(res.status === 403 && body?.error === "disabled", `export off: the ${label} export is 403 disabled, for the owner too`, { status: res.status, body });
  }
  const selected = await fetch(`${BASE}${csvExport}`, { method: "POST", headers: { cookie: owner.header(), "content-type": "application/json" }, body: JSON.stringify({ rows: [] }) });
  check(selected.status === 403, "export off: selected rows don't export either", selected.status);
  const printOff = await get(`/print/${plan.id}`, owner);
  const printOffHtml = await printOff.text();
  check(printOff.status === 200 && printOffHtml.includes("<title>Export is turned off</title>") && !printOffHtml.includes(`<title>Plan ${RUN}`), "export off: the print view says so instead of drawing the page");
  check((await get(pageExport, member)).status === 403, "export off: members are refused the same way");
  const exporter = await import("@/server/export");
  const inProcess = await failure(() => exporter.databaseCsv(ids.owner, leads.id, null));
  check(inProcess instanceof exporter.ExportError && inProcess.code === "disabled", "export off: the export service refuses too", String(inProcess));

  await set({ export: true }, "the owner turns export back on");
  check((await get(pageExport, owner)).status === 200 && (await get(zipCheck, owner)).status === 200, "export on again: exports work");

  // ---------------------------------------------------------------- publishing
  const published = await publication.publishPage(ids.owner, plan.id);
  await site.saveSite(ids.owner, ws, { slug: SLUG, title: "Acme Docs", homePageId: plan.id });
  const openForm = await forms.publishForm(ids.owner, form.id);
  check((await get(`/s/${published.token}`)).status === 200, "a published page is served");
  check((await get(`/s/${SLUG}`)).status === 200, "…so are the workspace site");
  check((await get(`/f/${openForm.token}`)).status === 200, "…and the public form");

  await set({ publishing: "off" }, "the owner turns publishing off");
  check((await get(`/s/${published.token}`)).status === 404, "publishing off: the published page is 404");
  check((await get(`/s/${SLUG}`)).status === 404, "publishing off: the site is 404");
  check((await get(`/s/${SLUG}/${plan.id}`)).status === 404, "publishing off: the site's pages are 404");
  check((await get(`/f/${openForm.token}`)).status === 404, "publishing off: the public form is 404");
  const refused = await failure(() => publication.publishPage(ids.owner, draft.id));
  check(refused instanceof publication.PublishError && refused.code === "publishingOff", "publishing off: the owner can't publish", String(refused));
  check((await publication.publishBlocker(ids.owner, draft.id)) === "publishingOff", "publishing off: the publish menu says why");
  const formRefused = await failure(() => forms.publishForm(ids.owner, form.id));
  check(formRefused instanceof forms.FormError && formRefused.code === "publishingOff", "publishing off: forms can't be opened to the web", String(formRefused));
  const kept = await db.select({ token: pagePublication.token }).from(pagePublication).where(eq(pagePublication.pageId, plan.id));
  check(kept[0]?.token === published.token, "publishing off: the publication is kept, not deleted");
  const listed = await publication.listWorkspacePublications(ids.owner, ws);
  check(listed.some((p) => p.pageId === plan.id && p.url === null), "publishing off: Settings still lists it, without a link", listed);
  check((await site.getSite(ids.owner, ws))?.slug === SLUG, "publishing off: the site's settings are kept");

  await set({ publishing: "members" }, "the owner turns publishing back on");
  check((await get(`/s/${published.token}`)).status === 200, "publishing on again: the same link is served");
  check((await get(`/s/${SLUG}`)).status === 200, "publishing on again: so is the site");
  check((await get(`/f/${openForm.token}`)).status === 200, "publishing on again: and the form");

  // ---------------------------------------------------------------- connected apps
  const mcp = new Mcp(await mcpToken(owner));
  await mcp.init();
  const { secret: restToken } = await createApiToken(ids.owner, { name: "security switches e2e", scopes: ["pages:write"] });
  const listedIds = async () => (await mcp.call("list_workspaces", {})).data.workspaces.map((w: { id: string }) => w.id) as string[];
  const restIds = async () => ((await api("GET", "/workspaces", restToken)).body.workspaces as { id: string }[]).map((w) => w.id);

  check((await listedIds()).includes(ws), "full access: MCP lists the workspace");
  const found = await mcp.call("search", { query: RUN });
  check(((found.data.results ?? []) as { id: string }[]).some((h) => h.id === plan.id), "full access: MCP search finds its pages", found.text.slice(0, 300));
  check(!(await mcp.call("update_page", { page_id: plan.id, title: `Plan ${RUN} v2` })).isError, "full access: an MCP write goes through");
  check((await api("PATCH", `/pages/${plan.id}`, restToken, { title: `Plan ${RUN} v3` })).status === 200, "full access: a REST write goes through");

  await set({ connectedApps: "read" }, "the owner lets apps only read");
  const read = await mcp.call("get_page", { page_id: plan.id });
  check(!read.isError && read.data.title === `Plan ${RUN} v3`, "read only: MCP reads the page", read.text.slice(0, 200));
  check((await listedIds()).includes(ws), "read only: MCP still lists the workspace");
  const mcpWrite = await mcp.call("update_page", { page_id: plan.id, title: "Should not change" });
  check(mcpWrite.isError && mcpWrite.text.includes("only read"), "read only: an MCP write is refused, saying why", mcpWrite.text);
  const mcpCreate = await mcp.call("create_page", { workspace_id: ws, title: "Should not exist" });
  check(mcpCreate.isError, "read only: MCP can't create a top-level page either", mcpCreate.text);
  const mcpElsewhere = await mcp.call("update_page", { page_id: elsewhere.id, title: `Elsewhere ${RUN} v2` });
  check(!mcpElsewhere.isError, "read only: the user's other workspace keeps full access", mcpElsewhere.text);
  const restRead = await api("GET", `/pages/${plan.id}`, restToken);
  check(restRead.status === 200, "read only: REST reads the page", restRead.body);
  const restWrite = await api("PATCH", `/pages/${plan.id}`, restToken, { title: "Should not change" });
  check(restWrite.status === 403 && restWrite.code === "forbidden", "read only: a REST write is 403 forbidden", restWrite.body);
  const restCreate = await api("POST", "/pages", restToken, { workspace_id: ws, title: "Should not exist" });
  check(restCreate.status === 403, "read only: REST can't create a page", restCreate.body);
  check((await api("GET", `/pages/${plan.id}`, restToken)).body.title === `Plan ${RUN} v3`, "read only: nothing changed");

  await set({ connectedApps: "off" }, "the owner turns connected apps off");
  const hiddenList = await listedIds();
  check(!hiddenList.includes(ws) && hiddenList.includes(other), "off: list_workspaces leaves the workspace out, not the other", hiddenList);
  const hiddenPage = await mcp.call("get_page", { page_id: plan.id });
  check(hiddenPage.isError, "off: MCP can't read its pages", hiddenPage.text);
  const hiddenSearch = await mcp.call("search", { query: RUN });
  const hits = (hiddenSearch.data.results ?? []) as { id: string }[];
  check(!hiddenSearch.isError && !hits.some((h) => h.id === plan.id), "off: search leaves its pages out", hiddenSearch.text.slice(0, 300));
  check(!(await mcp.call("get_page", { page_id: elsewhere.id })).isError, "off: the other workspace still reads");
  const restList = await restIds();
  check(!restList.includes(ws) && restList.includes(other), "off: GET /workspaces leaves it out", restList);
  const restHidden = await api("GET", `/pages/${plan.id}`, restToken);
  check(restHidden.status === 404, "off: its pages are 404 over REST", restHidden.body);
  check((await api("GET", `/workspaces/${ws}/pages`, restToken)).status === 404, "off: listing its pages is 404 over REST");
  check((await get(pageExport, owner)).status === 200, "off: the owner's browser session is not affected");

  await set({ connectedApps: "full" }, "the owner gives apps full access again");
  check((await listedIds()).includes(ws) && (await restIds()).includes(ws), "full again: both list the workspace");
  check(!(await mcp.call("update_page", { page_id: plan.id, title: `Plan ${RUN} v4` })).isError, "full again: MCP writes");
  check((await api("PATCH", `/pages/${plan.id}`, restToken, { title: `Plan ${RUN} v5` })).status === 200, "full again: REST writes");

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(`\n${passed} checks passed before the failure.`);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Deleting the users drops their sessions and tokens; the workspaces take their pages along.
  await db.delete(workspace).where(inArray(workspace.id, [ws, other]));
  await db.delete(user).where(inArray(user.id, userIds));
  if (clientIds.length) await db.delete(oauthClient).where(inArray(oauthClient.clientId, clientIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
