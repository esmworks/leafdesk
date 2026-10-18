import { hkdfSync } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { DEFAULT_WORKSPACE_SETTINGS, ssoProvider, workspace, workspaceSso } from "@/db/schema";
import { env } from "@/lib/env";
import { verifiedAllowedDomains } from "@/lib/membership-policy";
import { domainRecordName, domainRecordValue, domainsFromColumn, workspaceProviderId } from "@/lib/sso-config";
import { requireMember, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { refuseInLocalMode } from "@/server/local-mode";

/**
 * Proving allowed email domains (Settings > Security). An allowed domain lets its people join the
 * workspace on their own, or ask to (server/join-requests.ts), so it takes effect only once the
 * workspace has proven the domain is its own, as single sign-on does (server/sso.ts): a TXT record
 * `_leafdesk-sso.<domain>` with the workspace's value. Otherwise any owner, and anyone can own a
 * workspace, could list another organization's domain and take in, or hear about, its people.
 *
 * Proven domains are kept in the workspace settings (`allowedDomainsVerified`). A domain the
 * workspace's single sign-on connection verified counts without a record of its own, subdomains
 * included, and a domain one workspace proved (for either) can't be proven by another.
 */

export type AllowedDomainErrorCode = "notListed" | "dnsMismatch" | "domainTaken";

/** An expected failure an owner can act on; `code` is translated by the UI, `detail` names the domain. */
export class AllowedDomainError extends Error {
  constructor(
    readonly code: AllowedDomainErrorCode,
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "AllowedDomainError";
  }
}

type Reader = Pick<typeof db, "select">;
type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * The value that goes into the workspace's TXT records. Derived from BETTER_AUTH_SECRET, so it
 * needs no storage and nobody can work it out from the workspace id; a new secret changes the
 * value of records still to be added, never a domain already proven.
 */
export function allowedDomainToken(workspaceId: string) {
  return Buffer.from(hkdfSync("sha256", env.authSecret, "leafdesk-allowed-domains", workspaceId, 18)).toString("base64url");
}

/** The domains the workspace's single sign-on connection has verified; none without one. */
export async function ssoVerifiedDomains(reader: Reader, workspaceId: string): Promise<string[]> {
  const rows = await reader
    .select({ domain: ssoProvider.domain })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(and(eq(workspaceSso.workspaceId, workspaceId), eq(ssoProvider.domainVerified, true)));
  return rows.flatMap((r) => domainsFromColumn(r.domain));
}

/** The allowed domains other workspaces have proven by DNS (and still allow). */
export async function allowedDomainsProvenElsewhere(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ settings: workspace.settings })
    .from(workspace)
    .where(and(ne(workspace.id, workspaceId), sql`coalesce(${workspace.settings}->'allowedDomainsVerified', '[]'::jsonb) <> '[]'::jsonb`));
  return rows.flatMap((r) => {
    const settings = { ...DEFAULT_WORKSPACE_SETTINGS, ...r.settings };
    return settings.allowedDomains.filter((d) => settings.allowedDomainsVerified.includes(d));
  });
}

const overlapping = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** Domains other workspaces have verified for single sign-on or proven as allowed domains. */
async function domainsTakenElsewhere(workspaceId: string) {
  const sso = await db
    .select({ domain: ssoProvider.domain })
    .from(ssoProvider)
    .where(and(eq(ssoProvider.domainVerified, true), ne(ssoProvider.providerId, workspaceProviderId(workspaceId))));
  return [...sso.flatMap((r) => domainsFromColumn(r.domain)), ...(await allowedDomainsProvenElsewhere(workspaceId))];
}

export type AllowedDomainStatus = {
  domain: string;
  /**
   * How the workspace proved it: its own TXT record (`dns`, or one for a parent domain it allows),
   * its single sign-on connection (`sso`), or not yet (null: the domain does nothing).
   */
  verifiedBy: "dns" | "sso" | null;
  /** The TXT record that proves it, for owners. */
  record: { name: string; value: string } | null;
};

async function settingsOf(reader: Reader, workspaceId: string) {
  const [row] = await reader.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...row?.settings };
}

/** Each allowed domain and whether it is proven; owners also get the records to add. Members and owners. */
export async function allowedDomainsStatus(actorId: string, workspaceId: string): Promise<AllowedDomainStatus[]> {
  const { role } = await requireMember(actorId, workspaceId);
  const [settings, ssoDomains] = await Promise.all([settingsOf(db, workspaceId), ssoVerifiedDomains(db, workspaceId)]);
  const byDns = verifiedAllowedDomains({ ...settings, ssoDomains: [] });
  const bySso = verifiedAllowedDomains({ ...settings, ssoDomains });
  const value = domainRecordValue(allowedDomainToken(workspaceId));
  return settings.allowedDomains.map((domain) => ({
    domain,
    verifiedBy: byDns.includes(domain) ? "dns" : bySso.includes(domain) ? "sso" : null,
    record: role === "owner" ? { name: domainRecordName(domain), value } : null,
  }));
}

/**
 * Proves one of the allowed domains: it needs a TXT record `_leafdesk-sso.<domain>` with the
 * workspace's value, and may not overlap a domain another workspace verified for single sign-on or
 * proved as an allowed domain. Owners only.
 */
export async function verifyAllowedDomain(actorId: string, workspaceId: string, domain: string, resolver: TxtResolver = resolveTxt) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const target = String(domain).trim().toLowerCase();
  const [settings, ssoDomains] = await Promise.all([settingsOf(db, workspaceId), ssoVerifiedDomains(db, workspaceId)]);
  if (!settings.allowedDomains.includes(target)) {
    throw new AllowedDomainError("notListed", `${target} isn't one of the allowed domains`, target);
  }
  if (verifiedAllowedDomains({ ...settings, ssoDomains }).includes(target)) return allowedDomainsStatus(actorId, workspaceId);
  if ((await domainsTakenElsewhere(workspaceId)).some((other) => overlapping(target, other))) {
    throw new AllowedDomainError("domainTaken", `${target} is already verified by another workspace`, target);
  }
  const expected = domainRecordValue(allowedDomainToken(workspaceId));
  const records = await resolver(domainRecordName(target)).catch(() => [] as string[][]);
  if (!records.some((parts) => parts.join("").trim() === expected)) {
    throw new AllowedDomainError("dnsMismatch", `No TXT record ${domainRecordName(target)} with the expected value`, target);
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    const current = { ...DEFAULT_WORKSPACE_SETTINGS, ...row?.settings };
    // Taken off the list while DNS was asked: nothing to prove any more.
    if (!current.allowedDomains.includes(target)) {
      throw new AllowedDomainError("notListed", `${target} isn't one of the allowed domains`, target);
    }
    const verified = [...current.allowedDomainsVerified.filter((d) => d !== target && current.allowedDomains.includes(d)), target];
    await tx
      .update(workspace)
      .set({ settings: sql`${workspace.settings} || ${JSON.stringify({ allowedDomainsVerified: verified })}::jsonb` })
      .where(eq(workspace.id, workspaceId));
    await recordAudit(
      { workspaceId, actorId, action: "workspace.domains_verified", target: { type: "workspace", id: workspaceId }, details: { domains: [target] } },
      tx,
    );
  });
  return allowedDomainsStatus(actorId, workspaceId);
}
