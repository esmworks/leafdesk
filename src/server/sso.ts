import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { account, scimIdentity, session, ssoProvider, workspace, workspaceSso } from "@/db/schema";
import { env } from "@/lib/env";
import {
  domainRecordName,
  discoveryUrl,
  domainRecordValue,
  domainsFromColumn,
  emailInDomains,
  INSTANCE_SSO_PROVIDER_ID,
  isHttpUrl,
  parseDomains,
  ssoEndpoints,
  SSO_SCOPES,
  workspaceOfProvider,
  workspaceProviderId,
} from "@/lib/sso-config";
import { requireMembership } from "@/server/access";
import { disconnectEndedSessions } from "@/server/account-security";
import { allowedDomainsProvenElsewhere } from "@/server/allowed-domains";
import { afterApiTokensRevoked, revokeApiTokensIn } from "@/server/api/tokens";
import { recordAudit, runAsAuditOrigin } from "@/server/audit";
import { afterConnectedAppsRevoked, revokeConnectedAppsIn } from "@/server/mcp/grants";
import { fetchRemoteFile, isBlockedAddress, readRemoteText } from "@/server/remote-fetch";
import { joinAsMember } from "@/server/workspaces";
import { refuseInLocalMode } from "@/server/local-mode";

/**
 * Single sign-on: which provider an email signs in with, what a sign-in through a workspace's
 * connection may do (create an account, join the workspace), and the connections themselves,
 * which owners set up in Settings > Security.
 *
 * A workspace has at most one connection (OIDC or SAML), a row of the SSO plugin's `sso_provider`
 * table with provider id `ws-<workspace id>`, plus a `workspace_sso` row. It signs people in only
 * once its email domains are verified by DNS (a TXT record), and only people with an address in
 * those domains: otherwise an owner could claim someone else's domain, or have their identity
 * provider vouch for addresses that aren't theirs.
 */

export type SsoErrorCode =
  | "invalidDomain"
  | "noDomains"
  | "invalidIssuer"
  | "discoveryFailed"
  | "clientIdRequired"
  | "secretRequired"
  | "invalidSaml"
  | "noConnection"
  | "dnsMismatch"
  | "domainTaken"
  | "connectionChanged";

/** An expected failure an owner can act on; `code` is translated by the UI. */
export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    message: string,
    /** A domain or address the message is about, shown next to it. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SsoError";
  }
}

// ---------------------------------------------------------------------------------------- routing

/**
 * Verified connections and their domains (verified domains are unique across connections: each
 * verification checks under a lock all of them take, see verifySsoDomains).
 */
async function verifiedConnections() {
  return db
    .select({ providerId: ssoProvider.providerId, domain: ssoProvider.domain, workspaceId: workspaceSso.workspaceId })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(eq(ssoProvider.domainVerified, true));
}

/**
 * The provider someone signs in with from the email typed on the sign-in page: the instance's
 * provider for its domains (OIDC_DOMAINS), else the workspace connection that verified the domain.
 */
export async function resolveSsoProvider(email: string): Promise<string | null> {
  if (env.localMode) return null;
  const instance = env.instanceOidc;
  if (instance && emailInDomains(email, instance.domains)) return INSTANCE_SSO_PROVIDER_ID;
  const match = (await verifiedConnections()).find((c) => emailInDomains(email, domainsFromColumn(c.domain)));
  return match?.providerId ?? null;
}

/** Whether the sign-in page should offer "Continue with SSO" (typing an email). */
export async function ssoSignInAvailable() {
  if (env.localMode) return false;
  if (env.instanceOidc?.domains.length) return true;
  const [one] = await db
    .select({ id: ssoProvider.id })
    .from(ssoProvider)
    .where(eq(ssoProvider.domainVerified, true))
    .limit(1);
  return one !== undefined;
}

/**
 * Whether a single sign-on may create an account for `email`, and whether the address counts as
 * verified. The instance provider is the operator's: it may (also when sign-up is closed), only
 * within OIDC_DOMAINS when those are set (a provider like Google signs in anyone otherwise), and
 * vouches for those domains. A workspace connection only for addresses in its verified domains,
 * which it vouches for.
 */
export async function ssoAccountCreation(providerId: string, email: string) {
  if (providerId === INSTANCE_SSO_PROVIDER_ID) {
    const instance = env.instanceOidc;
    if (!instance) return { allowed: false, emailVerified: false };
    const inDomains = emailInDomains(email, instance.domains);
    return { allowed: instance.domains.length === 0 || inDomains, emailVerified: inDomains };
  }
  if (!workspaceOfProvider(providerId)) return { allowed: false, emailVerified: false };
  const [row] = await db
    .select({ domain: ssoProvider.domain, verified: ssoProvider.domainVerified })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);
  const allowed = !!row?.verified && emailInDomains(email, domainsFromColumn(row.domain));
  return { allowed, emailVerified: allowed };
}

/**
 * After the first sign-in through a workspace's connection (the account is created or linked to
 * it, see auth.ts): someone with an address in its verified domains joins the workspace as a
 * member, unless they are in it already or its identity provider has deactivated them over SCIM.
 */
export async function joinThroughSso(providerId: string, user: { id: string; email: string }) {
  const workspaceId = workspaceOfProvider(providerId);
  if (!workspaceId) return false;
  const { allowed } = await ssoAccountCreation(providerId, user.email);
  if (!allowed) return false;
  const [deactivated] = await db
    .select({ active: scimIdentity.active })
    .from(scimIdentity)
    .where(and(eq(scimIdentity.workspaceId, workspaceId), eq(scimIdentity.userId, user.id), eq(scimIdentity.active, false)))
    .limit(1);
  if (deactivated) return false;
  return joinAsMember(workspaceId, user.id, user.email, "sso");
}

// ------------------------------------------------------------------------------------ connections

export type SsoConnection = {
  protocol: "oidc" | "saml";
  domains: string[];
  verified: boolean;
  /** The TXT records that verify the domains. */
  records: { domain: string; name: string; value: string }[];
  oidc: { issuer: string; clientId: string; hasSecret: boolean } | null;
  saml: { entryPoint: string; idpEntityId: string; hasCertificate: boolean; usesMetadata: boolean } | null;
};

/** Addresses and ids an identity provider needs, for the settings box (owners and members see it). */
export function ssoSetupInfo(workspaceId: string) {
  return { workspaceId, ...ssoEndpoints(env.appUrl, workspaceId) };
}

type OidcStored = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  [key: string]: unknown;
};
export type SamlStored = {
  entryPoint: string;
  cert?: string;
  idpMetadata?: { metadata?: string; entityID?: string; cert?: string };
  [key: string]: unknown;
};

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function connectionRow(workspaceId: string) {
  const [row] = await db
    .select({
      protocol: workspaceSso.protocol,
      token: workspaceSso.verificationToken,
      providerId: ssoProvider.providerId,
      issuer: ssoProvider.issuer,
      domain: ssoProvider.domain,
      verified: ssoProvider.domainVerified,
      oidcConfig: ssoProvider.oidcConfig,
      samlConfig: ssoProvider.samlConfig,
    })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(eq(workspaceSso.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

type IdentityProvider = Pick<NonNullable<Awaited<ReturnType<typeof connectionRow>>>, "protocol" | "issuer" | "samlConfig">;

/**
 * Whether two states of a connection have the same identity provider behind them: the same issuer
 * over OIDC (another client or secret is the same provider), the same settings over SAML.
 */
function sameIdentityProvider(a: IdentityProvider, b: IdentityProvider) {
  return a.protocol === b.protocol && (a.protocol === "oidc" ? a.issuer === b.issuer : a.samlConfig === b.samlConfig);
}

/** The workspace's connection, secrets left out. Owners only. */
export async function getSsoConnection(actorId: string, workspaceId: string): Promise<SsoConnection | null> {
  await requireMembership(actorId, workspaceId, "owner");
  const row = await connectionRow(workspaceId);
  if (!row) return null;
  const domains = domainsFromColumn(row.domain);
  const oidc = row.protocol === "oidc" ? parseJson<OidcStored>(row.oidcConfig) : null;
  const saml = row.protocol === "saml" ? parseJson<SamlStored>(row.samlConfig) : null;
  return {
    protocol: row.protocol,
    domains,
    verified: row.verified === true,
    records: domains.map((domain) => ({ domain, name: domainRecordName(domain), value: domainRecordValue(row.token) })),
    oidc: oidc ? { issuer: oidc.issuer, clientId: oidc.clientId, hasSecret: Boolean(oidc.clientSecret) } : null,
    saml: saml
      ? {
          entryPoint: saml.entryPoint ?? "",
          idpEntityId: saml.idpMetadata?.entityID ?? "",
          hasCertificate: Boolean(saml.cert || saml.idpMetadata?.cert),
          usesMetadata: Boolean(saml.idpMetadata?.metadata),
        }
      : null,
  };
}

export type SsoConnectionInput =
  | { protocol: "oidc"; issuer: string; clientId: string; clientSecret?: string; domains: string }
  | {
      protocol: "saml";
      /** The identity provider's metadata XML, or the three fields below. */
      metadataXml?: string;
      entryPoint?: string;
      idpEntityId?: string;
      certificate?: string;
      domains: string;
    };

/** Whether an identity provider address may be called from here (see ssoTrustedOriginsFrom). */
function trustedOrigin(url: string) {
  try {
    return env.ssoTrustedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export type OidcDiscovery = {
  /** The issuer exactly as the provider names it (ID tokens are checked against it). */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication: "client_secret_basic" | "client_secret_post";
};

const MAX_DISCOVERY_BYTES = 256 * 1024;

/**
 * Reads an issuer's discovery document and checks it: the issuer it names is the one given, and
 * the endpoints are https (http only on trusted origins). The address has to be public unless it
 * is a trusted origin, so an owner can't point the server at something inside its network.
 */
export async function discoverOidc(issuer: string, fetchText = fetchDiscovery): Promise<OidcDiscovery> {
  const url = discoveryUrl(issuer);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await fetchText(url)) as Record<string, unknown>;
  } catch (error) {
    throw new SsoError("discoveryFailed", `Could not read ${url}: ${error instanceof Error ? error.message : error}`, url);
  }
  const exact = typeof doc.issuer === "string" ? doc.issuer : "";
  const named = exact.replace(/\/+$/, "");
  if (!named || named !== issuer.replace(/\/+$/, "")) throw new SsoError("discoveryFailed", `The discovery document names issuer ${named || "(none)"}`, named);
  const endpoint = (key: string, required: boolean) => {
    const value = doc[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !isHttpUrl(value) || (!value.startsWith("https:") && !trustedOrigin(value))) {
      throw new SsoError("discoveryFailed", `The discovery document has no usable ${key}`, key);
    }
    return value;
  };
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : null;
  return {
    issuer: exact,
    authorizationEndpoint: endpoint("authorization_endpoint", true)!,
    tokenEndpoint: endpoint("token_endpoint", true)!,
    jwksEndpoint: endpoint("jwks_uri", true)!,
    userInfoEndpoint: endpoint("userinfo_endpoint", false),
    tokenEndpointAuthentication:
      !methods || methods.includes("client_secret_basic") || !methods.includes("client_secret_post")
        ? "client_secret_basic"
        : "client_secret_post",
  };
}

async function fetchDiscovery(url: string): Promise<string> {
  const trusted = trustedOrigin(url);
  if (!trusted && !url.startsWith("https:")) throw new Error("The issuer must use https");
  const file = await fetchRemoteFile(url, {
    maxBytes: MAX_DISCOVERY_BYTES,
    timeoutMs: 10_000,
    maxRedirects: 0,
    isBlocked: trusted ? () => false : isBlockedAddress,
  });
  return readRemoteText(file, MAX_DISCOVERY_BYTES);
}

const PEM_BODY = /^[A-Za-z0-9+/=\s]+$/;

/** A certificate pasted as PEM or as bare base64, normalized to PEM; null when it isn't one. */
export function normalizeCertificate(input: string): string | null {
  const body = input
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!body || !PEM_BODY.test(body) || body.length < 100) return null;
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

const MAX_METADATA_BYTES = 100 * 1024;

/**
 * The SAML settings stored for a connection: the service provider is this app (entity ID and
 * assertion consumer from ssoEndpoints), signed assertions are required, and the identity provider
 * comes from its metadata XML or from its SSO URL, entity ID and signing certificate.
 */
export function samlConfigFor(workspaceId: string, input: Extract<SsoConnectionInput, { protocol: "saml" }>) {
  const endpoints = ssoEndpoints(env.appUrl, workspaceId);
  const base = {
    issuer: endpoints.samlEntityId,
    audience: endpoints.samlEntityId,
    wantAssertionsSigned: true,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    callbackUrl: "/",
  };
  const xml = input.metadataXml?.trim();
  if (xml) {
    if (Buffer.byteLength(xml) > MAX_METADATA_BYTES || !/<(?:\w+:)?EntityDescriptor[\s>]/.test(xml)) {
      throw new SsoError("invalidSaml", "Paste the identity provider's metadata XML (an EntityDescriptor)");
    }
    const location = /<(?:\w+:)?SingleSignOnService[^>]*Location="([^"]+)"/.exec(xml)?.[1] ?? "";
    return { ...base, entryPoint: location, idpMetadata: { metadata: xml } };
  }
  const entryPoint = input.entryPoint?.trim() ?? "";
  const entityID = input.idpEntityId?.trim() ?? "";
  const cert = normalizeCertificate(input.certificate ?? "");
  if (!isHttpUrl(entryPoint) || !entityID || !cert) {
    throw new SsoError("invalidSaml", "Enter the SSO URL, entity ID and signing certificate, or paste the metadata XML");
  }
  return {
    ...base,
    entryPoint,
    cert,
    idpMetadata: {
      entityID,
      cert,
      singleSignOnService: [{ Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: entryPoint }],
    },
  };
}

/**
 * Editing a SAML connection without pasting its metadata or certificate again keeps the stored
 * ones (the form doesn't show them back): no metadata and no SSO URL keeps the stored metadata;
 * an SSO URL without a certificate keeps the stored certificate.
 */
export function keepSamlInput(
  input: Extract<SsoConnectionInput, { protocol: "saml" }>,
  previous: SamlStored | null,
): Extract<SsoConnectionInput, { protocol: "saml" }> {
  if (!previous || input.metadataXml?.trim()) return input;
  if (!input.entryPoint?.trim()) {
    return previous.idpMetadata?.metadata ? { ...input, metadataXml: previous.idpMetadata.metadata } : input;
  }
  if (!input.certificate?.trim()) {
    const cert = previous.cert ?? previous.idpMetadata?.cert;
    return cert ? { ...input, certificate: cert } : input;
  }
  return input;
}

const newVerificationToken = () => randomBytes(18).toString("base64url");

/**
 * Forgets everyone who signed in through the connection: the accounts linking them to it and the
 * sessions it signed in. A sign-in finds its person by the id the identity provider gives them,
 * under the connection's provider id, which never changes (`ws-<workspace id>`); another identity
 * provider behind it could send any of those ids and sign in as that person. Afterwards people are
 * linked again by their verified domain's address, as on their first sign-in. Returns the people
 * whose sessions ended and everyone it forgot.
 */
export async function forgetConnectionSignIns(tx: Pick<typeof db, "delete">, providerId: string) {
  const linked = await tx.delete(account).where(eq(account.providerId, providerId)).returning({ userId: account.userId });
  const ended = await tx.delete(session).where(eq(session.ssoProviderId, providerId)).returning({ userId: session.userId });
  const signedOut = [...new Set(ended.map((s) => s.userId))];
  return { signedOut, people: [...new Set([...linked.map((a) => a.userId), ...signedOut])] };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * forgetConnectionSignIns, and the API tokens and connected apps of everyone it forgot go too, as
 * on a password reset: whoever signed in through the connection made them, and they aren't held to
 * the sign-in policies, so they would outlast it. In the same transaction, so there is no moment
 * the sign-ins are gone and the tokens still work, and nobody to find again if the process stops
 * after the commit. The counts are for the audit log; once the transaction commits, finish with
 * afterCutOff. Also what deleting the workspace does to its connections (deleteWorkspace).
 */
export async function cutOffConnection(tx: Tx, providerId: string) {
  const { signedOut, people } = await forgetConnectionSignIns(tx, providerId);
  const revokedApiTokens = await revokeApiTokensIn(tx, people);
  const apps = await revokeConnectedAppsIn(tx, people);
  return { signedOut, people, apps, counts: { revokedApiTokens, revokedConnectedApps: apps.length } };
}

/**
 * Closes the open pages of the sessions cutOffConnection ended (they would stay writable), forgets
 * when the revoked tokens and apps were used and records the apps disconnected. Those are recorded
 * as the server's doing, naming whose apps they were: the person didn't disconnect them, and the
 * owner who changed the connection may not be in the workspaces that record it, nor should their
 * address and device be.
 */
export async function afterCutOff(cutOff: Awaited<ReturnType<typeof cutOffConnection>>[]) {
  for (const { signedOut, people, apps } of cutOff) {
    for (const userId of signedOut) await disconnectEndedSessions(userId);
    for (const userId of people) {
      await afterApiTokensRevoked(userId);
      const theirs = apps.filter((app) => app.userId === userId);
      await runAsAuditOrigin({ kind: "system" }, () => afterConnectedAppsRevoked(userId, theirs, true));
    }
  }
}

/**
 * Creates or replaces the workspace's connection. Owners only. Changing the domains (or the
 * identity provider behind them) asks for them to be verified again; a secret left empty keeps the
 * stored one. Sessions already signed in through the connection stay signed in while the identity
 * provider stays the same; another one signs everyone out of it and revokes what they reach the
 * app with besides (cutOffConnection).
 */
export async function saveSsoConnection(
  actorId: string,
  workspaceId: string,
  input: SsoConnectionInput,
  deps: { discover?: (issuer: string) => Promise<OidcDiscovery> } = {},
) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const parsed = parseDomains(input.domains);
  if (!parsed.ok) throw new SsoError("invalidDomain", `Not a domain that can be claimed: ${parsed.invalid}`, parsed.invalid);
  if (!parsed.domains.length) throw new SsoError("noDomains", "Add at least one email domain");
  const domains = parsed.domains;
  const existing = await connectionRow(workspaceId);
  const providerId = workspaceProviderId(workspaceId);

  let issuer: string;
  let oidcConfig: string | null = null;
  let samlConfig: string | null = null;
  if (input.protocol === "oidc") {
    issuer = input.issuer.trim();
    if (!isHttpUrl(issuer) || (!issuer.startsWith("https:") && !trustedOrigin(issuer))) {
      throw new SsoError("invalidIssuer", "The issuer must be an https URL", issuer);
    }
    const clientId = input.clientId.trim();
    if (!clientId) throw new SsoError("clientIdRequired", "Enter the client ID");
    const previous = existing?.protocol === "oidc" ? parseJson<OidcStored>(existing.oidcConfig) : null;
    const clientSecret = input.clientSecret?.trim() || previous?.clientSecret;
    if (!clientSecret) throw new SsoError("secretRequired", "Enter the client secret");
    const discovery = await (deps.discover ?? ((i: string) => discoverOidc(i)))(issuer);
    // Stored as the provider names it: "https://idp/x" and "https://idp/x/" are different issuers
    // to the ID token check.
    issuer = discovery.issuer;
    oidcConfig = JSON.stringify({
      pkce: true,
      clientId,
      clientSecret,
      discoveryEndpoint: discoveryUrl(issuer),
      ...discovery,
      issuer,
      scopes: SSO_SCOPES,
    });
  } else {
    const previous = existing?.protocol === "saml" ? parseJson<SamlStored>(existing.samlConfig) : null;
    const config = samlConfigFor(workspaceId, keepSamlInput(input, previous));
    issuer = config.issuer;
    samlConfig = JSON.stringify(config);
  }

  const sameDomains = existing !== null && domainsFromColumn(existing.domain).join(",") === domains.join(",");
  const sameIdentity = existing !== null && sameIdentityProvider(existing, { protocol: input.protocol, issuer, samlConfig });
  // Only domains that stay the same, behind the same identity provider, stay verified.
  const verified = sameDomains && sameIdentity && existing.verified === true;
  const fields = {
    issuer,
    oidcConfig,
    samlConfig,
    domain: domains.join(","),
    domainVerified: verified,
  };
  const cutOff = await db.transaction(async (tx) => {
    const cutOff = existing && !sameIdentity ? await cutOffConnection(tx, providerId) : null;
    if (existing) {
      await tx.update(ssoProvider).set(fields).where(eq(ssoProvider.providerId, providerId));
      await tx
        .update(workspaceSso)
        .set({ protocol: input.protocol, ...(sameDomains ? {} : { verificationToken: newVerificationToken() }) })
        .where(eq(workspaceSso.workspaceId, workspaceId));
    } else {
      await tx.insert(ssoProvider).values({ id: crypto.randomUUID(), providerId, userId: actorId, ...fields });
      await tx.insert(workspaceSso).values({
        workspaceId,
        providerId,
        protocol: input.protocol,
        verificationToken: newVerificationToken(),
        createdBy: actorId,
      });
    }
    await recordAudit(
      {
        workspaceId,
        actorId,
        action: "sso.configured",
        target: { type: "sso", id: providerId },
        details: { protocol: input.protocol, domains, created: !existing, verified, ...cutOff?.counts },
      },
      tx,
    );
    return cutOff;
  });
  if (cutOff) await afterCutOff([cutOff]);
  return getSsoConnection(actorId, workspaceId);
}

type TxtResolver = (name: string) => Promise<string[][]>;
type Reader = Pick<typeof db, "select">;

const overlapping = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * The first of the domains already used for single sign-on elsewhere, subdomains either way:
 * verified by another connection, the instance provider's (OIDC_DOMAINS), or another workspace's
 * proven allowed domain. Null when none is.
 */
async function domainTakenElsewhere(reader: Reader, workspaceId: string, providerId: string, domains: string[]) {
  const others = await reader
    .select({ domain: ssoProvider.domain })
    .from(ssoProvider)
    .where(and(eq(ssoProvider.domainVerified, true), ne(ssoProvider.providerId, providerId)));
  const taken = [
    ...others.flatMap((o) => domainsFromColumn(o.domain)),
    ...(env.instanceOidc?.domains ?? []),
    ...(await allowedDomainsProvenElsewhere(workspaceId, reader)),
  ];
  return domains.find((domain) => taken.some((other) => overlapping(domain, other))) ?? null;
}

const domainTaken = (domain: string) => new SsoError("domainTaken", `${domain} is already used for single sign-on elsewhere`, domain);

/** Every verification takes it before marking domains verified, so two can't each miss the other. */
const VERIFICATION_LOCK = "leafdesk:sso-domain-verification";

/**
 * The connection as it is now, its rows locked until the transaction ends: the provider's first,
 * then the workspace's, the order saveSsoConnection writes them in.
 */
async function lockedConnection(tx: Tx, workspaceId: string, providerId: string) {
  const [provider] = await tx
    .select({ issuer: ssoProvider.issuer, domain: ssoProvider.domain, samlConfig: ssoProvider.samlConfig })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .for("update");
  const [connection] = await tx
    .select({ providerId: workspaceSso.providerId, protocol: workspaceSso.protocol, token: workspaceSso.verificationToken })
    .from(workspaceSso)
    .where(eq(workspaceSso.workspaceId, workspaceId))
    .for("update");
  return provider && connection?.providerId === providerId ? { ...provider, ...connection } : null;
}

/**
 * Verifies the connection's domains: each needs a TXT record `_leafdesk-sso.<domain>` with the
 * connection's value, and none may already be verified by another connection (or be the
 * instance provider's, or another workspace's proven allowed domain). Owners only.
 *
 * The lookups take as long as the domains' DNS servers like, and an owner's own servers answer
 * when the owner wants. So once the records are found, the domains are marked verified only if
 * the connection still has the domains, token and identity provider they were looked up for, and
 * no other connection verified one of them meanwhile (checked under a lock every verification
 * takes). Otherwise an owner could save someone else's domain while their own is looked up, and
 * have it verified with it.
 */
export async function verifySsoDomains(actorId: string, workspaceId: string, resolver: TxtResolver = resolveTxt) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const row = await connectionRow(workspaceId);
  if (!row) throw new SsoError("noConnection", "Set up single sign-on first");
  const domains = domainsFromColumn(row.domain);
  const taken = await domainTakenElsewhere(db, workspaceId, row.providerId, domains);
  if (taken) throw domainTaken(taken);
  const expected = domainRecordValue(row.token);
  for (const domain of domains) {
    const records = await resolver(domainRecordName(domain)).catch(() => [] as string[][]);
    if (!records.some((parts) => parts.join("").trim() === expected)) {
      throw new SsoError("dnsMismatch", `No TXT record ${domainRecordName(domain)} with the expected value`, domain);
    }
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${VERIFICATION_LOCK}))`);
    const now = await lockedConnection(tx, workspaceId, row.providerId);
    if (!now) throw new SsoError("noConnection", "Set up single sign-on first");
    if (now.domain !== row.domain || now.token !== row.token || !sameIdentityProvider(now, row)) {
      throw new SsoError("connectionChanged", "The connection changed while its domains were being verified");
    }
    const takenMeanwhile = await domainTakenElsewhere(tx, workspaceId, row.providerId, domains);
    if (takenMeanwhile) throw domainTaken(takenMeanwhile);
    await tx.update(ssoProvider).set({ domainVerified: true }).where(eq(ssoProvider.providerId, row.providerId));
    await recordAudit(
      { workspaceId, actorId, action: "sso.domains_verified", target: { type: "sso", id: row.providerId }, details: { domains } },
      tx,
    );
  });
  return getSsoConnection(actorId, workspaceId);
}

/**
 * Removes the connection (its provider row goes with it, see the trigger in 0022_sso.sql) and
 * everyone's sign-ins through it, with their API tokens and connected apps (cutOffConnection: a new
 * connection gets the same provider id). The "SSO only" login method falls back to any method unless the instance provider remains.
 * Owners only.
 */
export async function removeSsoConnection(actorId: string, workspaceId: string) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const cutOff = await db.transaction(async (tx) => {
    const cutOff: Awaited<ReturnType<typeof cutOffConnection>>[] = [];
    const removed = await tx.delete(workspaceSso).where(eq(workspaceSso.workspaceId, workspaceId)).returning({ providerId: workspaceSso.providerId });
    for (const { providerId } of removed) {
      const connection = await cutOffConnection(tx, providerId);
      cutOff.push(connection);
      await recordAudit({ workspaceId, actorId, action: "sso.removed", target: { type: "sso", id: providerId }, details: connection.counts }, tx);
    }
    if (!env.instanceOidc) {
      const [row] = await tx.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
      if (row?.settings.loginMethod === "sso") {
        await tx
          .update(workspace)
          .set({ settings: { ...row.settings, loginMethod: "any" } })
          .where(eq(workspace.id, workspaceId));
      }
    }
    return cutOff;
  });
  await afterCutOff(cutOff);
}

/** For the "SSO only" gate: the provider a member of the workspace signs in with. */
export async function workspaceSignInProvider(workspaceId: string): Promise<{ providerId: string; name: string } | null> {
  if (env.localMode) return null;
  const [row] = await db
    .select({ providerId: ssoProvider.providerId })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(and(eq(workspaceSso.workspaceId, workspaceId), eq(ssoProvider.domainVerified, true)))
    .limit(1);
  if (row) return { providerId: row.providerId, name: "" };
  const instance = env.instanceOidc;
  return instance ? { providerId: INSTANCE_SSO_PROVIDER_ID, name: instance.name } : null;
}
