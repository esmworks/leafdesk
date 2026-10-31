import { createHash, randomBytes } from "node:crypto";

/**
 * What signing in to a mailbox with Google (google.ts) and with Microsoft (microsoft.ts) share:
 * PKCE, the token endpoint's answers, the tokens kept sealed in the mailbox's `secret` and the
 * claims of the ID token that came with them. IMAP and SMTP then sign in with XOAUTH2 (connect.ts).
 */

/** A sign-in as kept, sealed, in the mailbox's `secret`. */
export type MailOAuthTokens = { refreshToken: string; accessToken: string; expiresAt: number };

/** The OAuth client the instance registered with a provider. */
export type OAuthApp = { clientId: string; clientSecret: string };

/** Why a sign-in didn't give a mailbox: the provider refused or couldn't be reached, or mail access wasn't allowed. */
export class MailSignInError extends Error {
  constructor(
    readonly reason: "failed" | "scope",
    message: string,
  ) {
    super(message);
  }
}

/** A fresh PKCE verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string; error_description?: string };

/** A POST to a token endpoint: its answer, or what it said when it refused (`status` null when it couldn't be reached). */
export async function tokenRequest(url: string, form: Record<string, string>): Promise<{ answer: TokenAnswer; status: number | null; said: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { answer: {}, status: null, said: error instanceof Error ? error.message : String(error) };
  }
  const text = await res.text().catch(() => "");
  let answer: TokenAnswer = {};
  try {
    answer = JSON.parse(text) as TokenAnswer;
  } catch {
    // Not JSON: said by its text.
  }
  const said = answer.error ? `${answer.error}${answer.error_description ? `: ${answer.error_description}` : ""}` : text.replace(/\s+/g, " ").trim().slice(0, 200);
  return { answer, status: res.ok && answer.access_token ? res.status : res.ok ? 400 : res.status, said };
}

export const expiresAt = (answer: TokenAnswer, now = Date.now()) => now + Math.max(0, Number(answer.expires_in ?? 3600)) * 1000;

/**
 * The claims of an ID token. It came straight from the provider's token endpoint over TLS, not
 * through the browser, so they are read without checking its signature (OpenID Connect Core 3.1.3.7).
 */
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
