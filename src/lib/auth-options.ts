import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import { addOAuthServerContext, APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import {
  passkeyPlugin,
  requireCodeToDisable,
  socialTwoFactorRedirect,
  twoFactorPlugin,
} from "@/lib/auth-security";
import { sso } from "@better-auth/sso";
import { cleanName } from "@/lib/account";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { isAgentEmail } from "@/lib/agents";
import { env, mcpResource } from "@/lib/env";
import { sessionLifetime } from "@/lib/session-lifetime";
import type { SocialCredentials, SocialProvider } from "@/lib/social-providers";
import { discoveryUrl, INSTANCE_SSO_PROVIDER_ID, SSO_SCOPES, type InstanceOidc } from "@/lib/sso-config";

export const MCP_SCOPES = ["pages:read", "pages:write", "notifications:read", "files:write"] as const;
const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", ...MCP_SCOPES];

/** http on an exact loopback host, or a private-use scheme: redirects only a native app can receive. */
function isNativeRedirect(uri: unknown) {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return false;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return true;
  } catch {
    return false;
  }
}

type AuthContextLike = { query?: unknown; request?: Request } | null | undefined;

function queryParam(ctx: AuthContextLike, name: string) {
  const fromQuery = (ctx?.query as Record<string, unknown> | undefined)?.[name];
  if (typeof fromQuery === "string") return fromQuery;
  if (!ctx?.request) return null;
  return new URL(ctx.request.url).searchParams.get(name);
}

/** The `?invite=` token of an auth request (sign-up from an invitation link). */
export const inviteTokenOf = (ctx: AuthContextLike) => queryParam(ctx, "invite");

/** The `?join=` token of an auth request (sign-up from a workspace's join link). */
export const joinTokenOf = (ctx: AuthContextLike) => queryParam(ctx, "join");

/**
 * The `invite` / `join` token a social sign-in carried through the provider redirect, from the
 * OAuth state's server context (see the `/sign-in/social` hook below).
 */
export function socialTokenOf(serverContext: unknown, name: "invite" | "join") {
  const value = (serverContext as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === "string" && value ? value : null;
}

/** The token a new user signed up with: the request query for email sign-up, the OAuth state for social. */
export async function signUpTokenOf(ctx: AuthContextLike, name: "invite" | "join") {
  return queryParam(ctx, name) ?? socialTokenOf((await getOAuthState())?.serverContext, name);
}

/**
 * Agents' users (see server/agents) can't sign in: they have no password or provider account, and
 * these guards keep it so. `user.create.before` and `user.update.before`: no account is created
 * with, or moved to, an agent's address (an identity provider could claim any address).
 */
export function refuseAgentAddress(user: { email?: unknown }) {
  if (typeof user.email === "string" && isAgentEmail(user.email)) {
    throw APIError.from("FORBIDDEN", { message: "This address belongs to an agent", code: "agent_account" });
  }
}

/** Whether a user is an agent's user; injected so this file needs no database. */
export type AgentUserCheck = (userId: string) => Promise<boolean>;

/**
 * `session.create.before` and `account.create.before`: an agent's user never gets a session, nor a
 * password or provider account that could sign it in later.
 */
export function agentSignInGuard(isAgentUser: AgentUserCheck) {
  return async (record: { userId: string }) => {
    if (await isAgentUser(record.userId)) {
      throw APIError.from("FORBIDDEN", { message: "Agents can't sign in", code: "agent_account" });
    }
  };
}

/** Checks an invitation link against the email signing up; injected so this file needs no database. */
export type InvitationCheck = (token: string, email: string) => Promise<boolean>;

/** Closed sign-up still admits people holding an invitation link for their email. */
export async function closedSignUpAdmits(token: string | null, email: unknown, check?: InvitationCheck) {
  return Boolean(token && typeof email === "string" && check && (await check(token, email)));
}

/**
 * `databaseHooks.user.create.before`. Social sign-in creates its user in the OAuth callback, past
 * the /sign-up/email check in baseAuthOptions, so closed sign-up is enforced here for every other
 * way in: only an invitation for the same email, carried through the OAuth state, admits one.
 */
export function closedSignUpGuard(check?: InvitationCheck) {
  return async (user: { email: string }, ctx: { path?: string } | null | undefined) => {
    if (!env.signUpDisabled || ctx?.path === "/sign-up/email") return;
    const invite = socialTokenOf((await getOAuthState())?.serverContext, "invite");
    if (await closedSignUpAdmits(invite, user.email, check)) return;
    throw APIError.from("FORBIDDEN", { message: "Sign up is not enabled", code: "signup_disabled" });
  };
}

/**
 * `databaseHooks.account.create.after`. Anyone could have created a password account with someone
 * else's unverified email beforehand (pre-account-takeover). When a sign-in links a provider
 * account to such a user by email, the provider has just proven who owns the address, so the
 * earlier password and sessions go, and `forgetEarlierHolder` removes the rest of what they could
 * have set up (passkeys, two-step verification, API tokens, app grants); the owner can set a
 * password by resetting it by email. Better Auth links the account before it creates the new
 * session, so only sessions from before the link go: single sign-on runs this hook after its
 * transaction, when the new session already exists.
 */
export function claimOnEmailLink(forgetEarlierHolder?: (userId: string) => Promise<void>) {
  return async (
    account: { id: string; userId: string; providerId: string; createdAt?: Date | string },
    ctx: GenericEndpointContext | null,
  ) => {
    if (!ctx || account.providerId === "credential") return;
    // An explicit /link-social by the signed-in user, not a link by email.
    if ((await getOAuthState())?.link) return;
    const adapter = ctx.context.internalAdapter;
    const user = await adapter.findUserById(account.userId);
    if (!user || user.emailVerified) return;
    const others = (await adapter.findAccounts(account.userId)).filter((other) => other.id !== account.id);
    // No other account: the user was created by this same sign-in, there is nothing to claim.
    if (others.length === 0) return;
    for (const other of others) if (other.providerId === "credential") await adapter.deleteAccount(other.id);
    const linkedAt = account.createdAt ? new Date(account.createdAt).getTime() : Number.POSITIVE_INFINITY;
    for (const old of await adapter.listSessions(account.userId)) {
      if (new Date(old.createdAt).getTime() < linkedAt) await adapter.deleteSession(old.token);
    }
    await forgetEarlierHolder?.(account.userId);
    await adapter.updateUser(account.userId, { emailVerified: true });
  };
}

/**
 * `/update-user` would take any name and any picture URL. The account page changes both through
 * its own actions (pictures are uploaded, see lib/avatar.ts); here only a valid name, or removing
 * the picture, gets through, so nobody can point their avatar at a tracking pixel.
 */
export function guardUpdateUser(body: unknown) {
  const { name, image, ...rest } = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(rest).length || (image !== undefined && image !== null)) {
    throw APIError.from("BAD_REQUEST", { message: "Only the name can be changed here", code: "FIELD_NOT_ALLOWED" });
  }
  if (name !== undefined && !cleanName(name).ok) {
    throw APIError.from("BAD_REQUEST", { message: "Enter a name of at most 80 characters", code: "INVALID_NAME" });
  }
}

/** Sign-in with the providers configured in the environment, and linking them to existing accounts. */
export function socialAuthOptions(providers: Partial<Record<SocialProvider, SocialCredentials>>) {
  return {
    socialProviders: {
      ...(providers.github && { github: providers.github }),
      ...(providers.google && { google: { ...providers.google, prompt: "select_account" as const } }),
    },
    account: {
      accountLinking: {
        enabled: true,
        // A provider account joins the existing account with its email when the provider says the
        // address is verified (neither is trusted blindly). Email/password sign-up never verifies
        // addresses, so requiring that on our side would keep every existing account from linking;
        // claimOnEmailLink handles what such an unverified account may carry.
        requireLocalEmailVerified: false,
      },
    },
  } satisfies BetterAuthOptions;
}

/**
 * The SSO plugin's own provider management (register, update, list, domain verification) works
 * per user or per organization; workspaces manage their one connection through server/sso.ts,
 * owners only, so those endpoints are off. What stays: starting a sign-in, the per-provider OIDC
 * callback, and SAML's assertion consumer and metadata.
 *
 * Also off: the shared OIDC callback (`/sso/callback`, for the unused `redirectURI` option), which
 * would finish a sign-in outside the paths the two-step challenge and the session's provider
 * record look at, and SAML single logout (not enabled).
 */
export const SSO_DISABLED_ENDPOINTS: ReadonlySet<string> = new Set([
  "/sso/register",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/callback",
  "/sso/saml2/sp/slo/:providerId",
  "/sso/saml2/logout/:providerId",
]);

/** `disabledPaths` compares literal request paths, so it only covers the ones without parameters. */
export const SSO_DISABLED_PATHS = [...SSO_DISABLED_ENDPOINTS].filter((path) => !path.includes(":"));

export type SsoCallbacks = {
  /** Picks the provider for an email typed on the sign-in page ("Continue with SSO"). */
  resolveProvider?: (email: string) => Promise<string | null>;
};

/**
 * Single sign-on with OIDC and SAML (Better Auth's SSO plugin). The instance provider comes from
 * the environment (`defaultSSO`, id "oidc"); workspace connections are rows of `sso_provider`.
 * Domain verification is on: a workspace connection signs people in only once its email domains
 * are proven by DNS, so nobody can route someone else's domain to their own identity provider.
 */
export function ssoPlugin(instance: InstanceOidc | null) {
  return sso({
    defaultSSO: instance
      ? [
          {
            providerId: INSTANCE_SSO_PROVIDER_ID,
            domain: instance.domains.join(","),
            oidcConfig: {
              issuer: instance.issuer,
              clientId: instance.clientId,
              clientSecret: instance.clientSecret,
              pkce: true,
              discoveryEndpoint: discoveryUrl(instance.issuer),
              scopes: SSO_SCOPES,
            },
          },
        ]
      : undefined,
    domainVerification: { enabled: true, tokenPrefix: "leafdesk-sso" },
    providersLimit: 0,
    saml: { requireTimestamps: true },
  });
}

/**
 * `hooks.before` for `/sign-in/sso`: the sign-in page sends the email typed there, and the server
 * picks the provider (the instance's for its domains, else the workspace connection that has
 * verified that domain). The plugin's own lookups by domain or organization are not used.
 */
export async function routeSsoSignIn(body: unknown, resolve: SsoCallbacks["resolveProvider"]) {
  const input = (body ?? {}) as Record<string, unknown>;
  if (input.domain !== undefined || input.organizationSlug !== undefined) {
    throw APIError.from("BAD_REQUEST", { message: "Sign in with an email address", code: "SSO_NOT_FOUND" });
  }
  if (typeof input.providerId === "string" && input.providerId) return null;
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const providerId = email && resolve ? await resolve(email) : null;
  if (!providerId) {
    throw APIError.from("NOT_FOUND", { message: "No single sign-on for this email address", code: "SSO_NOT_FOUND" });
  }
  return { ...input, email, providerId };
}

export function baseAuthOptions({
  invitationAllowsSignUp,
  instanceOidc = null,
  sso: ssoCallbacks = {},
}: { invitationAllowsSignUp?: InvitationCheck; instanceOidc?: InstanceOidc | null; sso?: SsoCallbacks } = {}) {
  const before = createAuthMiddleware(async (ctx) => {
    // Hooks see the route pattern, so this also covers the ones with parameters.
    if (SSO_DISABLED_ENDPOINTS.has(ctx.path)) throw APIError.from("NOT_FOUND", { message: "Not found", code: "NOT_FOUND" });
    if (ctx.path === "/sign-in/sso") {
      const body = await routeSsoSignIn(ctx.body, ssoCallbacks.resolveProvider);
      if (body) return { context: { body } };
      return;
    }
    if (ctx.path === "/two-factor/disable") await requireCodeToDisable(ctx);
    if (ctx.path === "/update-user") guardUpdateUser(ctx.body);
    if (ctx.path === "/sign-up/email" && env.signUpDisabled) {
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (!(await closedSignUpAdmits(inviteTokenOf(ctx), email, invitationAllowsSignUp))) {
        throw APIError.from("BAD_REQUEST", {
          message: "Email and password sign up is not enabled",
          code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
        });
      }
    }
    // The provider redirects back to /callback without our query, so an invitation or join link
    // rides the server-side OAuth state; the user-create hooks in auth.ts read it back from there.
    if (ctx.path === "/sign-in/social") {
      const invite = inviteTokenOf(ctx);
      const join = joinTokenOf(ctx);
      if (invite || join) await addOAuthServerContext({ ...(invite && { invite }), ...(join && { join }) });
    }
    // RFC 7591 defaults `application_type` to "web", which forbids loopback redirects. Desktop and
    // CLI MCP clients often register loopback callbacks without sending the field, so infer
    // "native" for them; the provider still validates every redirect URI for that type.
    if (ctx.path !== "/oauth2/register") return;
    const body = ctx.body as { application_type?: unknown; redirect_uris?: unknown } | undefined;
    if (!body || body.application_type !== undefined) return;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isNativeRedirect)) return;
    return { context: { body: { ...body, application_type: "native" } } };
  });

  // Database-independent options, shared by the app and the schema generator.
  return {
    baseURL: env.appUrl,
    advanced: {
      // The visitor's address as server.ts works it out past the trusted proxies, for the rate
      // limits and the sessions list. X-Forwarded-For alone says whatever the visitor writes in it.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        // An instance admin asked for a new password: the next password sign-in sets one first
        // (see server/required-password.ts). Cleared when the password changes.
        passwordResetRequired: { type: "boolean", required: false, input: false, defaultValue: false },
      },
    },
    session: {
      // SESSION_MAX_AGE_DAYS: how long a sign-in lasts without use (see lib/session-lifetime).
      ...sessionLifetime(env.sessionDays),
      additionalFields: {
        // How the session was signed in (see authMethodOf); a passkey session counts as two-step.
        authMethod: { type: "string", required: false, input: false },
        // The SSO provider it came through, for a workspace's "SSO only" policy.
        ssoProviderId: { type: "string", required: false, input: false },
      },
    },
    disabledPaths: SSO_DISABLED_PATHS,
    hooks: { before },
    plugins: [
      // Before mcp(): its after-hook continues an OAuth authorization as soon as a sign-in sets a
      // session cookie, so the code challenge has to take that session away first.
      twoFactorPlugin(),
      socialTwoFactorRedirect(env.appUrl),
      passkeyPlugin(env.appUrl),
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        resource: mcpResource(),
        scopes: OAUTH_SCOPES,
        clientRegistrationDefaultScopes: OAUTH_SCOPES,
        clientRegistrationAllowedScopes: OAUTH_SCOPES,
        // MCP 2026-07-28 clients use CIMD; many deployed clients still register via DCR.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      ssoPlugin(instanceOidc),
    ],
  } satisfies BetterAuthOptions;
}
