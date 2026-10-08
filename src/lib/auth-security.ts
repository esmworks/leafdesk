import type { BetterAuthPlugin } from "better-auth";
import { addOAuthServerContext, APIError, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { sameOriginPath } from "@/lib/same-origin";
import { verifyTotp } from "@/lib/totp";

/**
 * Two-step verification (authenticator app codes plus one-time recovery codes) and passkeys.
 * Database-independent like the rest of baseAuthOptions, so the schema generator sees the tables.
 */

export const APP_NAME = "Leafdesk";

/** How a session was signed in, kept on the session row (`session.auth_method`). */
export type AuthMethod = "password" | "social" | "sso" | "passkey" | "totp" | "recovery-code";

/** The endpoints where a single sign-on (OIDC callback, SAML assertion consumer) signs someone in. */
export const SSO_SIGN_IN_PATHS = ["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"] as const;
export const isSsoSignInPath = (path: string | undefined) =>
  (SSO_SIGN_IN_PATHS as readonly (string | undefined)[]).includes(path);

const AUTH_METHOD_BY_PATH: Record<string, AuthMethod> = {
  "/sign-in/email": "password",
  "/sign-up/email": "password",
  "/sign-in/social": "social",
  "/callback/:id": "social",
  "/sso/callback/:providerId": "sso",
  "/sso/saml2/sp/acs/:providerId": "sso",
  "/passkey/verify-authentication": "passkey",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "recovery-code",
};

/** The sign-in method behind a new session, from the endpoint that creates it. */
export function authMethodOf(path: string | undefined): AuthMethod | null {
  return (path && Object.hasOwn(AUTH_METHOD_BY_PATH, path) && AUTH_METHOD_BY_PATH[path]) || null;
}

type SessionHookContext =
  | {
      path?: string;
      params?: unknown;
      context?: object;
      getSignedCookie?: (name: string, secret: string) => Promise<string | null | false | undefined>;
    }
  | null
  | undefined;

/**
 * Cookie that carries a single sign-on across the two-step code: the provider and user of an SSO
 * sign-in held back for a code, so the session the code creates still counts as that single
 * sign-on (a workspace's "SSO only" policy asks for it). Signed, short-lived like the code step.
 */
export const SSO_PENDING_COOKIE = "leafdesk.sso_pending";
export const SSO_PENDING_MAX_AGE = 600;

const CODE_STEP_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/** The SSO provider behind a code step's pending sign-in, when it was one and is this user's. */
async function ssoPendingOf(ctx: SessionHookContext, userId: unknown, secret: string | undefined) {
  if (!ctx?.getSignedCookie || !secret || !CODE_STEP_PATHS.has(ctx.path ?? "")) return null;
  const value = await ctx.getSignedCookie(SSO_PENDING_COOKIE, secret).catch(() => null);
  return typeof value === "string" ? ssoPendingProvider(value, userId) : null;
}

/** `<provider id>!<user id>` → the provider, when the user matches. */
export function ssoPendingProvider(value: string, userId: unknown) {
  const cut = value.lastIndexOf("!");
  if (cut < 1 || typeof userId !== "string" || value.slice(cut + 1) !== userId) return null;
  return value.slice(0, cut);
}

/** The provider an SSO endpoint signed in with (`/sso/callback/:providerId`), else null. */
function ssoProviderOf(ctx: SessionHookContext) {
  if (!isSsoSignInPath(ctx?.path)) return null;
  const id = (ctx?.params as { providerId?: unknown } | undefined)?.providerId;
  return typeof id === "string" && id ? id : null;
}

/**
 * `databaseHooks.session.create.before`: records how the session was signed in and, for a single
 * sign-on, with which provider. A session recreated from another keeps the original: turning
 * two-step verification on or off copies the old session, and changing the password with "sign
 * out other sessions" replaces the current one from within that request (its session is on the
 * context), so a passkey sign-in stays one. The code step after a single sign-on keeps its
 * provider (SSO_PENDING_COOKIE), though the method becomes the code.
 */
export async function recordAuthMethod<S extends Record<string, unknown>>(session: S, ctx: SessionHookContext) {
  const existing = (session as { authMethod?: string | null }).authMethod;
  const context = ctx?.context as
    | {
        session?: { session?: { authMethod?: string | null; ssoProviderId?: string | null } | null } | null;
        secret?: string;
      }
    | undefined;
  const current = context?.session?.session;
  const named = authMethodOf(ctx?.path);
  if (existing != null) {
    const sso = (session as { ssoProviderId?: string | null }).ssoProviderId ?? null;
    return { data: { ...session, authMethod: existing, ssoProviderId: sso } };
  }
  const sso = named
    ? (ssoProviderOf(ctx) ?? (await ssoPendingOf(ctx, (session as { userId?: unknown }).userId, context?.secret)))
    : (current?.ssoProviderId ?? null);
  return { data: { ...session, authMethod: named ?? current?.authMethod ?? null, ssoProviderId: sso } };
}

/**
 * Whether a session passes a workspace's "require two-step verification" policy. With two-step
 * verification on, every way of signing in asks for a code (password, and social sign-in via
 * `socialTwoFactorChallenge`), so all of that user's sessions count. A passkey is two factors
 * in one (the device and its unlock), so a session signed in with one counts too; a passkey
 * registered on an account that signs in with a password alone does not.
 */
export function isStrongSession(session: {
  user: { twoFactorEnabled?: boolean | null };
  session: { authMethod?: string | null };
}) {
  return session.user.twoFactorEnabled === true || session.session.authMethod === "passkey";
}

/** Relying party for passkeys: the public origin, so a passkey only ever works on this server. */
export function passkeyRelyingParty(appUrl: string) {
  const url = new URL(appUrl);
  return { rpID: url.hostname, rpName: APP_NAME, origin: url.origin };
}

// Social sign-in comes back through the provider callback with its destination in `location`;
// the code step carries it on, kept to this site by sameOriginPath.
export { sameOriginPath };

/**
 * Where a social sign-in that still needs a code continues: the sign-in page's code step. With
 * `oauthQuery` (the signed query of an app's authorization request, see socialTwoFactorRedirect)
 * the page carries it on, so entering the code resumes the authorization like any sign-in there.
 */
export function twoFactorStepUrl(next: string | null, oauthQuery?: string | null) {
  const params = new URLSearchParams(oauthQuery ?? undefined);
  params.delete("step");
  params.delete("next");
  params.set("step", "two-factor");
  if (next && next !== "/") params.set("next", next);
  return `/sign-in?${params}`;
}

/** Key of the signed authorization query in the social sign-in's OAuth state (server-trusted). */
const OAUTH_QUERY_KEY = "leafdeskOAuthQuery";

type AfterHook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["after"]>[number];

/**
 * Better Auth's two-factor plugin, with its sign-in challenge extended from password sign-in to
 * social sign-in (the provider callback, and `/sign-in/social` with an ID token). Without that,
 * "Continue with Google" would skip the code. The challenge itself (trusted devices, the pending
 * sign-in cookie, attempt counting) stays the plugin's own.
 *
 * Following an email link (verifying the address, confirming a new one) signs in a browser that
 * wasn't; with two-step verification on, that sign-in is undone, so the link alone (whoever
 * reads the mailbox) never stands in for the code. The address is verified or changed all the
 * same, and signing in asks for the code as usual.
 */
export function twoFactorPlugin() {
  const plugin = twoFactor({
    issuer: APP_NAME,
    // Accounts that only sign in with GitHub or Google have no password to confirm with; for them
    // turning it off asks for a code instead (see requireCodeToDisable).
    allowPasswordless: true,
    backupCodeOptions: { amount: 10, length: 10 },
  });
  const challenge = plugin.hooks.after[0] as AfterHook;
  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      after: [
        {
          matcher: (ctx) =>
            challenge.matcher(ctx) ||
            ctx.path === "/callback/:id" ||
            ctx.path === "/sign-in/social" ||
            isSsoSignInPath(ctx.path),
          handler: challenge.handler,
        },
        {
          matcher: (ctx) => ctx.path === "/verify-email",
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created || created.user.twoFactorEnabled !== true) return;
            // Already signed in to this session: the link only confirmed the address.
            const presented = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
            if (presented === created.session.token) return;
            await ctx.context.internalAdapter.deleteSession(created.session.token);
            deleteSessionCookie(ctx);
          }),
        },
      ],
    },
  } as typeof plugin;
}

/**
 * Runs after the two-factor plugin: a provider callback it held back answers JSON meant for
 * fetch calls, which would leave the browser on a page of JSON. Send it to the code step instead,
 * keeping where the sign-in was headed.
 *
 * Signing in to authorize an app (MCP) puts the app's signed authorization query on the sign-in
 * page; the OAuth provider resumes from it once a session cookie is set. The code step comes
 * after the provider round trip, so the query rides along in the social sign-in's state (checked
 * by the OAuth provider's own before-hook on the same request) and comes back on the code step's
 * address, where the client sends it with the code.
 */
export function socialTwoFactorRedirect(appUrl: string) {
  return {
    id: "leafdesk-social-two-factor",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/social" && typeof ctx.body?.oauth_query === "string",
          handler: createAuthMiddleware(async (ctx) => {
            await addOAuthServerContext({ [OAUTH_QUERY_KEY]: (ctx.body as { oauth_query: string }).oauth_query });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/callback/:id" || isSsoSignInPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as { twoFactorRedirect?: boolean } | undefined;
            if (!returned || typeof returned !== "object" || returned.twoFactorRedirect !== true) return;
            const next = sameOriginPath(ctx.context.responseHeaders?.get("location"), appUrl);
            if (isSsoSignInPath(ctx.path)) {
              // The session the code creates should still count as this single sign-on.
              const providerId = (ctx.params as { providerId?: string } | undefined)?.providerId;
              const userId = await pendingTwoFactorUser(ctx);
              if (providerId && userId) {
                await ctx.setSignedCookie(SSO_PENDING_COOKIE, `${providerId}!${userId}`, ctx.context.secret, {
                  httpOnly: true,
                  sameSite: "lax",
                  secure: appUrl.startsWith("https:"),
                  path: "/",
                  maxAge: SSO_PENDING_MAX_AGE,
                });
              }
              throw ctx.redirect(twoFactorStepUrl(next));
            }
            const oauthQuery = (await getOAuthState())?.serverContext?.[OAUTH_QUERY_KEY];
            throw ctx.redirect(twoFactorStepUrl(next, typeof oauthQuery === "string" ? oauthQuery : null));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Whose sign-in the two-factor plugin has just held back in this response: it set the pending
 * sign-in cookie (`two_factor`, signed, naming a verification row that holds the user id).
 */
async function pendingTwoFactorUser(ctx: HookContext): Promise<string | null> {
  const name = ctx.context.createAuthCookie("two_factor").name;
  const header = ctx.context.responseHeaders?.get("set-cookie") ?? "";
  const start = header.indexOf(`${name}=`);
  if (start < 0) return null;
  const raw = header.slice(start + name.length + 1).split(";")[0];
  const signed = decodeURIComponent(raw);
  const cut = signed.lastIndexOf(".");
  if (cut < 1) return null;
  const row = await ctx.context.internalAdapter.findVerificationValue(signed.slice(0, cut));
  return row?.value ?? null;
}

export function passkeyPlugin(appUrl: string) {
  return passkey({
    ...passkeyRelyingParty(appUrl),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
}

/**
 * `hooks.before` for `/two-factor/disable`. Better Auth asks for the password there, but with
 * `allowPasswordless` an account without one would need nothing but its session. Such accounts
 * confirm with a current authenticator code or an unused recovery code instead.
 */
export async function requireCodeToDisable(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const session = await getSessionFromCtx(ctx);
  if (!session) return; // the endpoint answers 401
  const credential = await ctx.context.internalAdapter.findCredentialAccount(session.user.id);
  if (credential?.password) return; // the endpoint checks the password
  const code = (ctx.body as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string" || !code.trim()) {
    throw APIError.from("BAD_REQUEST", { message: "Enter a code to confirm", code: "TWO_FACTOR_CODE_REQUIRED" });
  }
  const row = await ctx.context.adapter.findOne<{ secret: string; backupCodes: string }>({
    model: "twoFactor",
    where: [{ field: "userId", value: session.user.id }],
  });
  if (!row) return; // nothing to turn off; the endpoint just clears the flag
  if (await codeMatches(code, row, ctx.context.secretConfig)) return;
  throw APIError.from("UNAUTHORIZED", { message: "Invalid code", code: "INVALID_CODE" });
}

type SecretKey = Parameters<typeof symmetricDecrypt>[0]["key"];

/**
 * Whether `code` is the current code of the user's authenticator app or one of their unused
 * recovery codes. Both are stored encrypted with the auth secret, the way Better Auth writes them.
 */
export async function codeMatches(code: string, row: { secret: string; backupCodes: string }, key: SecretKey) {
  const clean = code.trim();
  const secret = await symmetricDecrypt({ key, data: row.secret });
  if (verifyTotp(Buffer.from(secret, "utf8"), clean.replace(/\s+/g, ""))) return true;
  // A JSON array of strings (the plugin's getBackupCodes isn't exported at runtime).
  try {
    const codes: unknown = JSON.parse(await symmetricDecrypt({ key, data: row.backupCodes }));
    return Array.isArray(codes) && codes.includes(clean);
  } catch {
    return false;
  }
}
