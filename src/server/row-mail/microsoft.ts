import type { MailboxServers } from "@/lib/mail";
import { MICROSOFT_SERVERS } from "@/lib/mail-discover";
import { MailConnectError } from "./connect";
import { expiresAt, idTokenClaims, MailSignInError, tokenRequest, type MailOAuthTokens, type OAuthApp } from "./oauth";

/**
 * Connecting an Outlook.com or Microsoft 365 mailbox by signing in with Microsoft, the only way
 * Microsoft's IMAP and SMTP still take: the authorization address with PKCE, the code traded for
 * tokens, and an access token refreshed before it runs out (Microsoft hands out a new refresh token
 * each time, which is kept). IMAP and SMTP then sign in with XOAUTH2 (connect.ts).
 *
 * The address comes from the ID token (`email`, else `preferred_username`), which Microsoft doesn't
 * vouch for; it is the mailbox the connection is then tried with, and Microsoft's IMAP lets the
 * token into that mailbox only if its person may read it. Personal accounts (the consumer tenant)
 * send through Outlook.com's SMTP server, work and school accounts through Microsoft 365's.
 * The addresses are Microsoft's, fixed here; the end-to-end check points them at a stand-in.
 */

export type MicrosoftApp = OAuthApp & { tenant: string };

export const MICROSOFT_MAIL = {
  login: "https://login.microsoftonline.com",
  servers: MICROSOFT_SERVERS,
  personalServers: { ...MICROSOFT_SERVERS, smtpHost: "smtp-mail.outlook.com" } as MailboxServers,
};

/** The tenant of personal Microsoft accounts. */
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** What Microsoft's IMAP and SMTP ask an access token for. */
export const MICROSOFT_MAIL_SCOPES = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"];
const SCOPE = `openid email profile offline_access ${MICROSOFT_MAIL_SCOPES.join(" ")}`;

const endpoint = (app: MicrosoftApp, path: "authorize" | "token") => `${MICROSOFT_MAIL.login}/${encodeURIComponent(app.tenant)}/oauth2/v2.0/${path}`;

/** Where to send the browser to sign in; `loginHint` picks the account when the person has several. */
export function microsoftAuthorizationUrl(app: MicrosoftApp, input: { state: string; challenge: string; redirectUri: string; loginHint?: string | null }): string {
  const url = new URL(endpoint(app, "authorize"));
  url.search = new URLSearchParams({
    response_type: "code",
    response_mode: "query",
    client_id: app.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    // Lets a person signed in to several accounts pick the mailbox's.
    prompt: "select_account",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  }).toString();
  return url.href;
}

/** The address an ID token names, and whether it is a personal account's. */
export function microsoftIdentity(idToken: string | undefined): { email: string; personal: boolean } | null {
  const claims = idTokenClaims(idToken);
  const email = [claims?.email, claims?.preferred_username].find((value): value is string => typeof value === "string" && value.includes("@"));
  return email ? { email, personal: claims?.tid === CONSUMER_TENANT } : null;
}

/** Whether the scopes a token was granted take in reading and sending mail. */
export const grantsMail = (scope: string | undefined) => {
  // Microsoft names the scopes it granted with their resource, which may be written several ways, or without it.
  const name = (s: string) => s.slice(s.lastIndexOf("/") + 1).toLowerCase();
  const granted = (scope ?? "").split(" ").map(name);
  return MICROSOFT_MAIL_SCOPES.every((wanted) => granted.includes(name(wanted)));
};

/** Trades the code the browser came back with for tokens (with the PKCE verifier), the address they are for and its servers. */
export async function exchangeMicrosoftCode(
  app: MicrosoftApp,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<{ tokens: MailOAuthTokens; email: string; servers: MailboxServers }> {
  const { answer, status, said } = await tokenRequest(endpoint(app, "token"), {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code_verifier: input.verifier,
    scope: SCOPE,
  });
  if (status !== 200 || !answer.access_token) throw new MailSignInError("failed", `Microsoft sign-in failed: ${status ?? "unreachable"} ${said}`.trim());
  if (answer.scope !== undefined && !grantsMail(answer.scope)) throw new MailSignInError("scope", "Microsoft sign-in didn't allow access to mail");
  const identity = microsoftIdentity(answer.id_token);
  if (!identity) throw new MailSignInError("failed", "Microsoft sign-in gave no address");
  if (!answer.refresh_token) throw new MailSignInError("failed", "Microsoft sign-in gave no refresh token");
  return {
    tokens: { refreshToken: answer.refresh_token, accessToken: answer.access_token, expiresAt: expiresAt(answer) },
    email: identity.email,
    servers: identity.personal ? MICROSOFT_MAIL.personalServers : MICROSOFT_MAIL.servers,
  };
}

/**
 * A new access token (and refresh token) for a sign-in. Microsoft refusing the refresh token
 * (`invalid_grant`: it ran out or was taken back, the password changed; `interaction_required`: a
 * policy wants the person to sign in again) means signing in again; anything else may pass.
 */
export async function refreshMicrosoftTokens(app: MicrosoftApp, tokens: MailOAuthTokens): Promise<MailOAuthTokens> {
  const { answer, status, said } = await tokenRequest(endpoint(app, "token"), {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    scope: SCOPE,
  });
  if (status === 200 && answer.access_token) {
    return { refreshToken: answer.refresh_token || tokens.refreshToken, accessToken: answer.access_token, expiresAt: expiresAt(answer) };
  }
  if (["invalid_grant", "interaction_required", "consent_required", "unauthorized_client", "invalid_client"].includes(answer.error ?? "")) {
    throw new MailConnectError("signIn", `Microsoft refused the sign-in: ${said}`);
  }
  throw new MailConnectError("unreachable", `Microsoft sign-in refresh failed: ${status ?? "unreachable"} ${said}`.trim());
}
