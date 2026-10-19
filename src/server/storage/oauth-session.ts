import { createHash, randomBytes } from "node:crypto";
import type { StorageOAuthApp } from "@/lib/env";
import type { OAuthCredentials, OAuthStorageKind } from "@/lib/workspace-storage";
import { StorageError } from "./driver";

/**
 * Signing in to a storage provider (Google Drive, Dropbox) and keeping the sign-in working: the
 * authorization address with PKCE, the code exchanged for tokens, and an access token refreshed
 * before it runs out (or when the provider refuses it), the new one handed to `persist` so the
 * sealed credentials stay current. A refresh the provider refuses (the owner revoked Leafdesk's
 * access, or the app changed) is a StorageError with the provider's status, which marks the
 * storage broken (server/storage/workspace.ts).
 *
 * The providers' addresses are fixed here, never typed by anyone, so the guarded fetch of
 * connections and typed S3 endpoints isn't needed; tests point them at a stand-in.
 */

export type OAuthProviderInfo = {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Extra authorization parameters: what makes the provider give a refresh token. */
  params: Record<string, string>;
};

export const OAUTH_PROVIDERS: Record<OAuthStorageKind, OAuthProviderInfo> = {
  gdrive: {
    name: "Google Drive",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Only the files and folders Leafdesk makes: nothing else in the Drive.
    scope: "https://www.googleapis.com/auth/drive.file",
    params: { access_type: "offline", prompt: "consent" },
  },
  dropbox: {
    name: "Dropbox",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    // The app is an App folder app: these reach only its folder.
    scope: "account_info.read files.content.read files.content.write",
    params: { token_access_type: "offline" },
  },
};

/** A fresh PKCE verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where to send the browser to sign in. */
export function authorizationUrl(kind: OAuthStorageKind, app: StorageOAuthApp, input: { state: string; challenge: string; redirectUri: string }): string {
  const provider = OAUTH_PROVIDERS[kind];
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: input.redirectUri,
    scope: provider.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    ...provider.params,
  }).toString();
  return url.href;
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

/** A POST to the token endpoint; a refusal is a StorageError with the provider's status and error. */
async function tokenRequest(kind: OAuthStorageKind, tokenUrl: string, form: Record<string, string>, what: string): Promise<TokenAnswer> {
  const provider = OAUTH_PROVIDERS[kind];
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
    });
  } catch (error) {
    throw new StorageError(`${provider.name} ${what} failed: ${causeOf(error)}`, null, { cause: error });
  }
  const text = await res.text().catch(() => "");
  let answer: TokenAnswer = {};
  try {
    answer = JSON.parse(text) as TokenAnswer;
  } catch {
    // Not JSON: said below by its text.
  }
  if (!res.ok || !answer.access_token) {
    const said = answer.error ? `${answer.error}${answer.error_description ? `: ${answer.error_description}` : ""}` : text.replace(/\s+/g, " ").trim().slice(0, 200);
    // Asked for a token and given none, with a 200: no sign the provider is busy.
    throw new StorageError(`${provider.name} ${what} failed: ${res.status} ${said}`.trim(), res.ok ? 400 : res.status);
  }
  return answer;
}

const credentialsOf = (answer: TokenAnswer, refreshToken: string | undefined, now = Date.now()): OAuthCredentials => {
  const token = answer.refresh_token || refreshToken;
  if (!token) throw new StorageError("The sign-in gave no refresh token", 400);
  return { refreshToken: token, accessToken: answer.access_token, expiresAt: now + Math.max(0, Number(answer.expires_in ?? 3600)) * 1000 };
};

/** Trades the code the browser came back with for tokens (with the PKCE verifier). */
export async function exchangeCode(
  kind: OAuthStorageKind,
  app: StorageOAuthApp,
  input: { code: string; verifier: string; redirectUri: string },
  tokenUrl = OAUTH_PROVIDERS[kind].tokenUrl,
): Promise<OAuthCredentials> {
  const answer = await tokenRequest(
    kind,
    tokenUrl,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code_verifier: input.verifier,
    },
    "sign-in",
  );
  // Google lets people untick what an app asks for; without it nothing would work.
  if (kind === "gdrive" && answer.scope !== undefined && !answer.scope.split(" ").includes(OAUTH_PROVIDERS.gdrive.scope)) {
    throw new StorageError("Google Drive sign-in failed: access to Drive wasn't allowed", 403);
  }
  return credentialsOf(answer, undefined);
}

/** A request made with the access token; given a fresh one when the provider refused the first. */
export type Authorized = (send: (accessToken: string) => Promise<Response>) => Promise<Response>;

export type OAuthSession = {
  /** A current access token (refreshed when about to run out). */
  accessToken: () => Promise<string>;
  /** Makes the request with a current access token, once more with a new one after a 401. */
  authorized: Authorized;
  /** The credentials as they are now (after any refresh). */
  credentials: () => OAuthCredentials;
};

/** Refreshes this long before the access token runs out. */
const EARLY_MS = 60_000;

/**
 * Keeps an access token for a sign-in: refreshed when it is about to run out or was refused, one
 * refresh at a time, each new set of credentials handed to `persist` (whose failure only costs
 * another refresh later).
 */
export function oauthSession(
  kind: OAuthStorageKind,
  app: StorageOAuthApp,
  initial: OAuthCredentials,
  options: { persist?: (credentials: OAuthCredentials) => Promise<void>; tokenUrl?: string } = {},
): OAuthSession {
  let current = { ...initial };
  let refreshing: Promise<string> | null = null;

  const refresh = () => {
    refreshing ??= (async () => {
      try {
        const answer = await tokenRequest(
          kind,
          options.tokenUrl ?? OAUTH_PROVIDERS[kind].tokenUrl,
          { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: app.clientId, client_secret: app.clientSecret },
          "sign-in refresh",
        ).catch((error: unknown) => {
          // invalid_grant is the provider saying the sign-in is gone: say what to do about it.
          if (error instanceof StorageError && error.status !== null && !error.transient && /invalid_grant/.test(error.message)) {
            throw new StorageError(`${error.message} (sign in again)`, error.status === 400 ? 401 : error.status, { cause: error });
          }
          throw error;
        });
        current = credentialsOf(answer, current.refreshToken);
        await options.persist?.(current).catch((error) => console.warn("[storage] couldn't keep a refreshed sign-in", error));
        return current.accessToken!;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const token = async () => {
    if (current.accessToken && (current.expiresAt ?? 0) - EARLY_MS > Date.now()) return current.accessToken;
    return refresh();
  };

  return {
    accessToken: token,
    credentials: () => current,
    async authorized(send) {
      const used = await token();
      const res = await send(used);
      if (res.status !== 401) return res;
      await res.body?.cancel().catch(() => undefined);
      // Another request may have refreshed it meanwhile.
      const fresh = current.accessToken && current.accessToken !== used ? current.accessToken : await refresh();
      return send(fresh);
    },
  };
}

const RETRIES = 2;

/**
 * A provider API request (made by `send`), tried again on a server error or "slow down" (as
 * `busy` tells), a failure to connect a StorageError naming `what`.
 */
export async function apiRequest(what: string, send: () => Promise<Response>, busy: (res: Response) => boolean = defaultBusy): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await send();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`${what} failed: ${causeOf(error)}`, null, { cause: error });
    }
    if (!busy(res) || attempt >= RETRIES) return res;
    await res.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 100 * 2 ** attempt));
  }
}

const defaultBusy = (res: Response) => res.status >= 500 || res.status === 429;

export const causeOf = (error: unknown) => {
  const cause = (error as { cause?: { message?: string } }).cause;
  return cause?.message ?? (error instanceof Error ? error.message : String(error));
};

/** The start of an answer as text (for an error), without reading more of it than that. */
export async function answerText(res: Response, limit = 2000): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch {
    // What arrived is enough.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, limit);
}
