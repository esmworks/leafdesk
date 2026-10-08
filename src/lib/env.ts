import { sessionDaysFrom } from "@/lib/session-lifetime";
import { adminEmailsFrom, workspaceCreationFrom } from "@/lib/instance-admin";
import { vapidFrom } from "@/lib/push";
import { socialProvidersFrom, type SocialProvider } from "@/lib/social-providers";
import { instanceOidcFrom, ssoTrustedOriginsFrom } from "@/lib/sso-config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The secret .env.example ships with: anyone can sign sessions with it. */
const EXAMPLE_AUTH_SECRET = "change-me-to-a-long-random-string";
const MIN_AUTH_SECRET_CHARS = 32;

export const env = {
  get appUrl() {
    return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  /**
   * BETTER_AUTH_SECRET signs sessions (and keys derived from it seal secrets). In production it
   * must not be the example value or shorter than 32 characters; development takes any.
   */
  get authSecret() {
    const secret = required("BETTER_AUTH_SECRET");
    if (process.env.NODE_ENV === "production" && (secret === EXAMPLE_AUTH_SECRET || secret.length < MIN_AUTH_SECRET_CHARS)) {
      throw new Error(
        `BETTER_AUTH_SECRET must be a random value of at least ${MIN_AUTH_SECRET_CHARS} characters, not the example from .env.example (make one with: openssl rand -base64 32)`,
      );
    }
    return secret;
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
  /**
   * LEAFDESK_ENCRYPTION_KEY: the key that seals secrets kept in the database (a connection's
   * tokens); at least 32 characters. Without it, a key is derived from BETTER_AUTH_SECRET.
   * LEAFDESK_ENCRYPTION_OLD_KEYS (comma-separated) still opens what older keys sealed.
   */
  get encryptionKey() {
    return process.env.LEAFDESK_ENCRYPTION_KEY?.trim() || null;
  },
  get oldEncryptionKeys() {
    return (process.env.LEAFDESK_ENCRYPTION_OLD_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  },
  /**
   * CONNECTOR_ALLOWED_HOSTS: host names (or host:port) a connection's MCP server may be on even
   * though they are on a private network, a local name or plain http (a server on the same
   * machine, say); comma-separated. Every other connection goes only to public https addresses.
   */
  get connectorAllowedHosts() {
    return (process.env.CONNECTOR_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a mailto: or https: address the push
   * services can reach the server's administrator at) turn on push notifications; null while any
   * is missing or the subject is neither (see lib/push.ts).
   */
  get vapid() {
    return vapidFrom(process.env);
  },
  /**
   * PUSH_ALLOWED_HOSTS: host names (or host:port) of push services that may be on a private
   * network, a local name or plain http (a push service run next to the server); comma-separated.
   * Every other push goes only to public https addresses.
   */
  get pushAllowedHosts() {
    return (process.env.PUSH_ALLOWED_HOSTS ?? "")
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
