import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware, createEmailVerificationToken } from "better-auth/api";
import { symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAuthOptions, claimOnEmailVerification } from "./auth-options";
import {
  authMethodOf,
  codeMatches,
  isStrongSession,
  passkeyPlugin,
  passkeyRelyingParty,
  recordAuthMethod,
  requireCodeToDisable,
  sameOriginPath,
  socialTwoFactorRedirect,
  SSO_PENDING_COOKIE,
  ssoPendingProvider,
  twoFactorPlugin,
  twoFactorStepUrl,
} from "./auth-security";
import { totpCode, totpKeyFromUri } from "./totp";

const APP = "http://localhost:4100";
const SECRET = "unit-test-secret-unit-test-secret-0000";

describe("authMethodOf / recordAuthMethod", () => {
  it("names the sign-in method from the endpoint that creates the session", () => {
    expect(authMethodOf("/sign-in/email")).toBe("password");
    expect(authMethodOf("/callback/:id")).toBe("social");
    expect(authMethodOf("/passkey/verify-authentication")).toBe("passkey");
    expect(authMethodOf("/two-factor/verify-totp")).toBe("totp");
    expect(authMethodOf("/two-factor/verify-backup-code")).toBe("recovery-code");
    expect(authMethodOf("/two-factor/disable")).toBeNull();
    expect(authMethodOf("constructor")).toBeNull();
    expect(authMethodOf(undefined)).toBeNull();
  });

  it("keeps the method of a session recreated from another", async () => {
    expect((await recordAuthMethod({ userId: "u" }, { path: "/sign-in/email" })).data.authMethod).toBe("password");
    expect((await recordAuthMethod({ authMethod: "passkey" }, { path: "/two-factor/disable" })).data.authMethod).toBe("passkey");
    expect((await recordAuthMethod({}, null)).data.authMethod).toBeNull();
  });

  it("carries the method over when a request replaces its own session (password change)", async () => {
    const ctx = { path: "/change-password", context: { session: { session: { authMethod: "passkey" } } } };
    expect((await recordAuthMethod({ userId: "u" }, ctx)).data.authMethod).toBe("passkey");
    // A sign-in names its own method, whatever session the browser had before.
    const signIn = { path: "/sign-in/email", context: { session: { session: { authMethod: "passkey" } } } };
    expect((await recordAuthMethod({ userId: "u" }, signIn)).data.authMethod).toBe("password");
  });
});

describe("single sign-on in the session", () => {
  const signed = (value: string | null) => async (name: string) => (name === SSO_PENDING_COOKIE ? value : null);

  it("records the provider of an SSO sign-in", async () => {
    const oidc = await recordAuthMethod({ userId: "u" }, { path: "/sso/callback/:providerId", params: { providerId: "ws-w1" } });
    expect(oidc.data).toMatchObject({ authMethod: "sso", ssoProviderId: "ws-w1" });
    const saml = await recordAuthMethod({ userId: "u" }, { path: "/sso/saml2/sp/acs/:providerId", params: { providerId: "ws-w2" } });
    expect(saml.data).toMatchObject({ authMethod: "sso", ssoProviderId: "ws-w2" });
    expect((await recordAuthMethod({ userId: "u" }, { path: "/sign-in/email" })).data.ssoProviderId).toBeNull();
  });

  it("keeps it through the code step, for the same user only", async () => {
    const ctx = (value: string | null) => ({
      path: "/two-factor/verify-totp",
      context: { secret: SECRET },
      getSignedCookie: signed(value),
    });
    expect((await recordAuthMethod({ userId: "u" }, ctx("ws-w1!u"))).data).toMatchObject({ authMethod: "totp", ssoProviderId: "ws-w1" });
    expect((await recordAuthMethod({ userId: "u" }, ctx("ws-w1!someone-else"))).data.ssoProviderId).toBeNull();
    expect((await recordAuthMethod({ userId: "u" }, ctx(null))).data.ssoProviderId).toBeNull();
    // A password sign-in never reads the cookie.
    const password = { path: "/sign-in/email", context: { secret: SECRET }, getSignedCookie: signed("ws-w1!u") };
    expect((await recordAuthMethod({ userId: "u" }, password)).data.ssoProviderId).toBeNull();
  });

  it("carries it over when a request replaces its own session, not on a new sign-in", async () => {
    const current = { session: { session: { authMethod: "sso", ssoProviderId: "oidc" } } };
    expect((await recordAuthMethod({ userId: "u" }, { path: "/change-password", context: current })).data).toMatchObject({
      authMethod: "sso",
      ssoProviderId: "oidc",
    });
    expect((await recordAuthMethod({ userId: "u" }, { path: "/passkey/verify-authentication", context: current })).data).toMatchObject({
      authMethod: "passkey",
      ssoProviderId: null,
    });
    expect((await recordAuthMethod({ authMethod: "sso", ssoProviderId: "ws-w1" }, { path: "/two-factor/enable" })).data.ssoProviderId).toBe(
      "ws-w1",
    );
  });

  it("parses the pending cookie", () => {
    expect(ssoPendingProvider("ws-w1!u1", "u1")).toBe("ws-w1");
    expect(ssoPendingProvider("ws-w1!u1", "u2")).toBeNull();
    expect(ssoPendingProvider("!u1", "u1")).toBeNull();
    expect(ssoPendingProvider("ws-w1!u1", undefined)).toBeNull();
  });
});

describe("isStrongSession", () => {
  it("passes users with an authenticator app, whatever the session", () => {
    expect(isStrongSession({ user: { twoFactorEnabled: true }, session: { authMethod: "password" } })).toBe(true);
    expect(isStrongSession({ user: { twoFactorEnabled: true }, session: {} })).toBe(true);
  });

  it("passes a passkey sign-in without an authenticator app", () => {
    expect(isStrongSession({ user: { twoFactorEnabled: false }, session: { authMethod: "passkey" } })).toBe(true);
  });

  it("turns away password and social sessions without two-step verification", () => {
    expect(isStrongSession({ user: { twoFactorEnabled: false }, session: { authMethod: "password" } })).toBe(false);
    expect(isStrongSession({ user: { twoFactorEnabled: null }, session: { authMethod: "social" } })).toBe(false);
    expect(isStrongSession({ user: {}, session: { authMethod: null } })).toBe(false);
  });
});

describe("redirect helpers", () => {
  it("keeps only same-origin paths", () => {
    expect(sameOriginPath("/w/abc?x=1", APP)).toBe("/w/abc?x=1");
    expect(sameOriginPath(`${APP}/w/abc`, APP)).toBe("/w/abc");
    expect(sameOriginPath("https://evil.example/w", APP)).toBeNull();
    expect(sameOriginPath("//evil.example/w", APP)).toBeNull();
    expect(sameOriginPath(null, APP)).toBeNull();
  });

  it("sends a held-back social sign-in to the code step", () => {
    expect(twoFactorStepUrl("/w/abc")).toBe("/sign-in?step=two-factor&next=%2Fw%2Fabc");
    expect(twoFactorStepUrl("/")).toBe("/sign-in?step=two-factor");
    expect(twoFactorStepUrl(null)).toBe("/sign-in?step=two-factor");
    // An app's signed authorization query rides along (and can't bring its own step or next).
    expect(twoFactorStepUrl("/w/abc", "client_id=c1&step=x&sig=s")).toBe(
      "/sign-in?client_id=c1&sig=s&step=two-factor&next=%2Fw%2Fabc",
    );
  });

  it("uses the public origin as the passkey relying party", () => {
    expect(passkeyRelyingParty("https://notes.example.com:8443/")).toEqual({
      rpID: "notes.example.com",
      rpName: "Leafdesk",
      origin: "https://notes.example.com:8443",
    });
  });
});

describe("plugin wiring", () => {
  it("challenges password and social sign-in, not sign-up", () => {
    const [challenge] = twoFactorPlugin().hooks.after;
    const matches = (path: string) => challenge.matcher({ path } as Parameters<typeof challenge.matcher>[0]);
    expect(matches("/sign-in/email")).toBe(true);
    expect(matches("/callback/:id")).toBe(true);
    expect(matches("/sign-in/social")).toBe(true);
    expect(matches("/sign-up/email")).toBe(false);
    expect(matches("/passkey/verify-authentication")).toBe(false);
  });

  it("runs the code challenge before the OAuth provider resumes an authorization", () => {
    const ids = baseAuthOptions().plugins.map((plugin) => plugin.id);
    expect(ids.indexOf("two-factor")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("two-factor")).toBeLessThan(ids.indexOf("leafdesk-social-two-factor"));
    expect(ids.indexOf("leafdesk-social-two-factor")).toBeLessThan(ids.indexOf("oauth-provider"));
    expect(ids).toContain("passkey");
  });

  it("pins passkeys to the configured origin", () => {
    const plugin = passkeyPlugin("https://notes.example.com");
    expect(plugin.options).toMatchObject({ rpID: "notes.example.com", origin: "https://notes.example.com" });
    expect(Object.keys(plugin.endpoints)).toEqual(
      expect.arrayContaining(["verifyPasskeyAuthentication", "verifyPasskeyRegistration", "deletePasskey", "updatePasskey"]),
    );
  });
});

describe("codeMatches", () => {
  it("accepts the current authenticator code or an unused recovery code", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyz012345";
    const row = {
      secret: await symmetricEncrypt({ key: SECRET, data: secret }),
      backupCodes: await symmetricEncrypt({ key: SECRET, data: JSON.stringify(["aaaaa-bbbbb", "ccccc-ddddd"]) }),
    };
    expect(await codeMatches(totpCode(Buffer.from(secret)), row, SECRET)).toBe(true);
    expect(await codeMatches(" ccccc-ddddd ", row, SECRET)).toBe(true);
    expect(await codeMatches("000000", row, SECRET)).toBe(totpCode(Buffer.from(secret)) === "000000");
    expect(await codeMatches("zzzzz-zzzzz", row, SECRET)).toBe(false);
  });
});

/** The cookies of one browser, for driving Better Auth over HTTP-shaped requests. */
class Jar {
  cookies = new Map<string, string>();
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1);
      if (value && !/max-age=0/i.test(line)) this.cookies.set(pair.slice(0, eq), value);
      else this.cookies.delete(pair.slice(0, eq));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * A real Better Auth instance (in memory) with our plugins and hooks, driven over HTTP-shaped
 * requests: the server side of two-step verification with social sign-in, where the provider is
 * faked at the token endpoint.
 */
describe("Better Auth with our two-step setup", () => {
  const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
  const realFetch = globalThis.fetch;

  function makeAuth() {
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      passkey: [],
    };
    return betterAuth({
      baseURL: APP,
      secret: SECRET,
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true },
      session: { additionalFields: { authMethod: { type: "string", required: false, input: false } } },
      socialProviders: {
        google: {
          clientId: "test-client",
          clientSecret: "test-secret",
          getUserInfo: async () => ({
            user: { name: "Social Tester", email: "social@example.test", emailVerified: true },
            data: { sub: "google-1", email: "social@example.test", email_verified: true } as never,
          }),
        },
      },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/two-factor/disable") await requireCodeToDisable(ctx);
        }),
      },
      databaseHooks: { session: { create: { before: recordAuthMethod } } },
      plugins: [twoFactorPlugin(), socialTwoFactorRedirect(APP), passkeyPlugin(APP)],
    });
  }

  let auth: ReturnType<typeof makeAuth>;
  beforeEach(() => {
    auth = makeAuth();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).startsWith(GOOGLE_TOKEN)) {
        return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
      }
      return realFetch(input, init);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function call(jar: Jar, path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await auth.handler(
      new Request(`${APP}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", origin: APP, cookie: jar.header() },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
    jar.store(res);
    return res;
  }

  /** Sign in with the fake Google account; returns the callback's response. */
  async function googleSignIn(jar: Jar, extra: Record<string, unknown> = {}) {
    const start = await call(jar, "/sign-in/social", { body: { provider: "google", callbackURL: "/w/abc", ...extra } });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    return call(jar, `/callback/google?code=test-code&state=${state}`);
  }

  async function session(jar: Jar) {
    const res = await call(jar, "/get-session");
    return (await res.json()) as { user: { twoFactorEnabled?: boolean }; session: { authMethod?: string } } | null;
  }

  it("asks for a code after social sign-in, then lets a passwordless account turn it off with one", async () => {
    // First sign-in creates the account; no second step yet.
    const first = new Jar();
    const firstRes = await googleSignIn(first);
    expect(firstRes.status).toBe(302);
    expect((await session(first))?.session.authMethod).toBe("social");

    // Turn on the authenticator app: no password to confirm with on a Google-only account.
    const enable = await call(first, "/two-factor/enable", { body: {} });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    const key = totpKeyFromUri(totpURI);
    expect((await call(first, "/two-factor/verify-totp", { body: { code: totpCode(key) } })).status).toBe(200);
    expect((await session(first))?.user.twoFactorEnabled).toBe(true);

    // Signing in with Google again stops at the code step instead of a session.
    const second = new Jar();
    const callback = await googleSignIn(second);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/sign-in?step=two-factor&next=%2Fw%2Fabc");
    expect(await session(second)).toBeNull();

    // Signing in to authorize an app: its signed query comes back on the code step, where the
    // client sends it with the code and the OAuth provider resumes (scripts/two-factor-e2e.ts).
    const oauthQuery = "client_id=app-1&response_type=code&exp=9999999999&ba_param=client_id&sig=abc";
    const viaApp = await googleSignIn(new Jar(), { oauth_query: oauthQuery });
    expect(viaApp.headers.get("location")).toBe(`/sign-in?${oauthQuery}&step=two-factor&next=%2Fw%2Fabc`);
    const wrong = await call(second, "/two-factor/verify-totp", { body: { code: "000000" === totpCode(key) ? "111111" : "000000" } });
    expect(wrong.status).toBe(401);
    expect((await call(second, "/two-factor/verify-backup-code", { body: { code: backupCodes[0] } })).status).toBe(200);
    expect((await session(second))?.session.authMethod).toBe("recovery-code");

    // Turning it off without a password needs a code.
    expect((await call(second, "/two-factor/disable", { body: {} })).status).toBe(400);
    expect((await call(second, "/two-factor/disable", { body: { code: "zzzzz-zzzzz" } })).status).toBe(401);
    expect((await call(second, "/two-factor/disable", { body: { code: backupCodes[1] } })).status).toBe(200);
    expect((await session(second))?.user.twoFactorEnabled).toBe(false);
  });

  it("offers passkey ceremonies for this origin only", async () => {
    const jar = new Jar();
    const options = await call(jar, "/passkey/generate-authenticate-options");
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ rpId: "localhost", userVerification: "preferred" });

    expect((await call(jar, "/passkey/generate-register-options")).status).toBe(401);
    await googleSignIn(jar);
    const register = await call(jar, "/passkey/generate-register-options");
    expect(register.status).toBe(200);
    expect(await register.json()).toMatchObject({ rp: { id: "localhost", name: "Leafdesk" }, user: { name: "social@example.test" } });

    // A registration signed for another origin is refused before anything is stored.
    const verify = await call(jar, "/passkey/verify-registration", {
      body: { response: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" } } },
    });
    expect(verify.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * Following the verification link emailed to an address that someone may have signed up with
 * before its owner did: from another browser it takes the account over (claimOnEmailVerification),
 * from the one signed in to it nothing changes.
 */
describe("the email verification link and an account signed up for with the address", () => {
  const EMAIL = "newhire@example.test";
  const PASSWORD = "squatter-password";
  let db: Record<string, Record<string, unknown>[]>;
  let forgotten: string[];

  function makeAuth() {
    db = { user: [], session: [], account: [], verification: [], twoFactor: [], passkey: [] };
    forgotten = [];
    return betterAuth({
      baseURL: APP,
      secret: SECRET,
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true },
      emailVerification: { sendVerificationEmail: async () => {}, autoSignInAfterVerification: true },
      user: { additionalFields: { passwordResetRequired: { type: "boolean", required: false, input: false, defaultValue: false } } },
      session: { additionalFields: { authMethod: { type: "string", required: false, input: false } } },
      // Stands in for forgetUnprovenHolder (server/account-security.ts), which needs the database:
      // what it removes is shown by the passkey going.
      hooks: {
        after: claimOnEmailVerification(async (userId) => {
          forgotten.push(userId);
          db.passkey = db.passkey.filter((key) => key.userId !== userId);
        }),
      },
      databaseHooks: {
        session: {
          create: {
            // Stands in for holdRequiredPasswordReset (server/required-password.ts): no password
            // sign-in while the account has to choose a new password.
            before: async (session, ctx) => {
              if (ctx?.path === "/sign-in/email") {
                const owner = (await ctx.context.internalAdapter.findUserById(session.userId)) as { passwordResetRequired?: boolean } | null;
                if (owner?.passwordResetRequired) throw new APIError("FORBIDDEN", { code: "PASSWORD_RESET_REQUIRED" });
              }
              return recordAuthMethod(session, ctx);
            },
          },
        },
      },
      plugins: [twoFactorPlugin(), passkeyPlugin(APP)],
    });
  }

  let auth: ReturnType<typeof makeAuth>;
  beforeEach(() => {
    auth = makeAuth();
  });

  async function call(jar: Jar, path: string, body?: unknown) {
    const res = await auth.handler(
      new Request(`${APP}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", origin: APP, cookie: jar.header() },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    jar.store(res);
    return res;
  }

  const signedInAs = async (jar: Jar) =>
    ((await (await call(jar, "/get-session")).json()) as { user: { email: string } } | null)?.user.email ?? null;

  /** Signs up with the address in a browser of its own, with a passkey and a second session. */
  async function signUpWithAddress() {
    const browser = new Jar();
    expect((await call(browser, "/sign-up/email", { name: "Signed up", email: EMAIL, password: PASSWORD })).status).toBe(200);
    const [account] = db.user;
    db.passkey.push({ id: "key-1", userId: account.id, publicKey: "pk", credentialID: "cred-1", counter: 0, deviceType: "singleDevice", backedUp: false });
    const other = new Jar();
    expect((await call(other, "/sign-in/email", { email: EMAIL, password: PASSWORD })).status).toBe(200);
    return { browser, other, userId: account.id as string };
  }

  const followLink = async (jar: Jar) =>
    call(jar, `/verify-email?token=${await createEmailVerificationToken(SECRET, EMAIL)}&callbackURL=/`);

  it("from another browser: the earlier sessions, passkeys and the old password stop working", async () => {
    const { browser, other, userId } = await signUpWithAddress();
    const mailbox = new Jar();
    expect((await followLink(mailbox)).status).toBe(302);

    expect(db.user[0].emailVerified).toBe(true);
    expect(await signedInAs(mailbox)).toBe(EMAIL);
    expect(await signedInAs(browser)).toBeNull();
    expect(await signedInAs(other)).toBeNull();
    expect(db.session).toHaveLength(1);
    expect(forgotten).toEqual([userId]);
    expect(db.passkey).toHaveLength(0);
    expect(db.user[0].passwordResetRequired).toBe(true);
    const again = await call(new Jar(), "/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { code?: string }).code).toBe("PASSWORD_RESET_REQUIRED");

    // Once verified, the link changes nothing more, wherever it is followed.
    await followLink(new Jar());
    expect(db.session).toHaveLength(1);
    expect(forgotten).toEqual([userId]);
  });

  it("with two-step verification on, takes the account over without signing the browser in past the code", async () => {
    const { browser, userId } = await signUpWithAddress();
    db.user[0].twoFactorEnabled = true;
    db.twoFactor.push({ id: "tf-1", userId, secret: "secret", backupCodes: "codes" });
    const mailbox = new Jar();
    await followLink(mailbox);

    expect(await signedInAs(mailbox)).toBeNull();
    expect(await signedInAs(browser)).toBeNull();
    expect(db.session).toHaveLength(0);
    expect(forgotten).toEqual([userId]);
    expect(db.user[0].passwordResetRequired).toBe(true);
  });

  it("in the browser that signed up: everything stays", async () => {
    const { browser, other } = await signUpWithAddress();
    expect((await followLink(browser)).status).toBe(302);

    expect(db.user[0].emailVerified).toBe(true);
    expect(await signedInAs(browser)).toBe(EMAIL);
    expect(await signedInAs(other)).toBe(EMAIL);
    expect(forgotten).toEqual([]);
    expect(db.passkey).toHaveLength(1);
    expect(db.user[0].passwordResetRequired).not.toBe(true);
    expect((await call(new Jar(), "/sign-in/email", { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });
});
