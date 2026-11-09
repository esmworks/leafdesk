/**
 * End-to-end check of signing a phone in with a QR code (server/phone-sign-in.ts) against a real
 * PostgreSQL, without a server: Better Auth's `/phone-sign-in` endpoint is called in-process. A
 * code signs in once and gives a session recorded as "phone" with the Better Auth cookie; it stores
 * only the token's hash, stops working when used, expired or replaced; a workspace requiring
 * two-step verification refuses it for an account without two-step, and an account with two-step
 * gets the code step instead of a session; the account page asks for proof first. Creates its own
 * people and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/qr-sign-in-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET, read from .env when present (migrated database).
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { createHash } = await import("node:crypto");
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, phoneSignIn, session, user, workspace } = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { registerCollab } = await import("@/server/collab/bridge");
const { memberWorkspaceIds } = await import("@/server/access");
const { AccountError, startPhoneSignIn } = await import("@/server/account");
const { findPhoneSignIn, issuePhoneSignIn, phoneSignInRefusal } = await import("@/server/phone-sign-in");
const { createPersonalWorkspace } = await import("@/server/workspaces");

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectSessions() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);

const RUN = `qr-e2e-${Date.now().toString(36)}`;
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

const tokenOf = (url: string) => url.split("/phone-sign-in/")[1];
const sessionsOf = async (userId: string) => (await db.select({ authMethod: session.authMethod }).from(session).where(eq(session.userId, userId))).length;

/** The endpoint as the phone's page calls it: the status, the JSON and the cookies set. */
async function redeem(token: string) {
  const response = (await auth.api.phoneSignIn({ body: { token }, headers: new Headers(), asResponse: true })) as Response;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body, cookies: response.headers.get("set-cookie") ?? "" };
}

const people = [`${RUN}-a`, `${RUN}-b`];
await db.insert(user).values(people.map((id) => ({ id, name: `Phone ${id.slice(-1)}`, email: `${id}@example.test` })));
let failed = false;
try {
  const [a, b] = people;
  await createPersonalWorkspace(a, "Phone a");
  await createPersonalWorkspace(b, "Phone b");
  const [workspaceA] = await memberWorkspaceIds(a);
  const [workspaceB] = await memberWorkspaceIds(b);
  check(workspaceA && workspaceB, "each person has a workspace");

  // A code, and what the phone's page shows of it.
  const issued = await issuePhoneSignIn(a);
  const token = tokenOf(issued.url);
  check(token?.length === 43, "the link carries a 43-character token", issued.url);
  const left = Date.parse(issued.expiresAt) - Date.now();
  check(left > 110_000 && left <= 120_000, "the code lasts two minutes", left);
  const [stored] = await db.select().from(phoneSignIn).where(eq(phoneSignIn.userId, a));
  check(stored.tokenHash === createHash("sha256").update(token).digest("hex") && stored.tokenHash !== token, "only the token's SHA-256 is stored");
  check((await findPhoneSignIn(token))?.email === `${a}@example.test`, "the phone's page names the account");
  check((await findPhoneSignIn("x".repeat(43))) === null, "an unknown token names nobody");

  // Using it signs in once.
  const before = await sessionsOf(a);
  const used = await redeem(token);
  check(used.status === 200 && used.body?.ok === true, "the code signs the phone in", used);
  check(/session_token=/.test(used.cookies), "Better Auth's session cookie is set", used.cookies);
  check((await sessionsOf(a)) === before + 1, "a new session exists");
  const [created] = await db.select({ authMethod: session.authMethod, sso: session.ssoProviderId }).from(session).where(eq(session.userId, a)).limit(1);
  check(created.authMethod === "phone" && created.sso === null, "the session is recorded as a phone sign-in, without single sign-on", created);
  const events = await db
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceA), eq(auditEvent.action, "account.phone_signed_in")));
  check(events.length === 1, "the workspace's audit log records it");
  check((await db.select().from(phoneSignIn).where(eq(phoneSignIn.userId, a))).length === 0, "the code is deleted as it is used");

  const again = await redeem(token);
  check(again.status === 400 && again.body?.code === "PHONE_LINK_INVALID", "the same code doesn't sign in twice", again);
  check((await findPhoneSignIn(token)) === null, "the page no longer names the account");

  // Expired.
  const old = tokenOf((await issuePhoneSignIn(a)).url);
  await db.update(phoneSignIn).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(phoneSignIn.userId, a));
  check((await findPhoneSignIn(old)) === null, "an expired code names nobody");
  const expired = await redeem(old);
  check(expired.status === 400 && expired.body?.code === "PHONE_LINK_INVALID", "an expired code doesn't sign in", expired);

  // A new code replaces the one before.
  const first = tokenOf((await issuePhoneSignIn(a)).url);
  const second = tokenOf((await issuePhoneSignIn(a)).url);
  check((await redeem(first)).status === 400, "a replaced code doesn't sign in");
  check((await redeem(second)).status === 200, "the newest code does");
  check((await redeem("not a token")).status === 400, "garbage is refused");

  // The account page asks for proof: an account without password or two-step, a recent sign-in.
  const fresh = { user: { id: b, name: "Phone b", email: `${b}@example.test` }, session: { id: `${RUN}-s`, createdAt: new Date() } };
  const shown = await startPhoneSignIn(fresh, {});
  check(tokenOf(shown.url)?.length === 43, "a recent sign-in may show a code");
  const stale = { ...fresh, session: { ...fresh.session, createdAt: new Date(Date.now() - 60 * 60_000) } };
  const refusedStale = await startPhoneSignIn(stale, {}).then(
    () => null,
    (error: unknown) => error,
  );
  check(refusedStale instanceof AccountError && refusedStale.code === "signInAgain", "an old sign-in has to sign in again first", String(refusedStale));

  // A workspace requiring two-step verification, and an account without it.
  await db
    .update(workspace)
    .set({ settings: sql`${workspace.settings} || '{"requireTwoFactor": true}'::jsonb` })
    .where(eq(workspace.id, workspaceB));
  const refusal = await phoneSignInRefusal(b);
  check(refusal?.hold === "two-factor" && refusal.workspaces.length === 1, "the policy refuses a phone sign-in", refusal);
  const refusedPolicy = await startPhoneSignIn(fresh, {}).then(
    () => null,
    (error: unknown) => error,
  );
  check(refusedPolicy instanceof AccountError && refusedPolicy.code === "phoneSignInTwoFactor", "the account page shows no code then", String(refusedPolicy));
  // A code shown before the policy changed.
  const pending = tokenOf((await issuePhoneSignIn(b)).url);
  const held = await redeem(pending);
  check(held.status === 403 && held.body?.code === "PHONE_LINK_TWO_FACTOR", "a code from before the policy is refused", held);
  check((await sessionsOf(b)) === 0, "no session is made");

  // With two-step verification on, the phone asks for the code instead.
  await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, b));
  check((await phoneSignInRefusal(b)) === null, "an account with two-step may sign a phone in");
  const withCode = await redeem(tokenOf((await issuePhoneSignIn(b)).url));
  check(withCode.status === 200 && withCode.body?.twoFactorRedirect === true, "the phone goes to the code step", withCode);
  check(/two_factor=/.test(withCode.cookies), "the code step's cookie is set", withCode.cookies);
  check((await sessionsOf(b)) === 0, "no session before the code");

  console.log(`\n${passed} checks passed`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  const workspaces = (await Promise.all(people.map((id) => memberWorkspaceIds(id)))).flat();
  if (workspaces.length) await db.delete(workspace).where(inArray(workspace.id, workspaces));
  await db.delete(user).where(inArray(user.id, people));
}
process.exit(failed ? 1 : 0);
