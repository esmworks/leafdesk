import { isGuest, requireMembership } from "@/server/access";
import { listTeamspaces } from "@/server/teamspaces";
import { workspacePeople } from "@/server/workspaces";

export type SearchFilterOptions = {
  /** The person asking, listed first among `people`. */
  me: string | null;
  /** The teamspaces the person can see, archived ones last. */
  teamspaces: { id: string; name: string; icon: string | null }[];
  /** The person first, then everyone else by name; a guest is offered only themselves. */
  people: { id: string; name: string; email: string; image: string | null }[];
};

/**
 * What the search box's teamspace and people filters offer (lib/search-filters): the teamspaces a
 * member can see and the workspace's people, as person properties offer them. A guest isn't shown
 * the workspace's teamspaces or people, only themselves.
 */
export async function searchFilterOptions(userId: string, workspaceId: string): Promise<SearchFilterOptions> {
  const membership = await requireMembership(userId, workspaceId);
  const guest = isGuest(membership.role);
  const [teamspaces, people] = await Promise.all([guest ? [] : listTeamspaces(userId, workspaceId, { archived: "all" }), workspacePeople(workspaceId)]);
  const listed = people
    .filter((p) => !guest || p.id === userId)
    .sort((a, b) => Number(b.id === userId) - Number(a.id === userId) || (a.name || a.email).localeCompare(b.name || b.email))
    .map(({ id, name, email, image }) => ({ id, name, email, image }));
  return {
    me: userId,
    teamspaces: teamspaces
      .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt))
      .map(({ id, name, icon }) => ({ id, name, icon })),
    people: listed,
  };
}
