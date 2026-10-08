/**
 * End-to-end check of the ways around the workspaces' sign-in policies and the account checks
 * that keep one person from taking another's place, against a running app:
 *
 * - an Authorization header alone doesn't take a held-back browser session out of the policy
 *   (files, server actions);
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

const { randomBytes } = await import("node:crypto");
const { existsSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const files = await import("@/server/files");
const { createApiToken } = await import("@/server/api/tokens");

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

// ---------------------------------------------------------------------------- run

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
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

  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: ws, name: `${RUN} Strict` },
    { id: open, name: `${RUN} Open` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: open, userId: ids.member, role: "owner" },
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

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(`\n${passed} checks passed before the failure.`);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Deleting the users drops their sessions and tokens; the workspaces take their pages and files along.
  await db.delete(workspace).where(inArray(workspace.id, [ws, open]));
  await db.delete(user).where(inArray(user.id, userIds));
  await files.removeStored(storageKeys);
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
