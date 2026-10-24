import type { TeamspaceAccess, TeamspaceMemberLevel } from "@/db/schema/app";
import type { PageLevel } from "@/db/schema/permissions";

/**
 * Turning a page into a teamspace (server/teamspace-from-page.ts): who joins it and how open it is,
 * worked out so that nobody named on the page gets more than they had, or less.
 */

/**
 * What the teamspace's members get on its pages: as much as those who join it as members had on
 * the page (edit), so joining raises nobody. Its owners can change it afterwards.
 */
export const MEMBER_LEVEL_FROM_PAGE: TeamspaceMemberLevel = "edit";

/** A person or group named on the page (or on a page above it, the nearest entry), and at what level. */
export type PageShare = { userId: string; level: PageLevel; /** An owner or member of the workspace, who may be in teamspaces. */ eligible: boolean };
export type PageGroupShare = { groupId: string; level: PageLevel };

/**
 * Who joins the teamspace made from a page: whoever turns it (an owner), the owners and members of
 * the workspace with full access to the page (owners: they ran it) and those who may edit it
 * (members, at MEMBER_LEVEL_FROM_PAGE); groups that may edit it or more join as groups do, as
 * members. Everyone else named on it (guests, and those who may view or comment) keeps the entry
 * they have on the pages: `kept`.
 */
export function teamspaceFromShares(actorId: string, people: PageShare[], groups: PageGroupShare[]) {
  const owners = [actorId, ...people.filter((p) => p.eligible && p.level === "full" && p.userId !== actorId).map((p) => p.userId)];
  const members = people.filter((p) => p.eligible && p.level === "edit" && p.userId !== actorId).map((p) => p.userId);
  const joined = new Set([...owners, ...members]);
  return {
    owners,
    members,
    groupIds: groups.filter((g) => g.level === "edit" || g.level === "full").map((g) => g.groupId),
    kept: people.filter((p) => !joined.has(p.userId) && p.level !== "none").map((p) => p.userId),
  };
}

/**
 * How open the teamspace made from a page is: as open as where the page was. A private page, or one
 * of a private teamspace, makes a private teamspace (only its members know it is there); one of a
 * closed teamspace a closed one; one of an open or default teamspace an open one, whose pages
 * everyone in the workspace may still read.
 */
export function accessFromPlace(teamspaceAccess: TeamspaceAccess | null): TeamspaceAccess {
  if (teamspaceAccess === null || teamspaceAccess === "private") return "private";
  if (teamspaceAccess === "closed") return "closed";
  return "open";
}
