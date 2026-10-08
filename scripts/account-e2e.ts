/**
 * End-to-end check of the account page (/account) against a running app: the old settings
 * addresses redirecting to it, the name and profile picture (upload, serving, replacing,
 * removing, and Better Auth's /update-user taking nothing else), changing the password with and
 * without signing out other devices, the list of signed-in devices and signing them out, setting a
 * password on an account that only signs in with a provider (simulated by removing its password),
 * the language stored for emails (picked in the language setting, or stated at sign-in),
 * proving it's you with a two-step or recovery code or a recent sign-in, changing the email through
 * the confirmation link, and deleting the account: refused while the only owner of a shared
 * workspace, then leaving shared workspaces (their private pages handed to an owner) and deleting
 * the ones nobody else is in, files and grants included. Creates its own @example.test users and
 * deletes them afterwards.
 *
 * Server actions are called the way the browser calls them, by id; the ids come from the running
 * app's build output (`.next`, or NEXT_DIR), so run this from the checkout the app runs from, after
 * opening /account and /confirm-email once (the script does both before it needs them).
 *
 *   APP_URL=http://localhost:4500 pnpm tsx scripts/account-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL (read from .env when present). Needs
 * development mail (no SMTP: emails go to the server log) or a working SMTP server. With
 * MAILPIT_URL (the app sending to Mailpit), the confirmation link is read from the real email and
 * the notices are checked too; otherwise the script puts a known token in the link's place.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, like, ne } = await import("drizzle-orm");
const { db } = await import("@/db");
const {
  account,
  file,
  oauthClient,
  oauthConsent,
  pagePermission,
  session,
  user,
  userPreference,
  verification,
  workspace,
  workspaceMember,
} = await import("@/db/schema");
const { totpCode, totpKeyFromUri } = await import("@/lib/totp");
const { getStorage } = await import("@/server/storage");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RUN = Date.now().toString(36);
const PASSWORD = "account-e2e-123";
const NEW_PASSWORD = "account-e2e-456";
const emailOf = (who: string) => `account-${who}-${RUN}@example.test`;
const ACTIONS = "src/app/actions/account.ts";
const MAILPIT = process.env.MAILPIT_URL?.replace(/\/$/, "");

type MailpitMessage = { ID: string; Subject: string; Text: string };
/** The emails Mailpit has for `to`, newest first. */
async function mailTo(to: string) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const { messages } = (await res.json()) as { messages: { ID: string }[] };
  return Promise.all(messages.map(async (m) => (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as MailpitMessage));
}
async function waitForMail(to: string, count: number) {
  for (let i = 0; i < 40; i++) {
    const messages = await mailTo(to);
    if (messages.length >= count) return messages;
    await new Promise((r) => setTimeout(r, 250));
  }
  return mailTo(to);
}

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

async function authPost(path: string, body: unknown, jar: Jar) {
  const res = await fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
    body: JSON.stringify(body),
  });
  jar.store(res);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

type SessionBody = { user: { id: string; email: string; name: string; image: string | null }; session: { id: string; authMethod?: string } };
async function sessionOf(jar: Jar) {
  const res = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: jar.header() } });
  return (await res.json().catch(() => null)) as SessionBody | null;
}

/** An app page as a browser would open it, without following redirects. */
async function open(path: string, jar: Jar) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: jar.header(), accept: "text/html" }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: res.status === 200 ? await res.text() : "" };
}

/** `/account…`, which sends someone who can open a workspace on to the same tab under its Settings. */
async function openAccount(path: string, jar: Jar) {
  const page = await open(path, jar);
  return page.status === 307 && page.location?.includes("/settings?tab=") ? open(page.location, jar) : page;
}

/** A code the app would show right now; waits out the last seconds of a period so it stays valid. */
async function codeFor(key: Uint8Array) {
  if (Date.now() % 30_000 > 27_000) await new Promise((r) => setTimeout(r, 3_500));
  return totpCode(key);
}
const wrongCode = (key: Uint8Array) => (totpCode(key) === "000000" ? "111111" : "000000");

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
 * action), and keeps the cookies it sets. Actions answer 200 with their result, 500 when they throw.
 */
async function callAction(jar: Jar, path: string, file: string, name: string, args: unknown[], headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId(file, name),
      origin: BASE,
      cookie: jar.header(),
      ...headers,
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  jar.store(res);
  return { status: res.status, text: await res.text() };
}

/** An account action's result: `ok`, and the error code when it failed. */
async function account_(jar: Jar, name: string, args: unknown[] = [], path = "/account") {
  const res = await callAction(jar, path, ACTIONS, name, args);
  const ok = res.status === 200 && res.text.includes('"ok":true');
  const code = /"code":"(\w+)"/.exec(res.text)?.[1] ?? null;
  return { ...res, ok, code };
}

const userIds: string[] = [];
const workspaceIds: string[] = [];
const clientIds: string[] = [];

async function signUp(who: string) {
  const jar = new Jar();
  const res = await authPost("/sign-up/email", { name: `Account ${who}`, email: emailOf(who), password: PASSWORD }, jar);
  check(res.status === 200, `sign up ${who}`, res.body);
  const id = (await sessionOf(jar))!.user.id;
  userIds.push(id);
  const [personal] = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, id));
  if (personal) workspaceIds.push(personal.id);
  return { jar, id, workspaceId: personal!.id };
}

async function signIn(email: string, password: string, jar = new Jar()) {
  const res = await authPost("/sign-in/email", { email, password }, jar);
  return { ...res, jar };
}

/** Turns the account into one that only signs in with GitHub: no password, a linked provider. */
async function makeSocialOnly(userId: string) {
  await db.delete(account).where(and(eq(account.userId, userId), eq(account.providerId, "credential")));
  const now = new Date();
  await db.insert(account).values({
    id: `e2e-${RUN}-${userId}`,
    accountId: `gh-${RUN}-${userId}`,
    providerId: "github",
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

// 1×1 PNG.
/** Registers an MCP client and stores the user's consent to it, as connecting it does. */
async function connectApp(userId: string, label: string) {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json();
  const registered = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `Account e2e ${label} ${RUN}`,
      application_type: "native",
      redirect_uris: ["http://127.0.0.1:33419/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid pages:read",
    }),
  });
  const client = (await registered.json()) as { client_id?: string };
  check(registered.ok && client.client_id, `an MCP client registers (${label})`, client);
  clientIds.push(client.client_id!);
  const now = new Date();
  await db.insert(oauthConsent).values({
    id: `e2e-${label}-${RUN}`,
    clientId: client.client_id!,
    userId,
    scopes: ["openid", "pages:read"],
    createdAt: now,
    updatedAt: now,
  });
  return client.client_id!;
}

const consentsOf = async (userId: string) =>
  (await db.select({ clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, userId))).map((c) => c.clientId);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// 1×1 GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

async function uploadAvatar(jar: Jar, body: Uint8Array | string, headers: Record<string, string> = { "x-avatar-upload": "1" }) {
  const res = await fetch(`${BASE}/api/account/avatar`, {
    method: "POST",
    headers: { cookie: jar.header(), origin: BASE, "content-type": "application/octet-stream", ...headers },
    body: typeof body === "string" ? body : Buffer.from(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function stored(key: string) {
  const body = await getStorage().get(key);
  if (!body) return false;
  await body.cancel();
  return true;
}

async function main() {
  // ── The page and the old addresses ──────────────────────────────────────────────────────
  const ada = await signUp("ada");
  const moved = await open("/account", ada.jar);
  check(
    moved.status === 307 && moved.location === `/w/${ada.workspaceId}/settings?tab=profile`,
    "the account page moves to the workspace's Settings",
    moved,
  );
  const page = await open(moved.location!, ada.jar);
  check(page.status === 200 && page.text.includes(emailOf("ada")), "…where it opens with the account's email", page.status);
  const anonymous = await open("/account", new Jar());
  check(anonymous.status === 307 && anonymous.location?.includes("/sign-in"), "signed out, it sends to sign-in", anonymous);
  for (const [tab, under] of [
    ["security", "accountSecurity"],
    ["preferences", "preferences"],
    ["apps", "apps"],
  ]) {
    const sent = await open(`/account?tab=${tab}&from=${ada.workspaceId}`, ada.jar);
    check(
      sent.status === 307 && sent.location === `/w/${ada.workspaceId}/settings?tab=${under}`,
      `the account's ${tab} tab moves to Settings as "${under}"`,
      sent,
    );
    const opened = await open(sent.location!, ada.jar);
    check(opened.status === 200, `…and opens`, opened.status);
  }

  // ── Language, for emails ────────────────────────────────────────────────────────────────
  // Node's fetch sends `Accept-Language: *`, which states no language: Ada's sign-up stored none.
  // Lena signs up from a Spanish browser; her own sign-ins keep Ada's devices out of the counts below.
  const localeOf = async (id: string) =>
    (await db.select({ locale: userPreference.locale }).from(userPreference).where(eq(userPreference.userId, id)))[0]?.locale ?? null;
  check((await localeOf(ada.id)) === null, "a sign-up that states no language stores none for emails");
  const lenaJar = new Jar();
  const lenaSignUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "accept-language": "es-ES,es;q=0.9,en;q=0.5" },
    body: JSON.stringify({ name: "Account lena", email: emailOf("lena"), password: PASSWORD }),
  });
  lenaJar.store(lenaSignUp);
  const lena = (await sessionOf(lenaJar))!.user.id;
  userIds.push(lena);
  workspaceIds.push(
    ...(await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, lena))).map((w) => w.id),
  );
  check(lenaSignUp.ok && (await localeOf(lena)) === "es", "signing up stores the language the browser states", lenaSignUp.status);
  const LOCALE_ACTIONS = "src/app/actions/locale.ts";
  const picked = await callAction(lenaJar, "/account", LOCALE_ACTIONS, "setLocaleAction", ["tr"]);
  check(picked.status === 200 && (await localeOf(lena)) === "tr", "picking a language stores it for emails", picked.status);
  const followed = await callAction(lenaJar, "/account", LOCALE_ACTIONS, "setLocaleAction", [null], { "accept-language": "de-AT,de;q=0.9" });
  check(followed.status === 200 && (await localeOf(lena)) === "de", "following the browser stores the browser's language", followed.status);
  const signedIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "accept-language": "fr-FR,fr;q=0.8" },
    body: JSON.stringify({ email: emailOf("lena"), password: PASSWORD }),
  });
  check(
    signedIn.ok && (await localeOf(lena)) === "de",
    "signing in on a device whose browser states another language keeps the one stored",
    signedIn.status,
  );
  const pickedThere = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: "NEXT_LOCALE=fr", "accept-language": "de" },
    body: JSON.stringify({ email: emailOf("lena"), password: PASSWORD }),
  });
  check(pickedThere.ok && (await localeOf(lena)) === "fr", "…while a language picked on that device replaces it", pickedThere.status);
  const quiet = await signIn(emailOf("lena"), PASSWORD);
  check(quiet.status === 200 && (await localeOf(lena)) === "fr", "…and a sign-in that states none keeps it", quiet.status);

  // ── Name ────────────────────────────────────────────────────────────────────────────────
  const renamed = await account_(ada.jar, "updateNameAction", ["  Ada   Lovelace "]);
  check(renamed.ok, "the name changes", renamed);
  check((await sessionOf(ada.jar))?.user.name === "Ada Lovelace", "…trimmed", (await sessionOf(ada.jar))?.user);
  const empty = await account_(ada.jar, "updateNameAction", ["   "]);
  check(!empty.ok && empty.code === "nameRequired", "an empty name is refused", empty);
  const long = await account_(ada.jar, "updateNameAction", ["x".repeat(81)]);
  check(!long.ok && long.code === "nameTooLong", "…and a name over 80 characters", long);

  // Better Auth's own endpoint takes only a name, or removing the picture.
  const direct = await authPost("/update-user", { name: "Ada L." }, ada.jar);
  check(direct.status === 200 && (await sessionOf(ada.jar))?.user.name === "Ada L.", "/update-user still changes the name", direct);
  const tracker = await authPost("/update-user", { image: "https://tracker.example.com/pixel.gif" }, ada.jar);
  check(tracker.status === 400 && (await sessionOf(ada.jar))?.user.image === null, "…but won't set a picture URL", tracker);
  const sneaky = await authPost("/update-user", { name: "Ada", emailVerified: false, twoFactorEnabled: false }, ada.jar);
  check(sneaky.status === 400, "…nor any other field", sneaky);

  // ── Picture ─────────────────────────────────────────────────────────────────────────────
  const noHeader = await uploadAvatar(ada.jar, PNG, {});
  check(noHeader.status === 403, "an upload without the custom header is refused (CSRF)", noHeader);
  const foreign = await fetch(`${BASE}/api/account/avatar`, {
    method: "POST",
    headers: { cookie: ada.jar.header(), origin: "https://evil.example.com", "x-avatar-upload": "1" },
    body: PNG,
  });
  check(foreign.status === 403, "…and one from another origin", foreign.status);
  const svg = await uploadAvatar(ada.jar, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  check(svg.status === 400 && svg.body?.code === "avatarType", "SVG is refused", svg);
  const html = await uploadAvatar(ada.jar, "<!doctype html><title>x</title>");
  check(html.status === 400 && html.body?.code === "avatarType", "…and anything that isn't PNG, JPEG, WebP or GIF", html);
  const huge = new Uint8Array(2 * 1024 * 1024 + 1);
  huge.set(PNG);
  const tooLarge = await uploadAvatar(ada.jar, huge);
  check(tooLarge.status === 413 && tooLarge.body?.code === "avatarTooLarge", "a picture over 2 MB is refused", tooLarge);
  const anonUpload = await uploadAvatar(new Jar(), PNG);
  check(anonUpload.status === 401, "signed out, nothing uploads", anonUpload);

  const first = await uploadAvatar(ada.jar, PNG);
  const firstUrl: string = first.body?.image;
  check(first.status === 201 && /^\/api\/avatars\/[^/]+\/[0-9a-f]{32}-png$/.test(firstUrl), "a PNG uploads", first);
  check((await sessionOf(ada.jar))?.user.image === firstUrl, "…and becomes the account's picture");
  const served = await fetch(`${BASE}${firstUrl}`, { headers: { cookie: ada.jar.header() } });
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check(
    served.status === 200 && served.headers.get("content-type") === "image/png" && servedBytes.equals(PNG),
    "it is served as uploaded",
    { status: served.status, type: served.headers.get("content-type") },
  );
  check(
    served.headers.get("x-content-type-options") === "nosniff" && served.headers.get("content-security-policy")?.includes("sandbox"),
    "…with nosniff and a sandbox",
    Object.fromEntries(served.headers),
  );
  const bob = await signUp("bob");
  const toOthers = await fetch(`${BASE}${firstUrl}`, { headers: { cookie: bob.jar.header() } });
  check(toOthers.status === 200, "other signed-in people see it", toOthers.status);
  const toNobody = await fetch(`${BASE}${firstUrl}`);
  check(toNobody.status === 401, "…but not signed-out visitors", toNobody.status);

  const second = await uploadAvatar(ada.jar, GIF);
  check(second.status === 201 && second.body?.image?.endsWith("-gif") && second.body.image !== firstUrl, "a new picture replaces it", second);
  const gone = await fetch(`${BASE}${firstUrl}`, { headers: { cookie: ada.jar.header() } });
  check(gone.status === 404, "…and the old one is removed", gone.status);
  const removed = await account_(ada.jar, "removeAvatarAction");
  check(removed.ok && (await sessionOf(ada.jar))?.user.image === null, "removing the picture clears it", removed);
  const removedFile = await fetch(`${BASE}${second.body.image}`, { headers: { cookie: ada.jar.header() } });
  check(removedFile.status === 404, "…and its file", removedFile.status);
  const [adaRow] = await db.select({ image: user.image }).from(user).where(eq(user.id, ada.id));
  check(adaRow.image === null, "…in the database too", adaRow);

  // ── Sessions ────────────────────────────────────────────────────────────────────────────
  const phone = await signIn(emailOf("ada"), PASSWORD);
  const laptop = await signIn(emailOf("ada"), PASSWORD);
  check(phone.status === 200 && laptop.status === 200, "two more devices sign in");
  const phoneSession = (await sessionOf(phone.jar))!.session.id;
  const overview = await openAccount("/account?tab=security", ada.jar);
  check(overview.status === 200 && overview.text.includes(phoneSession), "the security tab lists the other devices", overview.status);
  // (In development React's debug info repeats this browser's own session and cookie in the page;
  // the other devices' tokens must never be there.)
  const tokens = await db
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.userId, ada.id), ne(session.id, (await sessionOf(ada.jar))!.session.id)));
  check(tokens.length === 2 && !tokens.some((t) => overview.text.includes(t.token)), "…without their session tokens");
  const adaSessions = await db.select({ id: session.id }).from(session).where(eq(session.userId, ada.id));
  check(adaSessions.length === 3, "three sessions exist", adaSessions.length);

  const self = await account_(ada.jar, "revokeSessionAction", [(await sessionOf(ada.jar))!.session.id]);
  check(!self.ok && self.code === "currentSession", "this browser's own session isn't signed out from the list", self);
  const bobSession = (await sessionOf(bob.jar))!.session.id;
  const someoneElse = await account_(ada.jar, "revokeSessionAction", [bobSession]);
  check(!someoneElse.ok && someoneElse.code === "sessionNotFound", "another person's session can't be signed out", someoneElse);
  check((await sessionOf(bob.jar)) !== null, "…and stays signed in");
  const one = await account_(ada.jar, "revokeSessionAction", [phoneSession]);
  check(one.ok && (await sessionOf(phone.jar)) === null, "signing out one device ends its session", one);
  check((await sessionOf(laptop.jar)) !== null && (await sessionOf(ada.jar)) !== null, "…and only that one");
  const others = await account_(ada.jar, "revokeOtherSessionsAction");
  check(others.ok && (await sessionOf(laptop.jar)) === null, "signing out all other devices ends the rest", others);
  check((await sessionOf(ada.jar)) !== null, "…but keeps this browser signed in");

  // ── Password ────────────────────────────────────────────────────────────────────────────
  const tablet = await signIn(emailOf("ada"), PASSWORD);
  const wrongCurrent = await account_(ada.jar, "changePasswordAction", [
    { currentPassword: "not-the-password", newPassword: NEW_PASSWORD, revokeOthers: false },
  ]);
  check(!wrongCurrent.ok && wrongCurrent.code === "wrongPassword", "changing the password asks for the current one", wrongCurrent);
  const short = await account_(ada.jar, "changePasswordAction", [{ currentPassword: PASSWORD, newPassword: "short", revokeOthers: false }]);
  check(!short.ok && short.code === "passwordTooShort", "…and a new one of 8 characters or more", short);
  const appBefore = await connectApp(ada.id, "password");
  const changed = await account_(ada.jar, "changePasswordAction", [
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOthers: true },
  ]);
  check(changed.ok, "the password changes, signing out other devices", changed);
  check((await sessionOf(tablet.jar)) === null, "…the other device is signed out");
  check(!(await consentsOf(ada.id)).includes(appBefore), "…and the connected app is disconnected", await consentsOf(ada.id));
  const kept = await sessionOf(ada.jar);
  check(kept !== null && kept.session.authMethod === "password", "…this browser stays signed in, with how it signed in", kept);
  check((await signIn(emailOf("ada"), PASSWORD)).status !== 200, "the old password no longer signs in");
  const withNew = await signIn(emailOf("ada"), NEW_PASSWORD);
  check(withNew.status === 200, "…the new one does", withNew.body);
  const appKept = await connectApp(ada.id, "kept");
  const keepOthers = await account_(ada.jar, "changePasswordAction", [
    { currentPassword: NEW_PASSWORD, newPassword: PASSWORD, revokeOthers: false },
  ]);
  check(keepOthers.ok && (await sessionOf(withNew.jar)) !== null, "without signing out others, other devices stay signed in", keepOthers);
  check((await consentsOf(ada.id)).includes(appKept), "…and connected apps stay connected", await consentsOf(ada.id));
  const notSocial = await account_(ada.jar, "setPasswordAction", [{ newPassword: NEW_PASSWORD, proof: { password: PASSWORD } }]);
  check(!notSocial.ok && notSocial.code === "passwordAlreadySet", "an account with a password can't 'set' another one", notSocial);

  // ── Setting a password: GitHub/Google-only accounts ─────────────────────────────────────
  // Recently signed in, without two-step verification: the recent sign-in is the proof.
  const sam = await signUp("sam");
  await makeSocialOnly(sam.id);
  const samPage = await openAccount("/account?tab=security", sam.jar);
  check(samPage.status === 200 && samPage.text.includes("GitHub"), "an account without a password opens its security tab", samPage.status);
  const noChange = await account_(sam.jar, "changePasswordAction", [{ currentPassword: "x", newPassword: NEW_PASSWORD, revokeOthers: false }]);
  check(!noChange.ok && noChange.code === "noPassword", "…it has no password to change", noChange);
  await db.update(session).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(session.userId, sam.id));
  const stale = await account_(sam.jar, "setPasswordAction", [{ newPassword: NEW_PASSWORD, proof: {} }]);
  check(!stale.ok && stale.code === "signInAgain", "a sign-in older than 10 minutes has to sign in again", stale);
  await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, sam.id));
  const set = await account_(sam.jar, "setPasswordAction", [{ newPassword: NEW_PASSWORD, proof: {} }]);
  check(set.ok, "a fresh sign-in sets a password", set);
  check((await sessionOf(sam.jar)) !== null, "…and stays signed in");
  check((await signIn(emailOf("sam"), NEW_PASSWORD)).status === 200, "…which then signs in");

  // With two-step verification on, a code (or a recovery code, once) is the proof.
  const tia = await signUp("tia");
  const enable = await authPost("/two-factor/enable", { password: PASSWORD }, tia.jar);
  const key = totpKeyFromUri(enable.body.totpURI);
  const codes: string[] = enable.body.backupCodes;
  const verified = await authPost("/two-factor/verify-totp", { code: await codeFor(key) }, tia.jar);
  check(verified.status === 200, "another account turns on two-step verification", verified.body);
  await makeSocialOnly(tia.id);
  const noProof = await account_(tia.jar, "requestEmailChangeAction", [{ newEmail: emailOf("tia-new"), proof: {} }]);
  check(!noProof.ok && noProof.code === "proofRequired", "without a password, a code is asked for", noProof);
  const badCode = await account_(tia.jar, "requestEmailChangeAction", [{ newEmail: emailOf("tia-new"), proof: { code: wrongCode(key) } }]);
  check(!badCode.ok && badCode.code === "invalidCode", "…a wrong one is refused", badCode);
  const recovery = await account_(tia.jar, "requestEmailChangeAction", [{ newEmail: emailOf("tia-new"), proof: { code: codes[0] } }]);
  check(recovery.ok, "…a recovery code works", recovery);
  const reused = await account_(tia.jar, "requestEmailChangeAction", [{ newEmail: emailOf("tia-new"), proof: { code: codes[0] } }]);
  check(!reused.ok && reused.code === "invalidCode", "…once", reused);
  const byApp = await account_(tia.jar, "setPasswordAction", [{ newPassword: NEW_PASSWORD, proof: { code: await codeFor(key) } }]);
  check(byApp.ok, "…and the app's code sets a password", byApp);

  // ── Email ───────────────────────────────────────────────────────────────────────────────
  const emily = await signUp("emily");
  const newEmail = emailOf("emily-new");
  const noPassword = await account_(emily.jar, "requestEmailChangeAction", [{ newEmail, proof: { password: "nope" } }]);
  check(!noPassword.ok && noPassword.code === "wrongPassword", "changing the email asks for the password", noPassword);
  const same = await account_(emily.jar, "requestEmailChangeAction", [{ newEmail: emailOf("emily").toUpperCase(), proof: { password: PASSWORD } }]);
  check(!same.ok && same.code === "sameEmail", "…and a different address", same);
  const invalid = await account_(emily.jar, "requestEmailChangeAction", [{ newEmail: "not an email", proof: { password: PASSWORD } }]);
  check(!invalid.ok && invalid.code === "invalidEmail", "…a valid one", invalid);

  const pendingRows = () =>
    db
      .select({ id: verification.id, identifier: verification.identifier, value: verification.value })
      .from(verification)
      .where(and(like(verification.identifier, "change-email:%"), like(verification.value, `{"userId":"${emily.id}",%`)));
  const taken = await account_(emily.jar, "requestEmailChangeAction", [{ newEmail: emailOf("ada"), proof: { password: PASSWORD } }]);
  check(taken.ok && (await pendingRows()).length === 0, "an address in use answers the same, but no link is made", taken);
  const requested = await account_(emily.jar, "requestEmailChangeAction", [{ newEmail, proof: { password: PASSWORD } }]);
  const rows = await pendingRows();
  check(requested.ok && rows.length === 1 && rows[0].value.includes(newEmail), "a link is made for the new address", { requested, rows });
  check(!rows[0].identifier.includes(newEmail), "…stored as a hash, not the token itself", rows[0].identifier);
  const pendingPage = await openAccount("/account", emily.jar);
  check(pendingPage.text.includes(newEmail), "the profile shows the address waiting for confirmation");
  check((await sessionOf(emily.jar))?.user.email === emailOf("emily"), "…the email hasn't changed yet");
  const cancelled = await callAction(emily.jar, "/account", ACTIONS, "cancelEmailChangeAction", []);
  check(cancelled.status === 200 && (await pendingRows()).length === 0, "the change can be cancelled", cancelled.status);

  await account_(emily.jar, "requestEmailChangeAction", [{ newEmail, proof: { password: PASSWORD } }]);
  let token = `e2e-${RUN}-token`;
  if (MAILPIT) {
    // Two requests so far (one cancelled): the newest email holds the live link.
    const [latest] = await waitForMail(newEmail, 2);
    const link = /https?:\/\/\S+\/confirm-email\?token=([\w-]+)/.exec(latest?.Text ?? "");
    check(link, "the new address gets an email with the link", latest);
    token = link[1];
    check((await mailTo(emailOf("ada"))).every((m) => !m.Text.includes("/confirm-email")), "…the address in use got none");
  } else {
    // Play the email: the link's token is only in the email, so put a known one in its place.
    const hashed = `change-email:${createHash("sha256").update(token).digest("base64url")}`;
    const [row] = await pendingRows();
    await db.update(verification).set({ identifier: hashed }).where(eq(verification.id, row.id));
  }

  const confirmPage = await open(`/confirm-email?token=${token}`, new Jar());
  check(confirmPage.status === 200 && confirmPage.text.includes(newEmail), "the link opens a page naming the new address", confirmPage.status);
  const badLink = await open(`/confirm-email?token=nope`, new Jar());
  check(badLink.status === 200 && !badLink.text.includes(newEmail), "a wrong link shows nothing of the change", badLink.status);
  check((await sessionOf(emily.jar))?.user.email === emailOf("emily"), "opening the link alone changes nothing");
  const stranger = new Jar();
  const wrongToken = await account_(stranger, "confirmEmailChangeAction", ["nope"], `/confirm-email?token=nope`);
  check(!wrongToken.ok && wrongToken.code === "linkInvalid", "confirming a wrong token fails", wrongToken);
  const confirmed = await account_(stranger, "confirmEmailChangeAction", [token], `/confirm-email?token=${token}`);
  check(confirmed.ok, "confirming on the page changes the email, signed out", confirmed);
  check((await sessionOf(stranger)) === null, "…and signs nobody in");
  const [emilyRow] = await db.select({ email: user.email, emailVerified: user.emailVerified }).from(user).where(eq(user.id, emily.id));
  check(emilyRow.email === newEmail && emilyRow.emailVerified === true, "…the new address is the account's, verified", emilyRow);
  check((await sessionOf(emily.jar))?.user.email === newEmail, "…the signed-in browser sees it");
  const again = await account_(stranger, "confirmEmailChangeAction", [token], `/confirm-email?token=${token}`);
  check(!again.ok && again.code === "linkInvalid", "the link works once", again);
  check((await signIn(newEmail, PASSWORD)).status === 200, "the new address signs in");
  check((await signIn(emailOf("emily"), PASSWORD)).status !== 200, "…the old one doesn't");
  if (MAILPIT) {
    // Each sign-up also emailed a verification link.
    const notices = await waitForMail(emailOf("emily"), 2);
    check(notices.some((m) => m.Text.includes(newEmail)), "the old address is told about the change", notices.map((m) => m.Subject));
    const passwordNotices = await waitForMail(emailOf("ada"), 3);
    check(passwordNotices.filter((m) => /password/i.test(m.Subject)).length === 2, "each password change sends a notice", passwordNotices.map((m) => m.Subject));
  }

  // ── Deleting the account ────────────────────────────────────────────────────────────────
  // Ada owns her personal workspace (alone, with a file) and "Shared" with Bob in it.
  const WS_ACTIONS = "src/app/actions/workspaces.ts";
  const PAGE_ACTIONS = "src/app/actions/pages.ts";
  const home = `/w/${ada.workspaceId}`;
  check((await open(home, ada.jar)).status === 200, "Ada opens her workspace");
  const created = await callAction(ada.jar, home, WS_ACTIONS, "createWorkspaceAction", [`Shared ${RUN}`]);
  const [sharedRow] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
    .where(and(eq(workspaceMember.userId, ada.id), eq(workspace.name, `Shared ${RUN}`)));
  check(created.status === 200 && sharedRow, "Ada creates a second workspace", created);
  const shared = sharedRow.id;
  workspaceIds.push(shared);
  await db.insert(workspaceMember).values({ workspaceId: shared, userId: bob.id, role: "member" });

  const own = await callAction(ada.jar, home, PAGE_ACTIONS, "createPageAction", [{ workspaceId: ada.workspaceId, title: "Mine" }]);
  const ownPage = /"id":"([\w-]+)"/.exec(own.text)?.[1];
  const upload = await fetch(`${BASE}/api/files?pageId=${ownPage}`, {
    method: "POST",
    headers: { cookie: ada.jar.header(), origin: BASE, "content-type": "text/plain", "x-file-name": "notes.txt" },
    body: "hello",
  });
  const uploaded = (await upload.json()) as { id?: string };
  check(upload.status === 201 && uploaded.id, "Ada uploads a file in her personal workspace", uploaded);
  const [fileRow] = await db.select({ key: file.storageKey }).from(file).where(eq(file.id, uploaded.id!));
  check(await stored(fileRow.key), "…which is in storage");

  // A private page in "Shared" that only Ada can manage.
  const secret = await callAction(ada.jar, `/w/${shared}`, PAGE_ACTIONS, "createPageAction", [{ workspaceId: shared, title: "Private" }]);
  const secretPage = /"id":"([\w-]+)"/.exec(secret.text)?.[1];
  check(secret.status === 200 && secretPage, "…and a page in Shared", secret.status);
  await db.insert(pagePermission).values([
    { pageId: secretPage!, workspaceId: shared, userId: null, level: "none", createdBy: ada.id },
    { pageId: secretPage!, workspaceId: shared, userId: ada.id, level: "full", createdBy: ada.id },
  ]);
  const avatar = await uploadAvatar(ada.jar, PNG);
  const avatarKey = avatar.body.image.replace(/^\/api\/avatars\//, "avatars/");
  check(avatar.status === 201 && (await stored(avatarKey)), "…and a picture");

  // A connected app.
  await connectApp(ada.id, "delete");

  const accountPage = await openAccount("/account", ada.jar);
  check(accountPage.text.includes(`Shared ${RUN}`), "the delete section names the workspace that blocks it");
  const mismatch = await account_(ada.jar, "deleteAccountAction", [{ confirmation: "someone@example.test", proof: { password: PASSWORD } }]);
  check(!mismatch.ok && mismatch.code === "confirmationMismatch", "deleting asks to type the account's email", mismatch);
  const blocked = await account_(ada.jar, "deleteAccountAction", [{ confirmation: emailOf("ada"), proof: { password: PASSWORD } }]);
  check(!blocked.ok && blocked.code === "soleOwner" && blocked.text.includes(`Shared ${RUN}`), "the only owner of a shared workspace can't delete the account", blocked);
  check((await db.select({ id: user.id }).from(user).where(eq(user.id, ada.id))).length === 1, "…and nothing is deleted");

  // Carol becomes a second owner of Shared; Bob stays a member.
  const carol = await signUp("carol");
  await db.insert(workspaceMember).values({ workspaceId: shared, userId: carol.id, role: "owner" });
  const wrongProof = await account_(ada.jar, "deleteAccountAction", [{ confirmation: emailOf("ada"), proof: { password: "nope" } }]);
  check(!wrongProof.ok && wrongProof.code === "wrongPassword", "deleting asks for the password", wrongProof);
  const deleted = await account_(ada.jar, "deleteAccountAction", [{ confirmation: ` ${emailOf("ada").toUpperCase()} `, proof: { password: PASSWORD } }]);
  check(deleted.ok, "with another owner in Shared, the account is deleted", deleted);
  check((await sessionOf(ada.jar)) === null, "…the browser is signed out");
  check((await db.select({ id: user.id }).from(user).where(eq(user.id, ada.id))).length === 0, "…the user is gone");
  check((await db.select({ id: session.id }).from(session).where(eq(session.userId, ada.id))).length === 0, "…with every session");
  check((await db.select({ id: account.id }).from(account).where(eq(account.userId, ada.id))).length === 0, "…and sign-in method");
  check(
    (await db.select({ id: oauthConsent.id }).from(oauthConsent).where(eq(oauthConsent.userId, ada.id))).length === 0,
    "…and the connected app's grant",
  );
  check(
    (await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, ada.workspaceId))).length === 0,
    "her personal workspace, which nobody else was in, is deleted",
  );
  check((await db.select({ id: file.id }).from(file).where(eq(file.id, uploaded.id!))).length === 0, "…with its files' records");
  check(!(await stored(fileRow.key)), "…and their stored bytes");
  check(!(await stored(avatarKey)), "her picture is removed from storage");
  const members = await db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(eq(workspaceMember.workspaceId, shared));
  check(
    members.length === 2 && members.some((m) => m.userId === carol.id && m.role === "owner") && members.some((m) => m.userId === bob.id),
    "Shared stays, with Carol and Bob",
    members,
  );
  const grants = await db
    .select({ userId: pagePermission.userId, level: pagePermission.level })
    .from(pagePermission)
    .where(eq(pagePermission.pageId, secretPage!));
  check(
    grants.some((g) => g.userId === carol.id && g.level === "full") && !grants.some((g) => g.userId === bob.id),
    "her private page is handed to the remaining owner, not opened to members",
    grants,
  );
  const leftovers = await db
    .select({ id: verification.id })
    .from(verification)
    .where(inArray(verification.value, [ada.id]));
  check(leftovers.length === 0, "no verification rows are left for her", leftovers);
  const signInGone = await signIn(emailOf("ada"), PASSWORD);
  check(signInGone.status !== 200, "the deleted account can't sign in", signInGone.status);

  // Deleting an account alone in its workspace, without a password or two-step: a recent sign-in.
  const solo = await signUp("solo");
  await makeSocialOnly(solo.id);
  const soloDeleted = await account_(solo.jar, "deleteAccountAction", [{ confirmation: emailOf("solo"), proof: {} }]);
  check(soloDeleted.ok, "a GitHub-only account, freshly signed in, deletes itself", soloDeleted);
  check(
    (await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, solo.workspaceId))).length === 0,
    "…and its workspace",
  );

  console.log(`\n${passed} checks passed`);
}

try {
  await main();
} finally {
  if (workspaceIds.length) await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  if (userIds.length) await db.delete(user).where(inArray(user.id, userIds));
  if (clientIds.length) await db.delete(oauthClient).where(inArray(oauthClient.clientId, clientIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
