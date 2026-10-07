/**
 * End-to-end check of instance administrators (ADMIN_EMAILS) against a running app: the /admin
 * page and its actions refused to everyone else (signed out, unlisted, or listed with an
 * unverified address), the list and its search, WORKSPACE_CREATION, signing one account or
 * everyone out (their live collaboration connections too), and "require a new password": the
 * next password sign-in gets no session, the new password is chosen by the emailed link (SMTP) or
 * the sign-in page's own step (no SMTP; with a two-step code when the account has one), the old
 * password can't be chosen again, accounts without a password are left alone, and any password
 * change clears the requirement. Creates its own @example.test users and deletes them afterwards.
 *
 * It signs out every session on the server and briefly flags every account with a password (the
 * flags of accounts it didn't create are put back): run it against a development or CI database.
 *
 *   ADMIN_EMAILS=Admin-E2E@Example.test APP_URL=http://localhost:3106 pnpm tsx scripts/admin-e2e.ts
 *
 * The server must run with the same ADMIN_EMAILS (listing admin-e2e@example.test, in any case) and
 * WORKSPACE_CREATION as this script; the policy the server runs with is checked over HTTP, the
 * other one against the database. Server actions are called by id, from the running app's build
 * output (`.next`, or NEXT_DIR), so run this from the checkout the app runs from.
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL (read from .env when present),
 * ADMIN_EMAILS, WORKSPACE_CREATION, and the SMTP settings the server uses (SMTP_URL or SMTP_HOST:
 * the emailed link; neither: the in-app step).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, like, notInArray, sql } = await import("drizzle-orm");
const Y = await import("yjs");
const { HocuspocusProvider } = await import("@hocuspocus/provider");
const { db } = await import("@/db");
const { account, session, user, verification, workspace, workspaceMember } = await import("@/db/schema");
const { adminEmailsFrom, workspaceCreationFrom } = await import("@/lib/instance-admin");
const { totpCode, totpKeyFromUri } = await import("@/lib/totp");
const { createWorkspace, WorkspaceError } = await import("@/server/workspaces");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RUN = Date.now().toString(36);
const PASSWORD = "admin-e2e-123";
const NEW_PASSWORD = "admin-e2e-456";
/** Fixed, so ADMIN_EMAILS can name it; a leftover of an aborted run is removed first. */
const ADMIN_EMAIL = "admin-e2e@example.test";
const emailOf = (who: string) => `admin-${who}-${RUN}@example.test`;
const POLICY = workspaceCreationFrom(process.env.WORKSPACE_CREATION);
const EMAIL_RESET = Boolean(process.env.SMTP_URL || process.env.SMTP_HOST);

const ADMIN_ACTIONS = "src/app/actions/admin.ts";
const ACCOUNT_ACTIONS = "src/app/actions/account.ts";
const WS_ACTIONS = "src/app/actions/workspaces.ts";

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
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * Production builds rate limit sign-up and sign-in (3 per 10 s per IP, rolling), and in CI this run
 * follows the other e2e scripts' sign-ups; wait out a 429 instead of failing on it.
 */
async function authPost(path: string, body: unknown, jar: Jar) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("x-retry-after") ?? res.headers.get("retry-after") ?? 0);
      await new Promise((r) => setTimeout(r, (retryAfter || 10) * 1000 + 250));
      continue;
    }
    jar.store(res);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
}

async function sessionOf(jar: Jar) {
  const res = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: jar.header() } });
  return (await res.json().catch(() => null)) as { user: { id: string }; session: { id: string } } | null;
}

/** An app page as a browser would open it, without following redirects. */
async function open(path: string, jar: Jar) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: jar.header(), accept: "text/html" }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

/** The id of a server action, from the running app's server reference manifests. */
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

/**
 * Calls a server action as the browser does, posting to `path` (a page whose bundle has the
 * action). Returns `ok` and the error code of the action's result; `status` 500 when it threw.
 */
async function action(jar: Jar, path: string, file: string, name: string, args: unknown[] = []) {
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
  jar.store(res);
  const text = await res.text();
  return {
    status: res.status,
    text,
    ok: res.status === 200 && text.includes('"ok":true'),
    code: /"code":"(\w+)"/.exec(text)?.[1] ?? null,
  };
}
const admin_ = (jar: Jar, name: string, args: unknown[] = []) => action(jar, "/sign-in", ADMIN_ACTIONS, name, args);

const userIds: string[] = [];
const workspaceIds: string[] = [];

async function signUp(email: string, name: string) {
  const jar = new Jar();
  const res = await authPost("/sign-up/email", { name, email, password: PASSWORD }, jar);
  check(res.status === 200, `sign up ${name}`, res.body);
  const id = (await sessionOf(jar))!.user.id;
  userIds.push(id);
  const [personal] = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, id));
  if (personal) workspaceIds.push(personal.id);
  return { jar, id, email, workspaceId: personal?.id };
}

async function signIn(email: string, password: string, jar = new Jar()) {
  const res = await authPost("/sign-in/email", { email, password }, jar);
  return { ...res, jar };
}

const liveSessions = async (userId: string) =>
  (await db.select({ id: session.id }).from(session).where(eq(session.userId, userId))).length;
const flagOf = async (userId: string) =>
  (await db.select({ flag: user.passwordResetRequired }).from(user).where(eq(user.id, userId)))[0]?.flag === true;

/** A code the app would show right now; waits out the last seconds of a period so it stays valid. */
async function codeFor(key: Uint8Array) {
  if (Date.now() % 30_000 > 27_000) await new Promise((r) => setTimeout(r, 3_500));
  return totpCode(key);
}

/** A browser tab listening to a workspace's live signals, signed in with `jar`. */
async function openLive(workspaceId: string, jar: Jar) {
  const res = await fetch(`${BASE}/api/collab-token`, { headers: { cookie: jar.header() } });
  const { token, build } = (await res.json()) as { token: string; build?: string | null };
  const closes: number[] = [];
  const provider = new HocuspocusProvider({
    // A production server refuses a tab that names no build (lib/build-id); this one runs the server's.
    url: `${BASE.replace(/^http/, "ws")}/collab${build ? `?build=${encodeURIComponent(build)}` : ""}`,
    name: `ws:${workspaceId}`,
    document: new Y.Doc(),
    token,
    onClose: ({ event }) => void closes.push(event.code),
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the live connection never synced")), 10_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { provider, closes };
}
async function waitFor(condition: () => boolean, ms = 5_000) {
  for (let waited = 0; waited < ms && !condition(); waited += 50) await new Promise((r) => setTimeout(r, 50));
  return condition();
}

/** Turns the account into one that only signs in with GitHub: no password, a linked provider. */
async function makeSocialOnly(userId: string) {
  await db.delete(account).where(and(eq(account.userId, userId), eq(account.providerId, "credential")));
  const now = new Date();
  await db.insert(account).values({
    id: `admin-e2e-${RUN}-${userId}`,
    accountId: `gh-${RUN}-${userId}`,
    providerId: "github",
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

/** Chooses the new password the way this server offers it, after a refused sign-in. */
async function chooseNewPassword(email: string, refused: { status: number; body: any }, who: string, code?: () => Promise<string>) {
  if (EMAIL_RESET) {
    check(refused.body?.delivery === "email" && !refused.body?.resetToken, `${who}: the reset link goes out by email`, refused.body);
    const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    const links = await db
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(and(like(verification.identifier, "reset-password:%"), eq(verification.value, owner.id)));
    check(links.length === 1, `${who}: …one link`, links);
    const again = await signIn(email, PASSWORD);
    const linksAfter = await db
      .select({ id: verification.id })
      .from(verification)
      .where(and(like(verification.identifier, "reset-password:%"), eq(verification.value, owner.id)));
    check(again.status === 403 && linksAfter.length === 1, `${who}: signing in again moments later sends no second link`, linksAfter);
    const token = links[0].identifier.slice("reset-password:".length);
    const same = await authPost("/reset-password", { token, newPassword: PASSWORD }, new Jar());
    check(same.status === 400 && same.body?.code === "PASSWORD_UNCHANGED", `${who}: the link won't set the old password again`, same);
    const reset = await authPost("/reset-password", { token, newPassword: NEW_PASSWORD }, new Jar());
    check(reset.status === 200, `${who}: the link sets a new one`, reset);
    const [row] = await db.select({ verified: user.emailVerified }).from(user).where(eq(user.id, owner.id));
    check(row.verified === true, `${who}: …which proves the address`, row);
    return;
  }
  check(refused.body?.delivery === "in-app" && typeof refused.body?.resetToken === "string", `${who}: the sign-in page asks for the new password itself`, refused.body);
  const token = refused.body.resetToken as string;
  const finish = (args: Record<string, unknown>) => action(new Jar(), "/sign-in", ACCOUNT_ACTIONS, "finishRequiredPasswordResetAction", [args]);
  const bogus = await finish({ token: "not-the-token", newPassword: NEW_PASSWORD });
  check(!bogus.ok && bogus.code === "resetStepExpired", `${who}: a made-up token is refused`, bogus);
  const same = await finish({ token, newPassword: PASSWORD, code: code ? await code() : undefined });
  check(!same.ok && same.code === "samePassword", `${who}: the old password can't be chosen again`, same);
  if (code) {
    check(refused.body.twoFactor === true, `${who}: the step says it needs a two-step code`, refused.body);
    const missing = await finish({ token, newPassword: NEW_PASSWORD });
    check(!missing.ok && missing.code === "proofRequired", `${who}: …and asks for it`, missing);
    const current = await code();
    const wrong = await finish({ token, newPassword: NEW_PASSWORD, code: current === "000000" ? "111111" : "000000" });
    check(!wrong.ok && wrong.code === "invalidCode", `${who}: …a wrong code is refused`, wrong);
  } else {
    check(refused.body.twoFactor === false, `${who}: no two-step code needed`, refused.body);
  }
  const done = await finish({ token, newPassword: NEW_PASSWORD, code: code ? await code() : undefined });
  check(done.ok, `${who}: the new password is set`, done);
  const reused = await finish({ token, newPassword: `${NEW_PASSWORD}-2`, code: code ? await code() : undefined });
  check(!reused.ok && reused.code === "resetStepExpired", `${who}: the step works once`, reused);
}

async function main() {
  check(adminEmailsFrom(process.env.ADMIN_EMAILS).has(ADMIN_EMAIL), `ADMIN_EMAILS lists ${ADMIN_EMAIL} (set it for the server too)`, process.env.ADMIN_EMAILS);
  console.log(`(workspace creation: ${POLICY}; required password resets: ${EMAIL_RESET ? "by email" : "in the app"})`);

  // A leftover admin of an aborted run, with the workspaces only it is in.
  const [leftover] = await db.select({ id: user.id }).from(user).where(eq(user.email, ADMIN_EMAIL));
  if (leftover) {
    const own = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, leftover.id));
    if (own.length) await db.delete(workspace).where(inArray(workspace.id, own.map((w) => w.id)));
    await db.delete(user).where(eq(user.id, leftover.id));
  }
  // Accounts this run didn't create keep their flag: put back afterwards.
  const flaggedBefore = new Set(
    (await db.select({ id: user.id }).from(user).where(eq(user.passwordResetRequired, true))).map((u) => u.id),
  );

  const admin = await signUp(ADMIN_EMAIL, "Admin");
  const bob = await signUp(emailOf("bob"), "Bob");
  const carol = await signUp(emailOf("carol"), "Carol");
  const dave = await signUp(emailOf("dave"), "Dave");
  const erin = await signUp(emailOf("erin"), "Erin");
  await makeSocialOnly(erin.id);
  // Pages whose bundles hold the actions.
  check((await open("/sign-in", new Jar())).status === 200, "the sign-in page opens");
  check((await open(`/w/${bob.workspaceId}`, bob.jar)).status === 200, "Bob opens his workspace");

  // ── Refused: unverified admin address, other accounts, nobody signed in ─────────────────────
  const unverified = await open("/admin", admin.jar);
  check(unverified.status === 404, "the admin address, not yet verified, gets a 404 for /admin", unverified.status);
  const unverifiedAction = await admin_(admin.jar, "signOutEveryoneAction");
  check(!unverifiedAction.ok && unverifiedAction.code === "notFound", "…and its actions do nothing", unverifiedAction);
  check((await liveSessions(bob.id)) === 1, "…Bob is still signed in");

  const verified = execFileSync("pnpm", ["-s", "auth:verify-email", "ADMIN-e2e@example.test"], { encoding: "utf8" });
  check(/instance administrator/.test(verified), "`pnpm auth:verify-email` verifies the admin address", verified);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, bob.id));
  const page = await open("/admin", admin.jar);
  check(page.status === 200 && page.text.includes(bob.email) && page.text.includes(carol.email), "once verified, /admin opens and lists the accounts", page.status);
  const search = await open(`/admin?q=${encodeURIComponent(`bob-${RUN}`)}`, admin.jar);
  check(search.status === 200 && search.text.includes(bob.email) && !search.text.includes(carol.email), "…and searches them", search.status);
  const wildcard = await open(`/admin?q=${encodeURIComponent("%")}`, admin.jar);
  check(wildcard.status === 200 && !wildcard.text.includes(bob.email), "…taking % literally", wildcard.status);

  check((await open("/admin", new Jar())).status === 404, "signed out, /admin is a 404");
  check((await open("/admin", bob.jar)).status === 404, "Bob, verified but not listed, gets a 404");
  check((await open("/admin", carol.jar)).status === 404, "Carol, unverified, gets a 404");
  for (const [name, args] of [
    ["signOutUserAction", [carol.id]],
    ["signOutEveryoneAction", []],
    ["requirePasswordResetAction", [carol.id]],
    ["requirePasswordResetForEveryoneAction", []],
  ] as const) {
    const refused = await admin_(bob.jar, name, [...args]);
    check(!refused.ok && refused.code === "notFound", `Bob can't call ${name}`, refused);
    const anonymous = await admin_(new Jar(), name, [...args]);
    check(!anonymous.ok && anonymous.code === "notFound", `…nor can someone signed out`, anonymous);
  }
  check((await liveSessions(carol.id)) === 1 && !(await flagOf(carol.id)), "…Carol is still signed in, nothing required of her");
  const betterAuthAdmin = await authPost("/admin/list-users", {}, admin.jar);
  check(betterAuthAdmin.status === 404, "Better Auth's admin endpoints don't exist", betterAuthAdmin.status);

  // ── Workspace creation ─────────────────────────────────────────────────────────────────────
  const home = `/w/${bob.workspaceId}`;
  const bobCreates = await action(bob.jar, home, WS_ACTIONS, "createWorkspaceAction", [`Bob's ${RUN}`]);
  const adminCreates = await action(admin.jar, home, WS_ACTIONS, "createWorkspaceAction", [`Admin's ${RUN}`]);
  const created = await db.select({ id: workspace.id, name: workspace.name }).from(workspace).where(like(workspace.name, `%'s ${RUN}`));
  workspaceIds.push(...created.map((w) => w.id));
  check(adminCreates.ok && created.some((w) => w.name === `Admin's ${RUN}`), "an admin creates a workspace", adminCreates);
  const bobHome = await open(home, bob.jar);
  const adminHome = await open(`/w/${admin.workspaceId}`, admin.jar);
  if (POLICY === "admins") {
    check(!bobCreates.ok && !created.some((w) => w.name === `Bob's ${RUN}`), "with WORKSPACE_CREATION=admins, Bob can't", bobCreates);
    check(/canCreateWorkspace\\?":false/.test(bobHome.text), "…and his menu has no New workspace", bobHome.status);
  } else {
    check(bobCreates.ok && created.some((w) => w.name === `Bob's ${RUN}`), "with WORKSPACE_CREATION=everyone, Bob can too", bobCreates);
    check(/canCreateWorkspace\\?":true/.test(bobHome.text), "…from his menu", bobHome.status);
  }
  check(/canCreateWorkspace\\?":true/.test(adminHome.text) && /isInstanceAdmin\\?":true/.test(adminHome.text), "the admin's menu has New workspace and the admin page", adminHome.status);
  check(/isInstanceAdmin\\?":false/.test(bobHome.text), "…Bob's has no admin page", bobHome.status);
  const frank = await signUp(emailOf("frank"), "Frank");
  check(Boolean(frank.workspaceId), "a new account still gets its personal workspace");
  // The other policy, in this process (the server's is fixed for its run).
  const saved = process.env.WORKSPACE_CREATION;
  try {
    process.env.WORKSPACE_CREATION = "admins";
    const refused = await createWorkspace(bob.id, `Direct ${RUN}`).catch((error: unknown) => error);
    check(refused instanceof WorkspaceError && refused.code === "creationRestricted", "createWorkspace itself refuses non-admins with `admins`", refused);
    const byAdmin = await createWorkspace(admin.id, `Direct admin ${RUN}`);
    workspaceIds.push(byAdmin.id);
    check(byAdmin.id, "…not the admin");
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, admin.id));
    const unverifiedAdmin = await createWorkspace(admin.id, `Direct unverified ${RUN}`).catch((error: unknown) => error);
    check(unverifiedAdmin instanceof WorkspaceError, "…nor an admin address that isn't verified", unverifiedAdmin);
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.id));
    process.env.WORKSPACE_CREATION = "everyone";
    const open_ = await createWorkspace(bob.id, `Direct everyone ${RUN}`);
    workspaceIds.push(open_.id);
    check(open_.id, "with `everyone` anyone can");
  } finally {
    if (saved === undefined) delete process.env.WORKSPACE_CREATION;
    else process.env.WORKSPACE_CREATION = saved;
  }

  // ── Signing one account out ────────────────────────────────────────────────────────────────
  const bobPhone = await signIn(bob.email, PASSWORD);
  check(bobPhone.status === 200 && (await liveSessions(bob.id)) === 2, "Bob is signed in on two devices");
  const live = await openLive(bob.workspaceId!, bob.jar);
  const bystander = await openLive(carol.workspaceId!, carol.jar);
  const signedOut = await admin_(admin.jar, "signOutUserAction", [bob.id]);
  check(signedOut.ok && (await liveSessions(bob.id)) === 0, "the admin signs Bob out everywhere", signedOut);
  check(!(await sessionOf(bob.jar)) && !(await sessionOf(bobPhone.jar)), "…both of his devices are signed out");
  check(await waitFor(() => live.closes.length > 0), "…and his live connection is closed", live.closes);
  live.provider.destroy();
  check(bystander.closes.length === 0, "…Carol's stays open", bystander.closes);
  bystander.provider.destroy();
  check((await sessionOf(carol.jar)) !== null && (await sessionOf(admin.jar)) !== null, "…Carol and the admin are still signed in");
  const unknown = await admin_(admin.jar, "signOutUserAction", ["no-such-user"]);
  check(!unknown.ok && unknown.code === "notFound", "an unknown account is reported", unknown);
  const adminPhone = await signIn(ADMIN_EMAIL, PASSWORD);
  const self = await admin_(admin.jar, "signOutUserAction", [admin.id]);
  check(self.ok && !(await sessionOf(adminPhone.jar)) && (await sessionOf(admin.jar)) !== null, "signing out themselves keeps the admin's own browser", self);

  // ── Signing everyone out ───────────────────────────────────────────────────────────────────
  const bobAgain = await signIn(bob.email, PASSWORD);
  const adminPhone2 = await signIn(ADMIN_EMAIL, PASSWORD);
  const carolLive = await openLive(carol.workspaceId!, carol.jar);
  const everyone = await admin_(admin.jar, "signOutEveryoneAction");
  check(everyone.ok, "the admin signs everyone out", everyone);
  const [{ left }] = await db.select({ left: sql<number>`count(*)::int` }).from(session);
  check(left === 1 && (await sessionOf(admin.jar)) !== null, "…only the admin's own session is left on the server", left);
  check(!(await sessionOf(bobAgain.jar)) && !(await sessionOf(carol.jar)) && !(await sessionOf(adminPhone2.jar)), "…Bob, Carol and the admin's other device are out");
  check(await waitFor(() => carolLive.closes.length > 0), "…and Carol's live connection is closed", carolLive.closes);
  carolLive.provider.destroy();

  // ── Requiring a new password ───────────────────────────────────────────────────────────────
  const carolBack = await signIn(carol.email, PASSWORD);
  check(carolBack.status === 200, "Carol signs in again");
  const carolTab = await openLive(carol.workspaceId!, carolBack.jar);
  const required = await admin_(admin.jar, "requirePasswordResetAction", [carol.id]);
  check(required.ok && (await flagOf(carol.id)), "the admin requires a new password of Carol", required);
  check((await liveSessions(carol.id)) === 0 && !(await sessionOf(carolBack.jar)), "…which signs her out", await liveSessions(carol.id));
  check(await waitFor(() => carolTab.closes.length > 0), "…live connection included", carolTab.closes);
  carolTab.provider.destroy();
  const ssoOnly = await admin_(admin.jar, "requirePasswordResetAction", [erin.id]);
  check(!ssoOnly.ok && ssoOnly.code === "noPassword" && !(await flagOf(erin.id)), "an account without a password is left alone", ssoOnly);
  const ownReset = await admin_(admin.jar, "requirePasswordResetAction", [admin.id]);
  check(!ownReset.ok && ownReset.code === "self", "the admin changes their own on the account page instead", ownReset);
  const listed = await open(`/admin?q=${encodeURIComponent(carol.email)}`, admin.jar);
  check(listed.text.includes("New one required"), "the list shows the pending requirement", listed.status);

  const refused = await signIn(carol.email, PASSWORD);
  check(refused.status === 403 && refused.body?.code === "PASSWORD_RESET_REQUIRED", "Carol's password sign-in is refused", refused);
  check(!(await sessionOf(refused.jar)) && (await liveSessions(carol.id)) === 0, "…without a session");
  const wrong = await signIn(carol.email, "not-her-password");
  check(wrong.status === 401 && wrong.body?.code !== "PASSWORD_RESET_REQUIRED", "a wrong password learns nothing about it", wrong);
  await chooseNewPassword(carol.email, refused, "Carol");
  check(!(await flagOf(carol.id)), "the requirement is cleared");
  check((await signIn(carol.email, PASSWORD)).status === 401, "the old password no longer works");
  const carolNew = await signIn(carol.email, NEW_PASSWORD);
  check(carolNew.status === 200 && (await sessionOf(carolNew.jar)) !== null, "the new one signs her in");

  // Two-step verification: the in-app step also asks for a code.
  const daveIn = await signIn(dave.email, PASSWORD);
  const enable = await authPost("/two-factor/enable", { password: PASSWORD }, daveIn.jar);
  const key = totpKeyFromUri(enable.body.totpURI);
  const turnedOn = await authPost("/two-factor/verify-totp", { code: await codeFor(key) }, daveIn.jar);
  check(turnedOn.status === 200, "Dave turns on two-step verification", turnedOn.body);
  check((await admin_(admin.jar, "requirePasswordResetAction", [dave.id])).ok, "the admin requires a new password of Dave");
  const daveRefused = await signIn(dave.email, PASSWORD);
  check(daveRefused.status === 403 && daveRefused.body?.code === "PASSWORD_RESET_REQUIRED", "Dave's sign-in is refused before the code step", daveRefused.body);
  await chooseNewPassword(dave.email, daveRefused, "Dave", () => codeFor(key));
  const daveNew = await signIn(dave.email, NEW_PASSWORD);
  check(daveNew.status === 200 && daveNew.body?.twoFactorRedirect === true, "Dave signs in with the new password, then the code as always", daveNew.body);

  // Any password change clears it: from a session signed in some other way (GitHub, a passkey).
  const bobIn = await signIn(bob.email, PASSWORD);
  await db.update(user).set({ passwordResetRequired: true }).where(eq(user.id, bob.id));
  // Someone with a workspace is sent on to its Settings, where the account's tabs live.
  const bobPage = await open("/account?tab=security", bobIn.jar);
  const bobOpened = bobPage.status === 307 && bobPage.location?.includes("/settings?tab=accountSecurity") ? await open(bobPage.location, bobIn.jar) : bobPage;
  check(bobOpened.status === 200, "Bob opens his account page", bobPage.status);
  const changed = await action(bobIn.jar, "/account", ACCOUNT_ACTIONS, "changePasswordAction", [
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOthers: false },
  ]);
  check(changed.ok && !(await flagOf(bob.id)), "changing the password on the account page clears the requirement", changed);

  // ── Everyone with a password ───────────────────────────────────────────────────────────────
  const all = await admin_(admin.jar, "requirePasswordResetForEveryoneAction");
  check(all.ok, "the admin requires new passwords of everyone", all);
  check((await flagOf(bob.id)) && (await flagOf(carol.id)) && (await flagOf(frank.id)), "…Bob, Carol and Frank have to choose one");
  check(!(await flagOf(erin.id)) && !(await flagOf(admin.id)), "…not Erin (no password) nor the admin");
  check((await liveSessions(carol.id)) === 0 && (await liveSessions(bob.id)) === 0, "…and they are signed out");
  check((await sessionOf(admin.jar)) !== null, "…the admin stays signed in");
  const frankRefused = await signIn(frank.email, PASSWORD);
  check(frankRefused.status === 403 && frankRefused.body?.code === "PASSWORD_RESET_REQUIRED", "Frank's next sign-in is refused too", frankRefused.body);

  // Accounts this run didn't create: back as they were.
  await db
    .update(user)
    .set({ passwordResetRequired: false })
    .where(and(eq(user.passwordResetRequired, true), notInArray(user.id, [...userIds, ...flaggedBefore, "-"])));

  console.log(`\n${passed} checks passed`);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (workspaceIds.length) await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  if (userIds.length) await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
process.exit(failed ? 1 : 0);
