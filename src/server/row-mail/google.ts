import { MAIL_PROVIDERS, type MailboxServers } from "@/lib/mail";
import { MailConnectError } from "./connect";
import { expiresAt, idTokenClaims, MailSignInError, tokenRequest, type MailOAuthTokens, type OAuthApp } from "./oauth";

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
export type GoogleMailTokens = MailOAuthTokens;

export type GoogleApp = OAuthApp;

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

/** The verified address in Google's ID token (oauth.ts `idTokenClaims`). */
export function idTokenEmail(idToken: string | undefined): string | null {
  const claims = idTokenClaims(idToken);
  return typeof claims?.email === "string" && (claims.email_verified === true || claims.email_verified === "true") ? claims.email : null;
}

/** Trades the code the browser came back with for tokens (with the PKCE verifier), and the address they are for. */
export async function exchangeGoogleCode(app: GoogleApp, input: { code: string; verifier: string; redirectUri: string }): Promise<{ tokens: GoogleMailTokens; email: string }> {
  const { answer, status, said } = await tokenRequest(GOOGLE_MAIL.tokenUrl, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code_verifier: input.verifier,
  });
  if (status !== 200 || !answer.access_token) throw new MailSignInError("failed", `Google sign-in failed: ${status ?? "unreachable"} ${said}`.trim());
  // Google lets people untick what an app asks for; without mail nothing would work.
  if (answer.scope !== undefined && !answer.scope.split(" ").includes(GOOGLE_MAIL_SCOPE)) {
    throw new MailSignInError("scope", "Google sign-in didn't allow access to mail");
  }
  const email = idTokenEmail(answer.id_token);
  if (!email) throw new MailSignInError("failed", "Google sign-in gave no verified address");
  if (!answer.refresh_token) throw new MailSignInError("failed", "Google sign-in gave no refresh token");
  return { tokens: { refreshToken: answer.refresh_token, accessToken: answer.access_token, expiresAt: expiresAt(answer) }, email };
}

/**
 * A new access token for a sign-in. Google refusing the refresh token (`invalid_grant`: access was
 * taken back, the password changed, the client changed) means signing in again; anything else may
 * pass, and counts as not reaching the server.
 */
export async function refreshGoogleTokens(app: GoogleApp, tokens: GoogleMailTokens): Promise<GoogleMailTokens> {
  const { answer, status, said } = await tokenRequest(GOOGLE_MAIL.tokenUrl, {
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
