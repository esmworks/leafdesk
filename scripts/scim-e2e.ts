/**
 * End-to-end check of SCIM 2.0 provisioning over HTTP against a running app, playing the identity
 * provider with a SCIM token: tokens (created and revoked with the settings' server actions, bearer
 * auth, one workspace per token), discovery endpoints, listing and filtering users, creating them
 * (new accounts only in the workspace's verified SSO domains; existing accounts and guests join as
 * members), deactivating (they leave the workspace and can't rejoin through SSO), reactivating,
 * renaming, deleting, owners protected, and /Groups: creating member groups with members, Okta-
 * and Entra ID-style PATCH (add, remove by filter or by value, rename, externalId), PUT, filters
 * and paging, guests and outsiders refused, open editors closed when someone leaves a group (a real
 * collab websocket), pages only a deleted group could manage passing to the oldest owner, the
 * settings marking provisioned groups, and another workspace's token seeing none of it.
 *
 *   APP_URL=http://localhost:5100 pnpm tsx scripts/scim-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL (read from .env when present; the
 * same database as the app's). The workspace's SSO domain is verified with a stub DNS answer.
 * Creates its own users and workspaces and deletes them afterwards.
 */
import { waitOutAuthRateLimits } from "./auth-rate-limit";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile();
} catch {}

const { and, eq, ilike, inArray, or } = await import("drizzle-orm");
const { db } = await import("@/db");
const { memberGroup, memberGroupMember, scimGroup, scimIdentity, scimToken, user, workspace, workspaceMember } = await import("@/db/schema");
const { saveSsoConnection, verifySsoDomains, joinThroughSso } = await import("@/server/sso");
const { domainRecordName } = await import("@/lib/sso-config");
const { createGroup } = await import("@/server/groups");
const { createPage } = await import("@/server/pages");
const { removePagePermission, setPageGroupPermission } = await import("@/server/permissions");
const { resolvePageAccess } = await import("@/server/access");
const { registerCollab } = await import("@/server/collab/bridge");
const { HocuspocusProvider } = await import("@hocuspocus/provider");
const Y = await import("yjs");

// Page and group changes made here (not over HTTP) notify open editors through the collab
// service, which runs inside the app server only.
registerCollab({
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async disconnectLostAccess() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
} as unknown as Parameters<typeof registerCollab>[0]);

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
waitOutAuthRateLimits(BASE);
const RUN = Date.now().toString(36);
const PASSWORD = "scim-e2e-password-123";
const DOMAIN = `scim-${RUN}.test`;

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

/** A SCIM request as an identity provider sends it. */
async function scim(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/scim/v2${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/scim+json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    location: res.headers.get("location"),
    authenticate: res.headers.get("www-authenticate"),
    body: (await res.json().catch(() => null)) as any,
  };
}

const connections: InstanceType<typeof HocuspocusProvider>[] = [];
/** A live editor on a page, the way the app opens one: collab token, then the websocket. */
async function connect(jar: Jar, name: string) {
  const { token, build } = (await fetch(`${BASE}/api/collab-token`, { headers: { cookie: jar.header() } }).then((r) => r.json())) as { token: string; build?: string | null };
  const closes: number[] = [];
  let refusals = 0;
  let settle: (outcome: "synced" | "refused") => void = () => {};
  const settled = new Promise<"synced" | "refused">((resolve) => (settle = resolve));
  const provider = new HocuspocusProvider({
    // A production server refuses a tab that names no build (lib/build-id); this one runs the server's.
    url: `${BASE.replace(/^http/, "ws")}/collab${build ? `?build=${encodeURIComponent(build)}` : ""}`,
    name,
    document: new Y.Doc(),
    token,
    onSynced: () => settle("synced"),
    onAuthenticationFailed: () => {
      refusals++;
      settle("refused");
    },
    onClose: ({ event }) => void closes.push(event.code),
  });
  connections.push(provider);
  const outcome = await Promise.race([settled, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
  return { outcome, closes, failed: () => refusals > 0 };
}

async function eventually(fn: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !fn()) await new Promise((r) => setTimeout(r, 50));
  return fn();
}

const levelOf = async (userId: string, pageId: string) => (await resolvePageAccess(userId, pageId)).level;
const idsOf = (group: { members?: { value: string }[] }) => (group.members ?? []).map((m) => m.value).sort();
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

const userIds: string[] = [];
const workspaceIds: string[] = [];

async function signUp(who: string, email = `scim-${who}-${RUN}@example.test`) {
  const jar = new Jar();
  const res = await authPost("/sign-up/email", { name: `SCIM ${who}`, email, password: PASSWORD }, jar);
  check(res.status === 200, `sign up ${who}`, res.body);
  const session = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: jar.header() } }).then((r) => r.json());
  const id = (session as { user: { id: string } }).user.id;
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
  const owner = await signUp("owner");
  const workspaceId = owner.workspaceId!;
  const settingsPath = `/w/${workspaceId}/settings`;
  const SSO_ACTIONS = "src/app/actions/sso.ts";

  // A verified SSO domain, so SCIM may create accounts in it (the issuer's discovery is stubbed).
  const discover = async (issuer: string) => ({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/jwks`,
    tokenEndpointAuthentication: "client_secret_basic" as const,
  });
  await saveSsoConnection(
    owner.id,
    workspaceId,
    { protocol: "oidc", issuer: "https://idp.example.com", clientId: "c", clientSecret: "s", domains: DOMAIN },
    { discover },
  );
  const [sso] = await db.execute<{ token: string }>(
    (await import("drizzle-orm")).sql`select verification_token as token from workspace_sso where workspace_id = ${workspaceId}`,
  );
  await verifySsoDomains(owner.id, workspaceId, async (name) => (name === domainRecordName(DOMAIN) ? [[`leafdesk-sso=${sso.token}`]] : []));

  // ── Tokens ────────────────────────────────────────────────────────────────────────────────
  const page = await fetch(`${BASE}${settingsPath}?tab=security`, { headers: { cookie: owner.jar.header() } });
  const html = await page.text();
  check(page.status === 200 && html.includes("User provisioning (SCIM)"), "the owner's security settings show SCIM", page.status);
  const noName = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "createScimTokenAction", [workspaceId, "  "]);
  check(noName.text.includes('"error":"name"'), "a token needs a name", noName.text);
  const created = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "createScimTokenAction", [workspaceId, "Okta"]);
  const token = /"data":"(scim_[A-Za-z0-9]{40})"/.exec(created.text)?.[1];
  check(created.status === 200 && token, "the owner creates a SCIM token and sees its secret once", created.status);
  const [stored] = await db.select().from(scimToken).where(eq(scimToken.workspaceId, workspaceId));
  check(stored && stored.tokenHash !== token && !JSON.stringify(stored).includes(token), "only a hash of it is stored");

  const bystander = await signUp("bystander");
  const notOwner = await callAction(bystander.jar, settingsPath, SSO_ACTIONS, "createScimTokenAction", [workspaceId, "x"]);
  check(!notOwner.text.includes("scim_"), "someone else can't create one for the workspace", notOwner.text);

  const anonymous = await scim(null, "GET", "/Users");
  check(anonymous.status === 401 && anonymous.authenticate?.startsWith("Bearer"), "no token: 401 with WWW-Authenticate", anonymous);
  const wrong = await scim(`scim_${"x".repeat(40)}`, "GET", "/Users");
  check(wrong.status === 401 && wrong.body?.schemas?.[0]?.endsWith(":Error"), "a wrong token: 401 as a SCIM error", wrong.body);

  // ── Discovery ─────────────────────────────────────────────────────────────────────────────
  const config = await scim(token, "GET", "/ServiceProviderConfig");
  check(config.status === 200 && config.type.startsWith("application/scim+json") && config.body.patch.supported === true, "ServiceProviderConfig", config.body);
  const types = await scim(token, "GET", "/ResourceTypes");
  check(types.body?.Resources?.map((t: { id: string }) => t.id).join() === "User,Group", "ResourceTypes", types.body);
  check((await scim(token, "GET", "/Schemas/urn:nope")).status === 404, "an unknown schema is 404");
  const lastUsed = (await db.select({ at: scimToken.lastUsedAt }).from(scimToken).where(eq(scimToken.id, stored.id)))[0]?.at;
  check(lastUsed instanceof Date, "the token records when it was last used");

  // ── Users ─────────────────────────────────────────────────────────────────────────────────
  const listed = await scim(token, "GET", "/Users");
  check(listed.status === 200 && listed.body.totalResults === 1 && listed.body.Resources[0].userName === owner.email, "the list starts with the owner", listed.body);
  check(listed.body.Resources[0].active === true, "…who is active");

  const newEmail = `new.hire@${DOMAIN}`;
  const created1 = await scim(token, "POST", "/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: newEmail,
    externalId: "00u-new",
    name: { givenName: "New", familyName: "Hire" },
    emails: [{ value: newEmail, primary: true }],
    active: true,
  });
  check(created1.status === 201 && created1.location?.endsWith(`/scim/v2/Users/${created1.body?.id}`), "creating a user in the SSO domain answers 201 with its location", created1);
  userIds.push(created1.body.id);
  check(created1.body.externalId === "00u-new" && created1.body.name.formatted === "New Hire" && created1.body.active === true, "…with what was sent", created1.body);
  const [account] = await db.select().from(user).where(eq(user.id, created1.body.id));
  check(account?.email === newEmail && account.emailVerified === true, "…a new account, its address verified", account);
  check((await roleOf(workspaceId, account.id)) === "member", "…who is a member of the workspace");
  const [personal] = await db.select().from(workspaceMember).where(and(eq(workspaceMember.userId, account.id), eq(workspaceMember.role, "owner")));
  check(!personal, "…without a personal workspace");

  const duplicate = await scim(token, "POST", "/Users", { userName: newEmail.toUpperCase() });
  check(duplicate.status === 409 && duplicate.body.scimType === "uniqueness", "creating them again is a 409 uniqueness error", duplicate.body);
  const stranger = await scim(token, "POST", "/Users", { userName: `someone@other-${RUN}.test` });
  check(stranger.status === 400 && stranger.body.scimType === "invalidValue", "no account is created outside the SSO domains", stranger.body);
  const noEmail = await scim(token, "POST", "/Users", { userName: "just-a-name" });
  check(noEmail.status === 400, "a user needs an email address", noEmail.body);

  const existing = await scim(token, "POST", "/Users", { userName: bystander.email, name: { formatted: "Renamed By IdP" } });
  check(existing.status === 201 && existing.body.id === bystander.id, "an existing account outside the domain can be provisioned", existing.body);
  check((await roleOf(workspaceId, bystander.id)) === "member", "…and joins as a member");
  check(existing.body.displayName === `SCIM bystander`, "…but its name is its own outside the SSO domains", existing.body.displayName);

  const guest = await signUp("guest");
  await db.insert(workspaceMember).values({ workspaceId, userId: guest.id, role: "guest" });
  const guestListed = await scim(token, "GET", `/Users?filter=${encodeURIComponent(`userName eq "${guest.email}"`)}`);
  check(guestListed.body.totalResults === 0, "guests aren't listed", guestListed.body);
  const promoted = await scim(token, "POST", "/Users", { userName: guest.email });
  check(promoted.status === 201 && (await roleOf(workspaceId, guest.id)) === "member", "provisioning a guest makes them a member", promoted.body);

  const filtered = await scim(token, "GET", `/Users?filter=${encodeURIComponent(`userName eq "${newEmail.toUpperCase()}"`)}`);
  check(filtered.body.totalResults === 1 && filtered.body.Resources[0].id === account.id, "filter by userName (case-insensitive)", filtered.body);
  const byExternal = await scim(token, "GET", `/Users?filter=${encodeURIComponent('externalId eq "00u-new"')}`);
  check(byExternal.body.totalResults === 1, "filter by externalId", byExternal.body);
  const badFilter = await scim(token, "GET", `/Users?filter=${encodeURIComponent('userName co "new"')}`);
  check(badFilter.status === 400 && badFilter.body.scimType === "invalidFilter", "an unsupported filter is a 400, not everyone", badFilter.body);
  const paged = await scim(token, "GET", "/Users?startIndex=2&count=1");
  check(paged.body.totalResults === 4 && paged.body.Resources.length === 1 && paged.body.startIndex === 2, "paging with startIndex and count", paged.body);

  const one = await scim(token, "GET", `/Users/${account.id}`);
  check(one.status === 200 && one.body.userName === newEmail, "get one user", one.body);
  check((await scim(token, "GET", `/Users/${guest.id}x`)).status === 404, "an unknown user is 404");
  const outsider = await signUp("outsider");
  check((await scim(token, "GET", `/Users/${outsider.id}`)).status === 404, "people outside the workspace are 404");

  // Deactivating, the way Entra ID sends it.
  const off = await scim(token, "PATCH", `/Users/${account.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Replace", path: "active", value: "False" }],
  });
  check(off.status === 200 && off.body.active === false, "deactivating answers the user as inactive", off.body);
  check((await roleOf(workspaceId, account.id)) === null, "…and takes them out of the workspace");
  const stillListed = await scim(token, "GET", `/Users/${account.id}`);
  check(stillListed.status === 200 && stillListed.body.active === false, "…while the provider can still see them");
  check((await joinThroughSso(`ws-${workspaceId}`, { id: account.id, email: newEmail })) === false, "…and signing in with SSO doesn't bring them back");
  check((await roleOf(workspaceId, account.id)) === null, "…still out");

  const ownerOff = await scim(token, "PATCH", `/Users/${owner.id}`, { Operations: [{ op: "replace", value: { active: false } }] });
  check(ownerOff.status === 400 && ownerOff.body.scimType === "mutability", "owners can't be deactivated over SCIM", ownerOff.body);
  check((await roleOf(workspaceId, owner.id)) === "owner", "…and stay owners");

  const on = await scim(token, "PATCH", `/Users/${account.id}`, { Operations: [{ op: "replace", value: { active: true } }] });
  check(on.status === 200 && on.body.active === true && (await roleOf(workspaceId, account.id)) === "member", "reactivating brings them back as a member", on.body);

  const renamed = await scim(token, "PUT", `/Users/${account.id}`, {
    userName: newEmail,
    name: { givenName: "Newer", familyName: "Hire" },
    externalId: "00u-new",
    active: true,
  });
  check(renamed.status === 200 && renamed.body.displayName === "Newer Hire", "PUT renames someone in the SSO domain", renamed.body);
  const badPatch = await scim(token, "PATCH", `/Users/${account.id}`, { Operations: [{ op: "replace", path: "roles", value: "admin" }] });
  check(badPatch.status === 400 && badPatch.body.scimType === "invalidPath", "unsupported attributes are refused", badPatch.body);

  const deleted = await scim(token, "DELETE", `/Users/${account.id}`);
  check(deleted.status === 204, "deleting answers 204");
  check((await roleOf(workspaceId, account.id)) === null, "…takes them out of the workspace");
  check((await scim(token, "GET", `/Users/${account.id}`)).status === 404, "…and out of SCIM's view");
  const identity = await db.select().from(scimIdentity).where(eq(scimIdentity.userId, account.id));
  const [kept] = await db.select({ id: user.id }).from(user).where(eq(user.id, account.id));
  check(identity.length === 0 && kept, "…leaving the account itself (it may belong to other workspaces)");
  const ownerDelete = await scim(token, "DELETE", `/Users/${owner.id}`);
  check(ownerDelete.status === 400 && (await roleOf(workspaceId, owner.id)) === "owner", "owners can't be deleted over SCIM", ownerDelete.body);

  // ── Groups ────────────────────────────────────────────────────────────────────────────────
  // In the workspace now: the owner, and `bystander` and `guest` as members (provisioned above).
  const noGroups = await scim(token, "GET", "/Groups");
  check(noGroups.status === 200 && noGroups.body.totalResults === 0 && noGroups.body.Resources.length === 0, "/Groups starts empty", noGroups.body);
  const realGuest = await signUp("groupguest");
  await db.insert(workspaceMember).values({ workspaceId, userId: realGuest.id, role: "guest" });

  const design = await scim(token, "POST", "/Groups", {
    schemas: [GROUP],
    displayName: "Design",
    externalId: "00g-design",
    members: [{ value: bystander.id, display: "Bystander" }, { value: guest.id }],
  });
  const designId: string = design.body?.id;
  check(design.status === 201 && design.location?.endsWith(`/scim/v2/Groups/${designId}`), "creating a group answers 201 with its location", design);
  check(
    design.body.displayName === "Design" && design.body.externalId === "00g-design" && idsOf(design.body).join() === [bystander.id, guest.id].sort().join(),
    "…with its name, externalId and members",
    design.body,
  );
  check(design.body.members.every((m: { $ref: string; type: string }) => m.type === "User" && m.$ref.includes("/scim/v2/Users/")), "…members point at their users");
  const [designRow] = await db.select().from(memberGroup).where(eq(memberGroup.id, designId));
  check(designRow?.workspaceId === workspaceId && designRow.createdBy === owner.id, "…an ordinary member group, created on behalf of the oldest owner", designRow);
  check((await db.select().from(memberGroupMember).where(eq(memberGroupMember.groupId, designId))).length === 2, "…with both people in it");

  const takenName = await scim(token, "POST", "/Groups", { displayName: " design " });
  check(takenName.status === 409 && takenName.body.scimType === "uniqueness", "a name already taken (ignoring case) is a 409", takenName.body);
  const guestMember = await scim(token, "POST", "/Groups", { displayName: "With guest", members: [{ value: realGuest.id }] });
  check(guestMember.status === 400 && guestMember.body.scimType === "invalidValue" && guestMember.body.detail.includes(realGuest.id), "guests can't be members (400 invalidValue)", guestMember.body);
  const outsiderMember = await scim(token, "POST", "/Groups", { displayName: "With outsider", members: [{ value: outsider.id }] });
  check(outsiderMember.status === 400 && outsiderMember.body.scimType === "invalidValue", "…nor people outside the workspace", outsiderMember.body);
  const unknownMember = await scim(token, "POST", "/Groups", { displayName: "With nobody", members: [{ value: "no-such-user" }] });
  check(unknownMember.status === 400 && unknownMember.body.scimType === "invalidValue", "…nor unknown ids", unknownMember.body);
  const nested = await scim(token, "POST", "/Groups", { displayName: "Nested", members: [{ value: designId, type: "Group" }] });
  check(nested.status === 400, "…nor groups", nested.body);
  const unnamed = await scim(token, "POST", "/Groups", { members: [] });
  check(unnamed.status === 400 && unnamed.body.scimType === "invalidValue", "a group needs a displayName", unnamed.body);
  const refusedRows = await db.select().from(memberGroup).where(eq(memberGroup.workspaceId, workspaceId));
  check(refusedRows.length === 1, "…and refused requests create nothing", refusedRows.map((r) => r.name));

  const byName = await scim(token, "GET", `/Groups?filter=${encodeURIComponent('displayName eq "DESIGN"')}`);
  check(byName.status === 200 && byName.body.totalResults === 1 && byName.body.Resources[0].id === designId, "filter by displayName (as Okta looks groups up)", byName.body);
  const byExternalGroup = await scim(token, "GET", `/Groups?filter=${encodeURIComponent('externalId eq "00g-design"')}`);
  check(byExternalGroup.body.totalResults === 1, "filter by externalId", byExternalGroup.body);
  const lean = await scim(token, "GET", `/Groups?filter=${encodeURIComponent('displayName eq "Design"')}&excludedAttributes=members`);
  check(lean.body.totalResults === 1 && !("members" in lean.body.Resources[0]), "excludedAttributes=members leaves members out (as Entra ID asks)", lean.body);
  const missing = await scim(token, "GET", `/Groups?filter=${encodeURIComponent('displayName eq "Nope"')}`);
  check(missing.body.totalResults === 0, "no match is an empty list", missing.body);
  const badGroupFilter = await scim(token, "GET", `/Groups?filter=${encodeURIComponent('displayName co "Des"')}`);
  check(badGroupFilter.status === 400 && badGroupFilter.body.scimType === "invalidFilter", "an unsupported group filter is a 400", badGroupFilter.body);
  const gotDesign = await scim(token, "GET", `/Groups/${designId}`);
  check(gotDesign.status === 200 && idsOf(gotDesign.body).length === 2, "get one group", gotDesign.body);
  check(!("members" in (await scim(token, "GET", `/Groups/${designId}?excludedAttributes=members`)).body), "…without members when asked");
  check((await scim(token, "GET", `/Groups/${designId}x`)).status === 404, "an unknown group is 404");
  check((await scim(token, "POST", `/Groups/${designId}`, {})).status === 405, "POST on a group is 405");

  // A page only the group reaches, open live in the bystander's editor.
  const secret = await createPage({ userId: owner.id }, { workspaceId, title: `SCIM ${RUN} secret`, teamspaceId: null });
  await setPageGroupPermission(owner.id, secret.id, designId, "edit");
  check((await levelOf(bystander.id, secret.id)) === "edit", "the group gives its members a page");
  const live = await connect(bystander.jar, `page:${secret.id}`);
  check(live.outcome === "synced", "…which the bystander has open live", live.outcome);
  const stays = await connect(guest.jar, `page:${secret.id}`);
  check(stays.outcome === "synced", "…and so does another member of the group", stays.outcome);

  // Okta: remove one member by a filter path.
  const oktaRemove = await scim(token, "PATCH", `/Groups/${designId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "remove", path: `members[value eq "${bystander.id}"]` }],
  });
  check(oktaRemove.status === 200 && idsOf(oktaRemove.body).join() === guest.id, "Okta-style remove by members[value eq …]", oktaRemove.body);
  check((await levelOf(bystander.id, secret.id)) === "none", "…takes away what the group gave");
  check(await eventually(() => live.closes.length > 0), "…and closes their open editor on it", live.closes);
  check(stays.closes.length === 0, "…but not the editor of someone still in the group", stays.closes);

  // Okta: add members, rename with a path-less replace.
  const oktaAdd = await scim(token, "PATCH", `/Groups/${designId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "add", path: "members", value: [{ value: bystander.id, display: "Bystander" }, { value: guest.id }] }],
  });
  check(oktaAdd.status === 200 && idsOf(oktaAdd.body).join() === [bystander.id, guest.id].sort().join(), "Okta-style add (people already in stay)", oktaAdd.body);
  check((await levelOf(bystander.id, secret.id)) === "edit", "…gives the page back");
  const oktaRename = await scim(token, "PATCH", `/Groups/${designId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", value: { id: designId, displayName: "Product Design" } }],
  });
  check(oktaRename.status === 200 && oktaRename.body.displayName === "Product Design" && idsOf(oktaRename.body).length === 2, "Okta-style rename", oktaRename.body);

  // Entra ID: capitalised ops, add and remove by value in one request, displayName and externalId paths.
  const entraMembers = await scim(token, "PATCH", `/Groups/${designId}`, {
    schemas: [PATCH_OP],
    Operations: [
      { op: "Add", path: "members", value: [{ value: owner.id }] },
      { op: "Remove", path: "members", value: [{ value: guest.id }] },
    ],
  });
  check(entraMembers.status === 200 && idsOf(entraMembers.body).join() === [bystander.id, owner.id].sort().join(), "Entra ID-style Add and Remove by value", entraMembers.body);
  const entraRename = await scim(token, "PATCH", `/Groups/${designId}`, {
    schemas: [PATCH_OP],
    Operations: [
      { op: "Replace", path: "displayName", value: "Designers" },
      { op: "Replace", path: "externalId", value: "aad-designers" },
    ],
  });
  check(entraRename.body.displayName === "Designers" && entraRename.body.externalId === "aad-designers", "Entra ID-style rename and externalId", entraRename.body);
  const [renamedRow] = await db.select({ name: memberGroup.name }).from(memberGroup).where(eq(memberGroup.id, designId));
  check(renamedRow?.name === "Designers", "…the app's group is renamed");

  const guestAdd = await scim(token, "PATCH", `/Groups/${designId}`, {
    Operations: [
      { op: "add", path: "members", value: [{ value: guest.id }] },
      { op: "add", path: "members", value: [{ value: realGuest.id }] },
    ],
  });
  check(guestAdd.status === 400 && guestAdd.body.scimType === "invalidValue", "adding a guest is a 400 invalidValue", guestAdd.body);
  check(idsOf((await scim(token, "GET", `/Groups/${designId}`)).body).join() === [bystander.id, owner.id].sort().join(), "…and the rest of that request isn't applied");
  const badPath = await scim(token, "PATCH", `/Groups/${designId}`, { Operations: [{ op: "replace", path: "owners", value: [] }] });
  check(badPath.status === 400 && badPath.body.scimType === "invalidPath", "unsupported group attributes are refused", badPath.body);

  const support = await scim(token, "POST", "/Groups", { displayName: "Support" });
  check(support.status === 201 && idsOf(support.body).length === 0 && Array.isArray(support.body.members), "a group without members", support.body);
  const clash = await scim(token, "PATCH", `/Groups/${designId}`, { Operations: [{ op: "replace", path: "displayName", value: "SUPPORT" }] });
  check(clash.status === 409 && clash.body.scimType === "uniqueness", "renaming onto another group's name is a 409", clash.body);

  const put = await scim(token, "PUT", `/Groups/${designId}`, { schemas: [GROUP], displayName: "Design", members: [{ value: guest.id }] });
  check(put.status === 200 && put.body.displayName === "Design" && idsOf(put.body).join() === guest.id, "PUT replaces the name and members", put.body);
  check(put.body.externalId === "aad-designers", "…keeping an externalId it leaves out", put.body);
  check((await levelOf(bystander.id, secret.id)) === "none", "…and whoever left loses the page");
  const putKeep = await scim(token, "PUT", `/Groups/${designId}`, { displayName: "Design" });
  check(putKeep.status === 200 && idsOf(putKeep.body).join() === guest.id, "a PUT without members leaves them as they are", putKeep.body);

  const appGroup = await createGroup(owner.id, workspaceId, "Made in the app", [bystander.id]);
  const all = await scim(token, "GET", "/Groups");
  check(all.body.totalResults === 3 && all.body.Resources.some((g: { id: string }) => g.id === appGroup.id), "groups made in the app are listed too", all.body);
  const groupPage = await scim(token, "GET", "/Groups?startIndex=2&count=1");
  check(groupPage.body.totalResults === 3 && groupPage.body.Resources.length === 1 && groupPage.body.startIndex === 2, "paging groups", groupPage.body);

  const groupsHtml = await (await fetch(`${BASE}${settingsPath}?tab=groups`, { headers: { cookie: owner.jar.header() } })).text();
  check(
    (groupsHtml.match(/data-group-provisioned/g) ?? []).length === 2 && groupsHtml.includes("From your identity provider"),
    "Settings > Groups marks the two provisioned groups",
  );

  // Pages only a deleted group could manage pass to the oldest owner, not to a newer one.
  const owner2 = await signUp("owner2");
  await db.insert(workspaceMember).values({ workspaceId, userId: owner2.id, role: "owner" });
  const solo = await createPage({ userId: owner.id }, { workspaceId, title: `SCIM ${RUN} solo`, teamspaceId: null });
  await setPageGroupPermission(owner.id, solo.id, designId, "full");
  await removePagePermission(owner.id, solo.id, owner.id);
  check((await levelOf(owner.id, solo.id)) === "none" && (await levelOf(guest.id, solo.id)) === "full", "a page only the group can manage");
  const removedGroup = await scim(token, "DELETE", `/Groups/${designId}`);
  check(removedGroup.status === 204, "deleting a group answers 204", removedGroup);
  check((await scim(token, "GET", `/Groups/${designId}`)).status === 404, "…it is gone");
  check(
    (await db.select().from(memberGroup).where(eq(memberGroup.id, designId))).length === 0 &&
      (await db.select().from(scimGroup).where(eq(scimGroup.groupId, designId))).length === 0,
    "…from the app too, with its SCIM record",
  );
  check((await levelOf(owner.id, solo.id)) === "full" && (await levelOf(owner2.id, solo.id)) === "none", "…and its page passes to the oldest owner");
  check((await levelOf(guest.id, solo.id)) === "none", "…while its members lose it");

  // ── One workspace per token, and revoking ─────────────────────────────────────────────────
  const otherToken = /"data":"(scim_[A-Za-z0-9]{40})"/.exec(
    (
      await callAction(outsider.jar, `/w/${outsider.workspaceId}/settings`, SSO_ACTIONS, "createScimTokenAction", [
        outsider.workspaceId,
        "Other",
      ])
    ).text,
  )?.[1];
  check(otherToken, "another owner creates a token for their workspace");
  const supportId: string = support.body.id;
  const otherGroups = await scim(otherToken, "GET", "/Groups");
  check(otherGroups.status === 200 && otherGroups.body.totalResults === 0, "…which lists none of this workspace's groups", otherGroups.body);
  const otherFilter = await scim(otherToken, "GET", `/Groups?filter=${encodeURIComponent('displayName eq "Support"')}`);
  check(otherFilter.body.totalResults === 0, "…nor finds them by name", otherFilter.body);
  check((await scim(otherToken, "GET", `/Groups/${supportId}`)).status === 404, "…nor by id");
  const otherPatch = await scim(otherToken, "PATCH", `/Groups/${supportId}`, { Operations: [{ op: "add", path: "members", value: [{ value: outsider.id }] }] });
  const otherPut = await scim(otherToken, "PUT", `/Groups/${supportId}`, { displayName: "Hijacked" });
  const otherDelete = await scim(otherToken, "DELETE", `/Groups/${supportId}`);
  check(otherPatch.status === 404 && otherPut.status === 404 && otherDelete.status === 404, "…and can't change or delete them", [otherPatch.status, otherPut.status, otherDelete.status]);
  const supportAfter = await scim(token, "GET", `/Groups/${supportId}`);
  check(supportAfter.status === 200 && supportAfter.body.displayName === "Support" && idsOf(supportAfter.body).length === 0, "…which stay as they were", supportAfter.body);
  const otherMembers = await scim(otherToken, "POST", "/Groups", { displayName: "Theirs", members: [{ value: bystander.id }] });
  check(otherMembers.status === 400 && otherMembers.body.scimType === "invalidValue", "…nor put this workspace's people in its own groups", otherMembers.body);
  const otherList = await scim(otherToken, "GET", "/Users");
  check(otherList.body.totalResults === 1 && otherList.body.Resources[0].id === outsider.id, "…which sees only that workspace", otherList.body);
  check((await scim(otherToken, "GET", `/Users/${owner.id}`)).status === 404, "…and not this one's people");

  const revoked = await callAction(owner.jar, settingsPath, SSO_ACTIONS, "revokeScimTokenAction", [workspaceId, stored.id]);
  check(revoked.text.includes('"ok":true'), "the owner revokes the token", revoked.text);
  check((await scim(token, "GET", "/Users")).status === 401, "…which stops working at once");

  console.log(`\n${passed} checks passed`);
}

try {
  await main();
} finally {
  for (const provider of connections) provider.destroy();
  const byRun = await db
    .select({ id: user.id })
    .from(user)
    .where(or(ilike(user.email, `%@${DOMAIN}`), ilike(user.email, `%-${RUN}@%`)));
  const ids = [...new Set([...userIds, ...byRun.map((u) => u.id)])];
  if (workspaceIds.length) await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  if (ids.length) await db.delete(user).where(inArray(user.id, ids));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
