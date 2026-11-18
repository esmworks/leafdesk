import { createPublicKey, verify } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Teams' calls to the bot, authenticated as the Bot Connector documents it (Authenticate requests
 * from the Bot Connector service to your bot): a bearer JWT signed RS256 with a key of the
 * Connector's OpenID metadata (`jwks_uri`), whose issuer is https://api.botframework.com, whose
 * audience is the bot's application id, within its validity (five minutes of skew), whose key is
 * endorsed for the activity's channel (`msteams`) and whose `serviceurl` claim is the activity's
 * `serviceUrl`. The token doesn't sign the body, so the claim check is what binds the body to it.
 * Written on node:crypto: there is no JWT library among the dependencies, and RS256 is short.
 * Nothing here can be turned off.
 */

export const BOT_ISSUER = "https://api.botframework.com";
export const TEAMS_CHANNEL = "msteams";
const SKEW_SECONDS = 300;
/** Keys are read again after this long, and (at most this often) when a token names one not known. */
const KEYS_MAX_AGE_MS = 24 * 3_600_000;
const KEYS_RETRY_MS = 60_000;
const MAX_DOCUMENT = 512 * 1024;

export type SigningKey = { kty?: string; kid?: string; n?: string; e?: string; endorsements?: string[] };

export class TeamsAuthError extends Error {
  constructor(
    message: string,
    /** 401: no valid token. 403: a valid token that doesn't cover this call. */
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "TeamsAuthError";
  }
}

export type Verified = { claims: Record<string, unknown>; key: SigningKey };

const decodePart = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The signature and claims of a token against the keys: the claims and the key that signed it. Pure; throws TeamsAuthError. */
export function verifyToken(token: string, keys: readonly SigningKey[], { appId, now = Date.now() }: { appId: string; now?: number }): Verified {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p || !/^[\w-]+$/.test(p))) throw new TeamsAuthError("malformed token");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) throw new TeamsAuthError("malformed token");
  // The one algorithm the metadata names; never what the token asks for.
  if (header.alg !== "RS256") throw new TeamsAuthError("unexpected algorithm");
  const key = typeof header.kid === "string" ? keys.find((k) => k.kid === header.kid) : undefined;
  if (!key || key.kty !== "RSA" || !key.n || !key.e) throw new TeamsAuthError("unknown signing key");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) throw new TeamsAuthError("bad signature");
  if (claims.iss !== BOT_ISSUER) throw new TeamsAuthError("unexpected issuer");
  if (claims.aud !== appId) throw new TeamsAuthError("unexpected audience");
  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < seconds) throw new TeamsAuthError("token expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - SKEW_SECONDS > seconds)) throw new TeamsAuthError("token not yet valid");
  return { claims, key };
}

/**
 * Whether a verified token covers the activity it came with: its `serviceurl` claim is the
 * activity's `serviceUrl`, and its key is endorsed for the activity's channel, which is Teams'.
 */
export function checkActivity({ claims, key }: Verified, activity: { serviceUrl?: unknown; channelId?: unknown }) {
  const claimed = claims.serviceurl ?? claims.serviceUrl;
  if (typeof claimed !== "string" || typeof activity.serviceUrl !== "string" || claimed !== activity.serviceUrl) {
    throw new TeamsAuthError("the service address isn't the token's", 403);
  }
  if (activity.channelId !== TEAMS_CHANNEL) throw new TeamsAuthError("not a Teams call", 403);
  if (!key.endorsements?.includes(TEAMS_CHANNEL)) throw new TeamsAuthError("the key isn't endorsed for Teams", 403);
}

// ------------------------------------------------------------------------------------ the keys

let cache: { keys: SigningKey[]; at: number } | null = null;
let loading: Promise<SigningKey[]> | null = null;
let lastTried = 0;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_DOCUMENT) throw new Error("document too large");
  return JSON.parse(text);
}

async function fetchKeys(): Promise<SigningKey[]> {
  const metadata = (await getJson(env.teamsOpenIdUrl)) as { jwks_uri?: unknown; id_token_signing_alg_values_supported?: unknown };
  if (typeof metadata.jwks_uri !== "string") throw new Error("no jwks_uri");
  // The keys come from where the metadata is: another host's address in it is never followed.
  if (new URL(metadata.jwks_uri).origin !== new URL(env.teamsOpenIdUrl).origin) throw new Error("jwks_uri on another host");
  const document = (await getJson(metadata.jwks_uri)) as { keys?: unknown };
  if (!Array.isArray(document.keys)) throw new Error("no keys");
  return document.keys.filter((k): k is SigningKey => Boolean(k) && typeof k === "object");
}

/** The signing keys: kept up to a day, read again (once a minute at most) when `kid` isn't among them. */
async function signingKeys(kid: string | null): Promise<SigningKey[]> {
  const now = Date.now();
  const fresh = cache && now - cache.at < KEYS_MAX_AGE_MS;
  const known = cache?.keys.some((k) => k.kid === kid);
  if (cache && fresh && (known || now - lastTried < KEYS_RETRY_MS)) return cache.keys;
  lastTried = now;
  loading ??= fetchKeys()
    .then((keys) => {
      cache = { keys, at: Date.now() };
      return keys;
    })
    .finally(() => {
      loading = null;
    });
  try {
    return await loading;
  } catch (error) {
    // A reading that failed leaves the keys held so far in use.
    if (cache) return cache.keys;
    throw new TeamsAuthError(`couldn't read the signing keys (${error instanceof Error ? error.message : "error"})`, 401);
  }
}

/** Tests: forgets the keys held. */
export function resetTeamsKeys() {
  cache = null;
  loading = null;
  lastTried = 0;
}

/** Verifies the request's `Authorization` header: the token's claims and key; throws TeamsAuthError. */
export async function authenticate(authorization: string | null): Promise<Verified> {
  const appId = env.teamsAppId;
  if (!appId) throw new TeamsAuthError("Teams isn't set up", 401);
  const match = /^Bearer ([\w.-]{20,4096})$/.exec(authorization ?? "");
  if (!match) throw new TeamsAuthError("no bearer token");
  const header = decodePart(match[1].split(".")[0] ?? "");
  const kid = typeof header?.kid === "string" ? header.kid : null;
  return verifyToken(match[1], await signingKeys(kid), { appId });
}
