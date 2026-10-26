import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAuthOptions, claimOnEmailLink, closedSignUpGuard, signUpTokenOf, socialAuthOptions } from "./auth-options";

/**
 * The social sign-in flow against an in-memory database, with GitHub's token and profile
 * endpoints stubbed: closed sign-up, invitations carried through the redirect, and linking.
 */
const BASE = "http://localhost:3000";
const INVITE = "invite-token";

type Db = Record<"user" | "session" | "account" | "verification", Record<string, unknown>[]>;

function setup({ invitedEmail = "invited@example.com" } = {}) {
  const db: Db = { user: [], session: [], account: [], verification: [] };
  const check = async (token: string, email: string) => token === INVITE && email === invitedEmail;
  const signUps: { email: string; invite: string | null; join: string | null }[] = [];
  const revokedApps: string[] = [];
  const kept: (string | undefined)[] = [];
  const auth = betterAuth({
    baseURL: BASE,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    hooks: baseAuthOptions({ invitationAllowsSignUp: check }).hooks,
    ...socialAuthOptions({ github: { clientId: "id", clientSecret: "secret" } }),
    databaseHooks: {
      user: {
        create: {
          before: closedSignUpGuard(check),
          after: async (user, ctx) => {
            signUps.push({
              email: user.email,
              invite: await signUpTokenOf(ctx, "invite"),
              join: await signUpTokenOf(ctx, "join"),
            });
          },
        },
      },
      account: {
        create: {
          after: claimOnEmailLink(async (userId, keepAccountId) => {
            revokedApps.push(userId);
            kept.push(keepAccountId);
          }),
        },
      },
    },
  });
  return { auth, db, signUps, revokedApps, kept };
}

/** The session cookie a response set, as a request `cookie` header. */
function cookieOf(res: Response) {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

/** What GitHub answers for the signed-in person. */
function stubGitHub(email: string, verified = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (body: unknown) => Response.json(body);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return json({ access_token: "gh-token", token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url === "https://api.github.com/user") return json({ id: 42, login: "octo", name: "Octo", email });
      if (url === "https://api.github.com/user/emails") return json([{ email, primary: true, verified }]);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

/** Starts a GitHub sign-in the way the sign-in buttons do and follows the provider back. */
async function gitHubSignIn(auth: ReturnType<typeof setup>["auth"], query = "") {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" }),
    }),
  );
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
  const state = authorize.searchParams.get("state")!;
  const callback = await auth.handler(
    new Request(`${BASE}/api/auth/callback/github?code=code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookieOf(start) },
    }),
  );
  return { to: new URL(callback.headers.get("location")!, BASE), cookie: cookieOf(callback) };
}

const signInWithGitHub = async (auth: ReturnType<typeof setup>["auth"], query = "") =>
  (await gitHubSignIn(auth, query)).to;

async function sessionUser(auth: ReturnType<typeof setup>["auth"], cookie: string) {
  return (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user ?? null;
}

async function signUpWithPassword(auth: ReturnType<typeof setup>["auth"], email: string) {
  const res = await auth.api.signUpEmail({
    body: { email, password: "password-123", name: "Someone" },
    asResponse: true,
  });
  return cookieOf(res);
}

async function passwordWorks(auth: ReturnType<typeof setup>["auth"], email: string) {
  const res = await auth.api.signInEmail({ body: { email, password: "password-123" }, asResponse: true });
  return res.ok;
}

beforeEach(() => vi.stubEnv("DISABLE_SIGNUP", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("social sign-in", () => {
  it("creates an account while sign-up is open", async () => {
    const { auth, db, signUps } = setup();
    stubGitHub("new@example.com");
    const to = await signInWithGitHub(auth);
    expect(to.pathname).toBe("/");
    expect(db.user).toHaveLength(1);
    expect(db.user[0]).toMatchObject({ email: "new@example.com", emailVerified: true });
    expect(signUps).toEqual([{ email: "new@example.com", invite: null, join: null }]);
  });

  it("carries an invitation or join token through the provider redirect", async () => {
    const { auth, signUps } = setup();
    stubGitHub("new@example.com");
    await signInWithGitHub(auth, "?join=join-token");
    expect(signUps).toEqual([{ email: "new@example.com", invite: null, join: "join-token" }]);
  });

  it("creates no account while sign-up is closed", async () => {
    vi.stubEnv("DISABLE_SIGNUP", "true");
    const { auth, db } = setup();
    stubGitHub("new@example.com");
    const to = await signInWithGitHub(auth);
    expect(to.pathname).toBe("/sign-in");
    expect(to.searchParams.get("error")).toBe("signup_disabled");
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
  });

  it("admits an invitation for the same email while sign-up is closed", async () => {
    vi.stubEnv("DISABLE_SIGNUP", "true");
    const { auth, db, signUps } = setup();
    stubGitHub("invited@example.com");
    const to = await signInWithGitHub(auth, `?invite=${INVITE}`);
    expect(to.pathname).toBe("/");
    expect(db.user).toHaveLength(1);
    expect(signUps).toEqual([{ email: "invited@example.com", invite: INVITE, join: null }]);
  });

  it("does not let an invitation admit another email, or a join link open closed sign-up", async () => {
    vi.stubEnv("DISABLE_SIGNUP", "true");
    const { auth, db } = setup();
    stubGitHub("someone-else@example.com");
    expect((await signInWithGitHub(auth, `?invite=${INVITE}`)).searchParams.get("error")).toBe("signup_disabled");
    expect((await signInWithGitHub(auth, "?join=join-token")).searchParams.get("error")).toBe("signup_disabled");
    expect(db.user).toHaveLength(0);
  });

  it("still signs in existing accounts while sign-up is closed, linking them by email", async () => {
    const { auth, db } = setup();
    await auth.api.signUpEmail({ body: { email: "me@example.com", password: "password-123", name: "Me" } });
    vi.stubEnv("DISABLE_SIGNUP", "true");
    stubGitHub("me@example.com");
    const to = await signInWithGitHub(auth);
    expect(to.pathname).toBe("/");
    expect(db.user).toHaveLength(1);
    const userId = db.user[0].id;
    // The unverified password account is claimed by the verified provider (see below).
    expect(db.account.map((a) => [a.providerId, a.userId])).toEqual([["github", userId]]);
    expect(db.user[0].emailVerified).toBe(true);
  });

  it("takes an unverified account back from whoever registered someone else's email", async () => {
    const { auth, db, revokedApps } = setup();
    const attacker = await signUpWithPassword(auth, "victim@example.com");
    expect((await sessionUser(auth, attacker))?.email).toBe("victim@example.com");
    const userId = db.user[0].id;

    stubGitHub("victim@example.com");
    const { to, cookie: victim } = await gitHubSignIn(auth);
    expect(to.pathname).toBe("/");

    expect(await passwordWorks(auth, "victim@example.com")).toBe(false);
    expect(await sessionUser(auth, attacker)).toBeNull();
    expect((await sessionUser(auth, victim))?.id).toBe(userId);
    expect(db.user).toHaveLength(1);
    expect(db.user[0].emailVerified).toBe(true);
    expect(db.account.map((a) => a.providerId)).toEqual(["github"]);
    expect(revokedApps).toEqual([userId]);
  });

  it("also drops another provider's login of the earlier holder, keeping the one that proved the address", async () => {
    const { auth, db, revokedApps, kept } = setup();
    await signUpWithPassword(auth, "victim@example.com");
    const userId = db.user[0].id;
    // Signed in through an identity provider that doesn't vouch for addresses (SSO without domains).
    db.account.push({ id: "sso-1", userId, providerId: "oidc", accountId: "attacker-sub", createdAt: new Date(), updatedAt: new Date() });

    stubGitHub("victim@example.com");
    await gitHubSignIn(auth);

    expect(db.account.map((a) => a.providerId)).toEqual(["github"]);
    expect(revokedApps).toEqual([userId]);
    expect(kept).toEqual([db.account[0].id]);
  });

  it("leaves the password and sessions of an account whose email is verified", async () => {
    const { auth, db, revokedApps } = setup();
    const owner = await signUpWithPassword(auth, "me@example.com");
    db.user[0].emailVerified = true;

    stubGitHub("me@example.com");
    const { cookie } = await gitHubSignIn(auth);

    expect(await passwordWorks(auth, "me@example.com")).toBe(true);
    expect((await sessionUser(auth, owner))?.email).toBe("me@example.com");
    expect((await sessionUser(auth, cookie))?.email).toBe("me@example.com");
    expect(db.account.map((a) => a.providerId)).toEqual(["credential", "github"]);
    expect(revokedApps).toEqual([]);
  });

  it("does not treat signing in again with a linked provider as a new claim", async () => {
    const { auth, db, revokedApps } = setup();
    stubGitHub("new@example.com");
    const first = (await gitHubSignIn(auth)).cookie;
    await gitHubSignIn(auth);
    expect(await sessionUser(auth, first)).not.toBeNull();
    expect(db.account.map((a) => a.providerId)).toEqual(["github"]);
    expect(revokedApps).toEqual([]);
  });

  it("does not link an existing account when the provider has not verified the email", async () => {
    const { auth, db } = setup();
    await auth.api.signUpEmail({ body: { email: "me@example.com", password: "password-123", name: "Me" } });
    stubGitHub("me@example.com", false);
    const to = await signInWithGitHub(auth);
    expect(to.searchParams.get("error")).toBe("account_not_linked");
    expect(db.account.map((a) => a.providerId)).toEqual(["credential"]);
  });
});
