import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageError } from "./driver";
import { authorizationUrl, exchangeCode, oauthSession, pkce } from "./oauth-session";

/** A stand-in token endpoint: answers with what `answer` says and records the forms it was sent. */
let server: Server;
let tokenUrl: string;
const forms: URLSearchParams[] = [];
let answer: (form: URLSearchParams) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

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
  tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  forms.length = 0;
  answer = (form) =>
    form.get("grant_type") === "refresh_token"
      ? { status: 200, body: { access_token: `fresh-${forms.length}`, expires_in: 3600 } }
      : { status: 200, body: { access_token: "first", refresh_token: "refresh-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" } };
});

const app = { clientId: "client", clientSecret: "secret" };

describe("authorizationUrl", () => {
  it("asks Drive for drive.file only, offline, with PKCE", () => {
    const url = new URL(authorizationUrl("gdrive", app, { state: "st", challenge: "ch", redirectUri: "https://leafdesk.test/api/storage/oauth/callback" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client",
      scope: "https://www.googleapis.com/auth/drive.file",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: "https://leafdesk.test/api/storage/oauth/callback",
    });
  });

  it("asks Dropbox for a refresh token and only file content and the account", () => {
    const url = new URL(authorizationUrl("dropbox", app, { state: "st", challenge: "ch", redirectUri: "https://leafdesk.test/cb" }));
    expect(url.origin).toBe("https://www.dropbox.com");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["account_info.read", "files.content.read", "files.content.write"]);
  });
});

describe("pkce", () => {
  it("makes the S256 challenge of a fresh verifier", async () => {
    const { verifier, challenge } = pkce();
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    expect(challenge).toBe(digest);
    expect(pkce().verifier).not.toBe(verifier);
  });
});

describe("exchangeCode", () => {
  it("trades the code and verifier for tokens", async () => {
    const before = Date.now();
    const credentials = await exchangeCode("gdrive", app, { code: "the-code", verifier: "the-verifier", redirectUri: "https://leafdesk.test/cb" }, tokenUrl);
    expect(credentials).toMatchObject({ refreshToken: "refresh-1", accessToken: "first" });
    expect(credentials.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(Object.fromEntries(forms[0])).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://leafdesk.test/cb",
      client_id: "client",
      client_secret: "secret",
      code_verifier: "the-verifier",
    });
  });

  it("refuses a Drive sign-in where Drive access was unticked", async () => {
    answer = () => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid" } });
    await expect(exchangeCode("gdrive", app, { code: "c", verifier: "v", redirectUri: "https://x.test/cb" }, tokenUrl)).rejects.toThrow(/wasn't allowed/);
  });

  it("says what the provider refused", async () => {
    answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad code" } });
    const error = await exchangeCode("dropbox", app, { code: "c", verifier: "v", redirectUri: "https://x.test/cb" }, tokenUrl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).message).toBe("Dropbox sign-in failed: 400 invalid_grant: Bad code");
  });

  it("needs a refresh token", async () => {
    answer = () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } });
    await expect(exchangeCode("dropbox", app, { code: "c", verifier: "v", redirectUri: "https://x.test/cb" }, tokenUrl)).rejects.toThrow(/no refresh token/);
  });
});

describe("oauthSession", () => {
  const ok = () => new Response("ok", { status: 200 });

  it("uses the access token while it lasts", async () => {
    const session = oauthSession("gdrive", app, { refreshToken: "r", accessToken: "current", expiresAt: Date.now() + 3600_000 }, { tokenUrl });
    const used: string[] = [];
    await session.authorized(async (token) => (used.push(token), ok()));
    expect(used).toEqual(["current"]);
    expect(forms).toHaveLength(0);
  });

  it("refreshes a token about to run out, once for requests at the same time, and keeps the new one", async () => {
    const persist = vi.fn(async () => {});
    const session = oauthSession("dropbox", app, { refreshToken: "r", accessToken: "old", expiresAt: Date.now() + 10_000 }, { tokenUrl, persist });
    const used: string[] = [];
    await Promise.all([1, 2, 3].map(() => session.authorized(async (token) => (used.push(token), ok()))));
    expect(forms).toHaveLength(1);
    expect(Object.fromEntries(forms[0])).toEqual({ grant_type: "refresh_token", refresh_token: "r", client_id: "client", client_secret: "secret" });
    expect(used).toEqual(["fresh-1", "fresh-1", "fresh-1"]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "r", accessToken: "fresh-1" }));
    expect(session.credentials().accessToken).toBe("fresh-1");
  });

  it("keeps a refresh token the provider replaced", async () => {
    answer = () => ({ status: 200, body: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } });
    const persist = vi.fn(async () => {});
    const session = oauthSession("gdrive", app, { refreshToken: "r" }, { tokenUrl, persist });
    await session.authorized(async () => ok());
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "r2", accessToken: "a2" }));
  });

  it("tries a refused token once more with a fresh one", async () => {
    const session = oauthSession("gdrive", app, { refreshToken: "r", accessToken: "revoked", expiresAt: Date.now() + 3600_000 }, { tokenUrl });
    const used: string[] = [];
    const res = await session.authorized(async (token) => {
      used.push(token);
      return token === "revoked" ? new Response("no", { status: 401 }) : ok();
    });
    expect(res.status).toBe(200);
    expect(used).toEqual(["revoked", "fresh-1"]);
  });

  it("turns a revoked sign-in into a refusal that isn't passing", async () => {
    answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    const session = oauthSession("gdrive", app, { refreshToken: "gone" }, { tokenUrl });
    const error = await session.authorized(async () => ok()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).status).toBe(401);
    expect((error as StorageError).transient).toBe(false);
    expect((error as StorageError).message).toMatch(/invalid_grant.*sign in again/);
  });

  it("counts a busy token endpoint as passing", async () => {
    answer = () => ({ status: 503, body: { error: "unavailable" } });
    const session = oauthSession("dropbox", app, { refreshToken: "r" }, { tokenUrl });
    const error = (await session.authorized(async () => ok()).catch((e: unknown) => e)) as StorageError;
    expect(error.transient).toBe(true);
  });

  it("keeps working when the refreshed sign-in can't be kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = oauthSession("dropbox", app, { refreshToken: "r" }, { tokenUrl, persist: async () => Promise.reject(new Error("db down")) });
    const res = await session.authorized(async () => ok());
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
