import type { TeamspaceAccess, TeamspaceMemberLevel } from "@/db/schema/app";
import type { PageLevel } from "@/db/schema/permissions";

const ORDER: readonly PageLevel[] = ["none", "view", "comment", "content", "edit", "full"];

/**
 * A teamspace's access, who is in it by row or group (a default one has everyone in it anyway),
 * who owns it, and what its members get where a page says nothing (see TEAMSPACE_MEMBER_LEVELS).
 */
export type TeamspaceReach = {
  access: TeamspaceAccess;
  members: ReadonlySet<string>;
  owners?: ReadonlySet<string>;
  memberLevel?: TeamspaceMemberLevel;
};

/**
 * The least an owner or member of the workspace gets from a page's "everyone" level, the way
 * page_access_level works it out: all of it on a private page (`reach` null) or in a teamspace
 * they are in; up to "comment" on a page of an open teamspace they haven't joined; nothing on a
 * closed or private one's. Guests are never reached; callers leave them out.
 *
 * `fromTeamspace`: no page entry sets "everyone", so it is the teamspace's member level, and the
 * teamspace's owners and the workspace's owners (`workspaceOwner`) get full access instead.
 */
export function everyoneFloor(
  everyone: PageLevel,
  reach: TeamspaceReach | null,
  userId: string,
  { fromTeamspace = false, workspaceOwner = false }: { fromTeamspace?: boolean; workspaceOwner?: boolean } = {},
): PageLevel {
  if (!reach) return everyone;
  const inside = reach.access === "default" || reach.members.has(userId);
  if (inside && fromTeamspace && (workspaceOwner || reach.owners?.has(userId))) return "full";
  if (inside) return everyone;
  if (reach.access === "open") return ORDER.indexOf(everyone) < ORDER.indexOf("comment") ? everyone : "comment";
  return "none";
}
