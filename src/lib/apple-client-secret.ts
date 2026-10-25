import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { SocialCredentials } from "@/lib/social-providers";

/**
 * Sign in with Apple's client secret: a JWT signed (ES256) with a key made in Apple's developer
 * account, which Apple accepts for at most six months. Given APPLE_TEAM_ID, APPLE_KEY_ID and
 * APPLE_PRIVATE_KEY (the .p8 file's text; "\n" may stand for its line breaks), the server makes
 * it itself and makes a new one well before it runs out, so nobody has to renew it by hand.
 * Server-only (node:crypto); lib/env.ts reads it. APPLE_CLIENT_SECRET, a JWT made elsewhere,
 * is used as it is instead (lib/social-providers).
 */

/** How long a secret made here is valid (Apple's limit is 15,777,000 seconds), and when it is made again. */
const LIFETIME_S = 180 * 24 * 60 * 60;
const RENEW_AFTER_S = 150 * 24 * 60 * 60;

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** A client secret for `clientId` (the Services ID), signed with `key` as key `keyId` of team `teamId`, made at `now` (seconds). */
export function appleClientSecret(input: { clientId: string; teamId: string; keyId: string; key: KeyObject }, now: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: input.keyId, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: input.teamId, iat: now, exp: now + LIFETIME_S, aud: "https://appleid.apple.com", sub: input.clientId }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: input.key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * Apple's credentials made from a key: null unless APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and
 * APPLE_PRIVATE_KEY are all set. `clientSecret` is read when Apple is called, and is remade once
 * it is older than RENEW_AFTER_S. Throws for a private key that can't be read, so a broken setup
 * shows at start rather than at the first sign-in.
 */
export function appleCredentialsFromKey(source: Record<string, string | undefined>, clock = () => Date.now()): SocialCredentials | null {
  const clientId = source.APPLE_CLIENT_ID?.trim();
  const teamId = source.APPLE_TEAM_ID?.trim();
  const keyId = source.APPLE_KEY_ID?.trim();
  const pem = source.APPLE_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  if (!clientId || !teamId || !keyId || !pem) return null;
  const key = createPrivateKey(pem);
  let made: { at: number; secret: string } | null = null;
  return {
    clientId,
    get clientSecret() {
      const now = Math.floor(clock() / 1000);
      if (!made || now - made.at > RENEW_AFTER_S) made = { at: now, secret: appleClientSecret({ clientId, teamId, keyId, key }, now) };
      return made.secret;
    },
  };
}
