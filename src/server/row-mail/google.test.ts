import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exchangeGoogleCode, GOOGLE_MAIL, GOOGLE_MAIL_SCOPE, googleAuthorizationUrl, idTokenEmail, refreshGoogleTokens } from "./google";

/** A stand-in for Google's token endpoint: answers with what `answer` says and records the forms it was sent. */
let server: Server;
const forms: URLSearchParams[] = [];
let answer: (form: URLSearchParams) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const realTokenUrl = GOOGLE_MAIL.tokenUrl;

const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      forms.push(form);
      const { status, body } = answer(form);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  GOOGLE_MAIL.tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
});

afterAll(async () => {
  GOOGLE_MAIL.tokenUrl = realTokenUrl;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  forms.length = 0;
  answer = () => ({
    status: 200,
    body: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3599,
      scope: `openid ${GOOGLE_MAIL_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
      id_token: idToken({ email: "Ada@Example.com", email_verified: true }),
    },
  });
});

const app = { clientId: "client", clientSecret: "secret" };

describe("googleAuthorizationUrl", () => {
  it("asks for mail and the address, offline and with PKCE, for the account typed", () => {
    const url = new URL(googleAuthorizationUrl(app, { state: "s1", challenge: "c1", redirectUri: "https://app.example/api/mail/oauth/callback", loginHint: "ada@example.com" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "client",
      redirect_uri: "https://app.example/api/mail/oauth/callback",
      state: "s1",
      code_challenge: "c1",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: "ada@example.com",
    });
    expect(params.scope.split(" ")).toEqual(["openid", "email", "https://mail.google.com/"]);
  });

  it("leaves the account to Google when none was typed", () => {
    const url = new URL(googleAuthorizationUrl(app, { state: "s1", challenge: "c1", redirectUri: "https://app.example/cb" }));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("idTokenEmail", () => {
  it("reads a verified address", () => {
    expect(idTokenEmail(idToken({ email: "ada@example.com", email_verified: true }))).toBe("ada@example.com");
    expect(idTokenEmail(idToken({ email: "ada@example.com", email_verified: "true" }))).toBe("ada@example.com");
  });

  it("takes no unverified, missing or broken address", () => {
    expect(idTokenEmail(idToken({ email: "ada@example.com", email_verified: false }))).toBeNull();
    expect(idTokenEmail(idToken({ email_verified: true }))).toBeNull();
    expect(idTokenEmail("not-a-token")).toBeNull();
    expect(idTokenEmail("a.%%%.c")).toBeNull();
    expect(idTokenEmail(undefined)).toBeNull();
  });
});

describe("exchangeGoogleCode", () => {
  it("trades the code with the verifier for tokens and the address", async () => {
    const before = Date.now();
    const { tokens, email } = await exchangeGoogleCode(app, { code: "code-1", verifier: "v1", redirectUri: "https://app.example/cb" });
    expect(email).toBe("Ada@Example.com");
    expect(tokens).toMatchObject({ refreshToken: "refresh-1", accessToken: "access-1" });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
    expect(Object.fromEntries(forms[0])).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://app.example/cb",
      client_id: "client",
      client_secret: "secret",
      code_verifier: "v1",
    });
  });

  it("refuses a sign-in that didn't allow mail", async () => {
    answer = () => ({ status: 200, body: { access_token: "a", refresh_token: "r", scope: "openid email", id_token: idToken({ email: "a@b.co", email_verified: true }) } });
    await expect(exchangeGoogleCode(app, { code: "c", verifier: "v", redirectUri: "x" })).rejects.toMatchObject({ reason: "scope" });
  });

  it("refuses one without a refresh token or a verified address", async () => {
    answer = () => ({ status: 200, body: { access_token: "a", scope: GOOGLE_MAIL_SCOPE, id_token: idToken({ email: "a@b.co", email_verified: true }) } });
    await expect(exchangeGoogleCode(app, { code: "c", verifier: "v", redirectUri: "x" })).rejects.toMatchObject({ reason: "failed" });
    answer = () => ({ status: 200, body: { access_token: "a", refresh_token: "r", scope: GOOGLE_MAIL_SCOPE, id_token: idToken({ email: "a@b.co" }) } });
    await expect(exchangeGoogleCode(app, { code: "c", verifier: "v", redirectUri: "x" })).rejects.toMatchObject({ reason: "failed" });
  });

  it("says what Google said when it refused the code", async () => {
    answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } });
    await expect(exchangeGoogleCode(app, { code: "c", verifier: "v", redirectUri: "x" })).rejects.toThrow(/400 invalid_grant: Bad Request/);
  });
});

describe("refreshGoogleTokens", () => {
  const tokens = { refreshToken: "refresh-1", accessToken: "old", expiresAt: 0 };

  it("gets a new access token and keeps the refresh token", async () => {
    answer = () => ({ status: 200, body: { access_token: "new", expires_in: 3600 } });
    const fresh = await refreshGoogleTokens(app, tokens);
    expect(fresh).toMatchObject({ refreshToken: "refresh-1", accessToken: "new" });
    expect(fresh.expiresAt).toBeGreaterThan(Date.now());
    expect(Object.fromEntries(forms[0])).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client", client_secret: "secret" });
  });

  it("takes a new refresh token when Google gives one", async () => {
    answer = () => ({ status: 200, body: { access_token: "new", refresh_token: "refresh-2", expires_in: 3600 } });
    expect((await refreshGoogleTokens(app, tokens)).refreshToken).toBe("refresh-2");
  });

  it("asks for signing in again when Google took the sign-in back", async () => {
    answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    await expect(refreshGoogleTokens(app, tokens)).rejects.toMatchObject({ code: "signIn" });
  });

  it("counts anything else as not reaching Google, to try again later", async () => {
    answer = () => ({ status: 503, body: {} });
    await expect(refreshGoogleTokens(app, tokens)).rejects.toMatchObject({ code: "unreachable" });
    const url = GOOGLE_MAIL.tokenUrl;
    GOOGLE_MAIL.tokenUrl = "http://127.0.0.1:1/token";
    try {
      await expect(refreshGoogleTokens(app, tokens)).rejects.toMatchObject({ code: "unreachable" });
    } finally {
      GOOGLE_MAIL.tokenUrl = url;
    }
  });
});
