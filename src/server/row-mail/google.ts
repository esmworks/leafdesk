import { createHash, randomBytes } from "node:crypto";
import { MAIL_PROVIDERS, type MailboxServers } from "@/lib/mail";
import { MailConnectError } from "./connect";

/**
 * Connecting a Gmail or Google Workspace mailbox by signing in with Google instead of typing an app
 * password: the authorization address with PKCE, the code traded for tokens, and an access token
 * refreshed before it runs out. IMAP and SMTP then sign in with XOAUTH2 (connect.ts).
 *
 * Gmail's IMAP and SMTP take only the full mail scope; `openid email` gives the address the
 * mailbox is. The addresses are Google's, fixed here and never typed by anyone; the end-to-end
 * check points them at a stand-in.
 */

export const GOOGLE_MAIL = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  servers: MAIL_PROVIDERS.find((p) => p.id === "google")!.servers as MailboxServers,
};

/** The scope Gmail's IMAP and SMTP ask an access token for. */
export const GOOGLE_MAIL_SCOPE = "https://mail.google.com/";

/** A Google sign-in as kept, sealed, in the mailbox's `secret`. */
export type GoogleMailTokens = { refreshToken: string; accessToken: string; expiresAt: number };

export type GoogleApp = { clientId: string; clientSecret: string };

/** Why a sign-in didn't give a mailbox: Google refused or couldn't be reached, or mail access wasn't allowed. */
export class GoogleSignInError extends Error {
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

/** Where to send the browser to sign in; `loginHint` picks the account when the person has several. */
export function googleAuthorizationUrl(app: GoogleApp, input: { state: string; challenge: string; redirectUri: string; loginHint?: string | null }): string {
  const url = new URL(GOOGLE_MAIL.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: input.redirectUri,
    scope: `openid email ${GOOGLE_MAIL_SCOPE}`,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    // Without both, Google gives no refresh token (or only the first time).
    access_type: "offline",
    prompt: "consent",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  }).toString();
  return url.href;
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string; error_description?: string };

/** A POST to Google's token endpoint: its answer, or what it said when it refused (`status` null when it couldn't be reached). */
async function tokenRequest(form: Record<string, string>): Promise<{ answer: TokenAnswer; status: number | null; said: string }> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_MAIL.tokenUrl, {
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

const expiresAt = (answer: TokenAnswer, now = Date.now()) => now + Math.max(0, Number(answer.expires_in ?? 3600)) * 1000;

/**
 * The verified address in the ID token. It came straight from Google's token endpoint over TLS, not
 * through the browser, so its claims are read without checking its signature (OpenID Connect Core 3.1.3.7).
 */
export function idTokenEmail(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown; email_verified?: unknown };
    return typeof claims.email === "string" && (claims.email_verified === true || claims.email_verified === "true") ? claims.email : null;
  } catch {
    return null;
  }
}

/** Trades the code the browser came back with for tokens (with the PKCE verifier), and the address they are for. */
export async function exchangeGoogleCode(app: GoogleApp, input: { code: string; verifier: string; redirectUri: string }): Promise<{ tokens: GoogleMailTokens; email: string }> {
  const { answer, status, said } = await tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code_verifier: input.verifier,
  });
  if (status !== 200 || !answer.access_token) throw new GoogleSignInError("failed", `Google sign-in failed: ${status ?? "unreachable"} ${said}`.trim());
  // Google lets people untick what an app asks for; without mail nothing would work.
  if (answer.scope !== undefined && !answer.scope.split(" ").includes(GOOGLE_MAIL_SCOPE)) {
    throw new GoogleSignInError("scope", "Google sign-in didn't allow access to mail");
  }
  const email = idTokenEmail(answer.id_token);
  if (!email) throw new GoogleSignInError("failed", "Google sign-in gave no verified address");
  if (!answer.refresh_token) throw new GoogleSignInError("failed", "Google sign-in gave no refresh token");
  return { tokens: { refreshToken: answer.refresh_token, accessToken: answer.access_token, expiresAt: expiresAt(answer) }, email };
}

/**
 * A new access token for a sign-in. Google refusing the refresh token (`invalid_grant`: access was
 * taken back, the password changed, the client changed) means signing in again; anything else may
 * pass, and counts as not reaching the server.
 */
export async function refreshGoogleTokens(app: GoogleApp, tokens: GoogleMailTokens): Promise<GoogleMailTokens> {
  const { answer, status, said } = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  if (status === 200 && answer.access_token) {
    return { refreshToken: answer.refresh_token || tokens.refreshToken, accessToken: answer.access_token, expiresAt: expiresAt(answer) };
  }
  if (answer.error === "invalid_grant" || answer.error === "unauthorized_client" || answer.error === "invalid_client") {
    throw new MailConnectError("signIn", `Google refused the sign-in: ${said}`);
  }
  throw new MailConnectError("unreachable", `Google sign-in refresh failed: ${status ?? "unreachable"} ${said}`.trim());
}
