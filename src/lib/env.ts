import { sessionDaysFrom } from "@/lib/session-lifetime";
import { adminEmailsFrom, workspaceCreationFrom } from "@/lib/instance-admin";
import { socialProvidersFrom, type SocialProvider } from "@/lib/social-providers";
import { instanceOidcFrom, ssoTrustedOriginsFrom } from "@/lib/sso-config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  get appUrl() {
    return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get authSecret() {
    return required("BETTER_AUTH_SECRET");
  },
  /**
   * AUTOMATION_WEBHOOK_ALLOWED_HOSTS: host names (or host:port) that automation webhooks may reach
   * even though they are on a private network or a local name (an n8n on the same server, say);
   * comma-separated. Every other webhook goes only to public addresses on the usual web ports.
   */
  get automationWebhookAllowedHosts() {
    return (process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  },
  /** SESSION_MAX_AGE_DAYS: days a sign-in lasts without use (default 7, see lib/session-lifetime). */
  get sessionDays() {
    return sessionDaysFrom(process.env.SESSION_MAX_AGE_DAYS);
  },
  /** DISABLE_SIGNUP=true closes email/password sign-up; existing accounts can still sign in. */
  get signUpDisabled() {
    return ["1", "true", "yes"].includes((process.env.DISABLE_SIGNUP ?? "").trim().toLowerCase());
  },
  /** ADMIN_EMAILS: the instance administrators' addresses (see lib/instance-admin.ts). */
  get adminEmails() {
    return adminEmailsFrom(process.env.ADMIN_EMAILS);
  },
  /** WORKSPACE_CREATION=everyone|admins: who may create workspaces beyond their personal one. */
  get workspaceCreation() {
    return workspaceCreationFrom(process.env.WORKSPACE_CREATION);
  },
  /** GITHUB_CLIENT_ID/SECRET and GOOGLE_CLIENT_ID/SECRET each turn on sign-in with that provider. */
  get socialProviders() {
    return socialProvidersFrom(process.env);
  },
  get enabledSocialProviders(): SocialProvider[] {
    return Object.keys(this.socialProviders) as SocialProvider[];
  },
  /** OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET turn on the instance-wide SSO provider. */
  get instanceOidc() {
    return instanceOidcFrom(process.env);
  },
  /** Identity provider origins on a private network that SSO may call (see ssoTrustedOriginsFrom). */
  get ssoTrustedOrigins() {
    return ssoTrustedOriginsFrom(process.env);
  },
};

/** Canonical MCP protected-resource identifier; tokens are audience-bound to it. */
export const mcpResource = () => `${env.appUrl}/mcp`;

/**
 * Where this process can reach itself. APP_URL is the public origin and may not resolve from
 * inside the container (port mapping, reverse proxy), so self-requests use loopback.
 */
export const internalUrl = () => `http://127.0.0.1:${process.env.PORT ?? 3000}`;
