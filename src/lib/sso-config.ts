/**
 * Single sign-on settings that need no database: the instance-wide OpenID Connect provider from the
 * environment, how workspace connections are named, the addresses identity providers are given,
 * and the rules for email domains. Shared by the server, the schema generator and unit tests.
 */

/** OIDC scopes asked for: no offline_access, which some providers (Google) refuse. */
export const SSO_SCOPES = ["openid", "email", "profile"];

/** Provider id of the instance-wide OIDC provider (OIDC_ISSUER and friends). */
export const INSTANCE_SSO_PROVIDER_ID = "oidc";

/** A workspace has at most one SSO connection; its provider id follows from the workspace id. */
export const workspaceProviderId = (workspaceId: string) => `ws-${workspaceId}`;

/** The workspace a provider id belongs to, or null for the instance provider and anything else. */
export function workspaceOfProvider(providerId: string | null | undefined): string | null {
  return providerId?.startsWith("ws-") && providerId.length > 3 ? providerId.slice(3) : null;
}

export type InstanceOidc = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Shown on the sign-in button ("Continue with …"). */
  name: string;
  /** Email domains this provider is authoritative for (routing and linking existing accounts). */
  domains: string[];
};

/**
 * The instance-wide provider: on only when OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are
 * all set and the issuer is an http(s) URL. OIDC_NAME labels the button, OIDC_DOMAINS lists the
 * email domains it vouches for.
 */
export function instanceOidcFrom(source: Record<string, string | undefined>): InstanceOidc | null {
  // Kept as given: ID tokens name it exactly so (Authentik's ends with a slash).
  const issuer = source.OIDC_ISSUER?.trim();
  const clientId = source.OIDC_CLIENT_ID?.trim();
  const clientSecret = source.OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  if (!isHttpUrl(issuer)) return null;
  const domains = parseDomains(source.OIDC_DOMAINS ?? "");
  return {
    issuer,
    clientId,
    clientSecret,
    name: source.OIDC_NAME?.trim() || "SSO",
    domains: domains.ok ? domains.domains : [],
  };
}

/**
 * Origins trusted for server-side calls to identity providers on a private network (a Keycloak in
 * the same compose file, say): the instance issuer's, and SSO_TRUSTED_ORIGINS (comma-separated).
 * Workspace providers anywhere else must be on the public internet.
 */
export function ssoTrustedOriginsFrom(source: Record<string, string | undefined>): string[] {
  const origins = new Set<string>();
  const instance = instanceOidcFrom(source);
  if (instance) origins.add(new URL(instance.issuer).origin);
  for (const entry of (source.SSO_TRUSTED_ORIGINS ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Not a URL: ignored.
    }
  }
  return [...origins];
}

/** Where an issuer's discovery document is (OpenID Connect Discovery 1.0, section 4). */
export const discoveryUrl = (issuer: string) => `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Most domains one connection may have. */
export const MAX_SSO_DOMAINS = 20;

/**
 * Email domains typed by an owner ("example.com, Example.org"), cleaned up: lowercase, no
 * duplicates, no "@", each a real host name with a dot. Public email providers can't be claimed.
 */
export function parseDomains(
  input: string | readonly string[],
): { ok: true; domains: string[] } | { ok: false; invalid: string } {
  const entries = (typeof input === "string" ? input.split(/[\s,;]+/) : input)
    .map((d) => d.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""))
    .filter(Boolean);
  const domains: string[] = [];
  for (const entry of entries) {
    if (!DOMAIN_PATTERN.test(entry)) return { ok: false, invalid: entry };
    if (PUBLIC_EMAIL_DOMAINS.has(entry)) return { ok: false, invalid: entry };
    if (!domains.includes(entry)) domains.push(entry);
  }
  if (domains.length > MAX_SSO_DOMAINS) return { ok: false, invalid: domains[MAX_SSO_DOMAINS] };
  return { ok: true, domains };
}

/** The domain of an email address, lowercase; null when it isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.trim().slice(at + 1).toLowerCase();
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/**
 * Whether an address belongs to one of the domains, subdomains included (like the SSO plugin's own
 * routing): `a@eu.example.com` matches `example.com`.
 */
export function emailInDomains(email: string, domains: readonly string[]) {
  const domain = emailDomain(email);
  return !!domain && domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** The plugin keeps a provider's domains as one comma-separated string. */
export const domainsFromColumn = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

/** Name of the DNS TXT record that proves a domain belongs to the workspace. */
export const DOMAIN_RECORD_PREFIX = "_leafdesk-sso";
export const domainRecordName = (domain: string) => `${DOMAIN_RECORD_PREFIX}.${domain}`;
export const domainRecordValue = (token: string) => `leafdesk-sso=${token}`;

/**
 * Addresses a workspace's identity provider is configured with. The auth routes live under
 * /api/auth, where the SSO plugin puts its callback, SAML service provider and metadata.
 */
export function ssoEndpoints(appUrl: string, workspaceId: string) {
  const base = `${appUrl.replace(/\/$/, "")}/api/auth`;
  const providerId = workspaceProviderId(workspaceId);
  const metadataUrl = `${base}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
  return {
    providerId,
    oidcRedirectUri: `${base}/sso/callback/${providerId}`,
    samlAcsUrl: `${base}/sso/saml2/sp/acs/${providerId}`,
    // The service provider's entity ID is its metadata address, a common convention IdPs accept.
    samlEntityId: metadataUrl,
    samlMetadataUrl: metadataUrl,
    scimBaseUrl: `${appUrl.replace(/\/$/, "")}/scim/v2`,
  };
}

/**
 * Consumer mail services nobody can prove ownership of for a whole organization; claiming one
 * would route everyone on it to one workspace's identity provider. The Mail tab doesn't take one
 * for a mailbox's own organization either (lib/mail-images.ts).
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "hotmail.co.uk",
  "yahoo.co.uk",
]);
