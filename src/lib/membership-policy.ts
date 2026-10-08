import type { JoinRequestStatus, WorkspaceRole, WorkspaceSettings } from "@/db/schema/app";
import { emailInDomains } from "@/lib/sso-config";

/**
 * Who may bring people into a workspace, and how (issue #56). Pure decisions over the workspace's
 * settings and what is known about the person; server/join-requests.ts and server/workspaces.ts
 * look the facts up and act on the answer, so every way in (the members dialog, the join link,
 * signing in, the workspace switcher) follows the same rules.
 */

type MembershipSettings = Pick<WorkspaceSettings, "memberInvites" | "allowedDomains" | "domainJoin" | "joinRequests">;

/**
 * What adding a member does when `role` asks: add or invite right away, file a request an owner
 * approves, or nothing (refused). Owners always add; members as the workspace allows; guests never.
 */
export function memberInviteMode(role: WorkspaceRole | null, settings: Pick<WorkspaceSettings, "memberInvites">) {
  if (role === "owner") return "direct" as const;
  if (role !== "member") return "denied" as const;
  if (settings.memberInvites === "any_member") return "direct" as const;
  if (settings.memberInvites === "members_with_approval") return "request" as const;
  return "denied" as const;
}

/** The roles someone may add people with: owners any, members only members. */
export function assignableRoles(role: WorkspaceRole | null): WorkspaceRole[] {
  if (role === "owner") return ["owner", "member", "guest"];
  if (role === "member") return ["member"];
  return [];
}

/** What is known about the person asking to come in. */
export type Candidate = {
  email: string;
  /** Their address is proven theirs (a verification link, or a provider that vouches for it). */
  emailVerified: boolean;
  /** Their join request for this workspace, if any: pending, or how it was decided. */
  record: JoinRequestStatus | null;
};

/**
 * - `join`: may join now.
 * - `request`: may ask an owner.
 * - `pending`: has asked already and waits.
 * - null: neither.
 */
export type Access = "join" | "request" | "pending" | null;

export const onAllowedDomain = (email: string, settings: Pick<WorkspaceSettings, "allowedDomains">) =>
  settings.allowedDomains.length > 0 && emailInDomains(email, settings.allowedDomains);

/**
 * What someone on one of the workspace's allowed domains may do from the workspace switcher.
 * A verified address joins or asks, as the domain rule says, unless an owner declined them (or
 * removed them) before: then they may only ask again, and only while the workspace takes requests.
 * An unverified address never joins; it may ask while the workspace takes requests from its domains.
 */
export function domainAccess(settings: MembershipSettings, candidate: Candidate): Access {
  if (!onAllowedDomain(candidate.email, settings)) return null;
  if (candidate.record === "pending") return "pending";
  const takesRequests = settings.joinRequests !== "nobody";
  if (candidate.emailVerified && candidate.record !== "declined") return settings.domainJoin;
  return takesRequests ? "request" : null;
}

/**
 * What signing up, signing in or verifying the address does on its own: the domain rule runs once
 * per person and workspace (see `workspaceJoinRequest`), and only for a verified address.
 */
export function automaticAccess(settings: MembershipSettings, candidate: Candidate): "join" | "request" | null {
  if (!candidate.emailVerified || candidate.record !== null) return null;
  if (!onAllowedDomain(candidate.email, settings)) return null;
  return settings.domainJoin;
}

/**
 * Whether a pending invitation for the person's address is theirs to use. Anyone can sign up with
 * someone else's address without proving it, so only a verified address takes up an invitation
 * that reached it by email alone (the join link carries no proof of who it was sent to).
 */
export function invitationApplies(candidate: Pick<Candidate, "emailVerified"> & { invited: boolean }) {
  return candidate.invited && candidate.emailVerified;
}

/**
 * What opening the join link lets someone do. The link adds anyone as a member, as it always has,
 * unless the workspace takes requests from anyone with the link: then it asks an owner, except for
 * people who could join anyway (a pending invitation for their verified address, or their verified
 * domain).
 */
export function linkAccess(settings: MembershipSettings, candidate: Candidate & { invited: boolean }): Access {
  if (invitationApplies(candidate) || settings.joinRequests !== "anyone_with_link") return "join";
  const domain = domainAccess(settings, candidate);
  if (domain === "join" || domain === "pending") return domain;
  return candidate.record === "pending" ? "pending" : "request";
}
