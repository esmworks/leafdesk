import { connectionOAuthClientsFrom } from "@/lib/connections";
import type { OAuthStorageKind } from "@/lib/workspace-storage";
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
   * MAIL_ALLOWED_HOSTS: mail servers (host names, or host:port) members' mailboxes may be on even
   * though they are on a private network or a local name, and may talk to without TLS (a mail
   * server on the same machine or in the office, say); comma-separated. Every other mailbox is
   * reached only on public addresses, over TLS.
   */
  get mailAllowedHosts() {
    return (process.env.MAIL_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * OWN_STORAGE_ENABLED=true lets people connect storage of their own (an S3-compatible bucket,
   * Google Drive, Dropbox) and keep workspaces' uploads there instead of the server's storage. Off
   * by default: every upload goes to the server's storage (S3_* or UPLOAD_DIR). Turned off later,
   * workspaces already connected keep reading and uploading there; only new connections are refused.
   */
  get ownStorageEnabled() {
    return ["1", "true", "yes"].includes((process.env.OWN_STORAGE_ENABLED ?? "").trim().toLowerCase());
  },
  /**
   * STORAGE_ALLOWED_HOSTS: hosts (names, or host:port) a workspace's own S3-compatible storage may
   * be on even though they are on a private network, a local name or plain http (MinIO on the same
   * machine, say); comma-separated. Every other endpoint is reached only on public https addresses.
   */
  get storageAllowedHosts() {
    return (process.env.STORAGE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * STORAGE_GDRIVE_CLIENT_ID/SECRET and STORAGE_DROPBOX_CLIENT_ID/SECRET: the apps the instance
   * registered with Google and Dropbox, which owners sign in to when they keep a workspace's
   * uploads in their Drive or Dropbox. A kind without both values can't be connected.
   */
  get storageOAuthApps() {
    return storageOAuthAppsFrom(process.env);
  },
  /**
   * CONNECTION_OAUTH_CLIENTS: OAuth apps the instance registered with services of the connection
   * catalog that don't let Leafdesk register itself (Slack, HubSpot…), so owners needn't make their
   * own: `slack=CLIENT_ID:CLIENT_SECRET,discord=CLIENT_ID` (see connectionOAuthClientsFrom).
   */
  get connectionOAuthClients() {
    return connectionOAuthClientsFrom(process.env.CONNECTION_OAUTH_CLIENTS);
  },
  /**
   * VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a mailto: or https: address the push
   * services can reach the server's administrator at) turn on push notifications; null while any
   * is missing or the subject is neither (see lib/push.ts).
   */
  get vapid() {
    // Push services reach browsers through a public address the computer's server doesn't have.
    if (this.localMode) return null;
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
  /**
   * LEAFDESK_LOCAL_MODE=1: Leafdesk runs on one computer for one person (the desktop app's "On
   * this computer", desktop/src/local-server.ts). What needs other people, email or a public address
   * is hidden and refused: SSO, SCIM, invitations and join requests, guests, publishing, email and
   * push notifications (see server/local-mode.ts).
   */
  get localMode() {
    return ["1", "true", "yes"].includes((process.env.LEAFDESK_LOCAL_MODE ?? "").trim().toLowerCase());
  },
  /**
   * OWN_AI_KEYS_ENABLED=true: people add their own AI provider key to their account and attach it
   * to workspaces they own, which then use it for all their AI (see server/ai-accounts.ts). Off by
   * default: AI comes only from the AI_* settings.
   */
  get ownAiKeysEnabled() {
    return ["1", "true", "yes"].includes((process.env.OWN_AI_KEYS_ENABLED ?? "").trim().toLowerCase());
  },
  /**
   * AI_ONLY_OWN_KEYS=true, with OWN_AI_KEYS_ENABLED: the AI_* key is never used for a workspace, so
   * a workspace without its own AI account has AI off (a free tier that never spends the server's key).
   */
  get aiOnlyOwnKeys() {
    return this.ownAiKeysEnabled && ["1", "true", "yes"].includes((process.env.AI_ONLY_OWN_KEYS ?? "").trim().toLowerCase());
  },
  /**
   * AI_ALLOWED_HOSTS: hosts (names, or host:port) a person's own OpenAI-compatible AI server may be
   * on even though they are on a private network, a local name or plain http; comma-separated.
   * Every other base URL is reached only on public https addresses.
   */
  get aiAllowedHosts() {
    return (process.env.AI_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
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

export type StorageOAuthApp = { clientId: string; clientSecret: string };

/** The storage sign-in apps set in `vars`, by kind (see env.storageOAuthApps). */
export function storageOAuthAppsFrom(vars: Record<string, string | undefined>): Partial<Record<OAuthStorageKind, StorageOAuthApp>> {
  const apps: Partial<Record<OAuthStorageKind, StorageOAuthApp>> = {};
  for (const [kind, name] of [
    ["gdrive", "GDRIVE"],
    ["dropbox", "DROPBOX"],
  ] as const) {
    const clientId = vars[`STORAGE_${name}_CLIENT_ID`]?.trim();
    const clientSecret = vars[`STORAGE_${name}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) apps[kind] = { clientId, clientSecret };
  }
  return apps;
}
