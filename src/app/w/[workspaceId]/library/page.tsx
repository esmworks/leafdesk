import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LibraryPage, type LibraryData, type LibraryPageItem, type LibraryTab } from "@/components/library/library-page";
import { withRow } from "@/lib/row-panel";
import { PRIVATE_SECTION, SHARED_SECTION } from "@/lib/tree-sections";
import { AccessError, getMembership, isGuest } from "@/server/access";
import { agentCreationInfo } from "@/server/agents/creation";
import { sidebarAgents } from "@/server/agents/manage";
import { canCreateAgents } from "@/server/agents/sharing";
import { listMeetings } from "@/server/meetings";
import { listFavorites } from "@/server/page-meta";
import { recentlyViewedPages } from "@/server/page-views";
import { getTree, parentTitles, recentPages } from "@/server/pages";
import { requireWorkspaceSession } from "@/server/session";
import { findSkillDatabase, listSkills } from "@/server/skills";
import { canCreateTeamspace, listTeamspaces } from "@/server/teamspaces";
import { topLevelAccess } from "@/server/workspaces";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("sidebar.nav");
  return { title: t("library") };
}

const TABS: readonly LibraryTab[] = ["teamspaces", "recents", "favorites", "shared", "private", "meetings", "agents", "skills"];
/** What a guest has no list of: teamspaces and agents are members' alone. */
const MEMBERS_ONLY: readonly LibraryTab[] = ["teamspaces", "agents"];
/** How many recent pages the tab lists. */
const RECENTS = 50;

/**
 * The workspace's library: its teamspaces, recent, favorite, shared and private pages, meeting notes,
 * agents and skills, one tab at a time (`?tab=`), each loaded only when shown.
 */
export default async function LibraryRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const { user } = await requireWorkspaceSession(workspaceId);
  const [membership, topLevel] = await Promise.all([getMembership(user.id, workspaceId), topLevelAccess(user.id, workspaceId)]);
  if (!membership) notFound();
  const guest = isGuest(membership.role);
  const tabs = TABS.filter((tab) => !(guest && MEMBERS_ONLY.includes(tab)));
  const asked = typeof query.tab === "string" ? (query.tab as LibraryTab) : null;
  const tab = asked && tabs.includes(asked) ? asked : tabs[0];
  const pageHref = (id: string) => `/w/${workspaceId}/p/${id}`;

  let data: LibraryData;
  try {
    data = await load();
  } catch (error) {
    if (error instanceof AccessError) notFound();
    throw error;
  }

  async function load(): Promise<LibraryData> {
    switch (tab) {
      case "teamspaces": {
        const [teamspaces, canCreate] = await Promise.all([listTeamspaces(user.id, workspaceId), canCreateTeamspace(user.id, workspaceId)]);
        return {
          tab,
          canCreate,
          isOwner: membership!.role === "owner",
          teamspaces: teamspaces.map((t) => ({
            id: t.id,
            name: t.name,
            icon: t.icon,
            description: t.description,
            access: t.access,
            members: t.memberCount,
            joined: t.joined,
          })),
        };
      }
      case "recents": {
        const pages = (await recentlyViewedPages(user.id, workspaceId, RECENTS)) ?? (await recentPages(user.id, workspaceId, RECENTS));
        const places = await parentTitles(
          user.id,
          pages.map((p) => p.id),
        );
        return {
          tab,
          canCreate: topLevel !== null,
          pages: pages.map((p) => ({
            id: p.id,
            title: p.title,
            icon: p.icon,
            kind: p.kind,
            href: pageHref(p.id),
            place: places.get(p.id) ?? null,
            when: (p.viewedAt ?? p.updatedAt).toISOString(),
          })),
        };
      }
      case "favorites": {
        const pages = await listFavorites(user.id, workspaceId);
        const places = await parentTitles(
          user.id,
          pages.map((p) => p.id),
        );
        return {
          tab,
          canCreate: topLevel !== null,
          pages: pages.map(
            (p): LibraryPageItem => ({
              id: p.id,
              title: p.title,
              icon: p.icon,
              kind: p.kind,
              href: pageHref(p.id),
              place: places.get(p.id) ?? null,
              when: new Date(p.updatedAt).toISOString(),
            }),
          ),
        };
      }
      case "shared":
      case "private": {
        const section = tab === "shared" ? SHARED_SECTION : PRIVATE_SECTION;
        const tree = await getTree(user.id, workspaceId);
        const children = new Map<string, number>();
        for (const node of tree) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
        return {
          tab,
          canCreate: topLevel !== null,
          pages: tree
            .filter((node) => node.section === section && node.parentId === null)
            .map((node) => ({
              id: node.id,
              title: node.title,
              icon: node.icon,
              kind: node.kind,
              href: pageHref(node.id),
              place: null,
              when: null,
              inside: children.get(node.id) ?? 0,
            })),
        };
      }
      case "meetings":
        return { tab, canCreate: topLevel !== null, meetings: await listMeetings(user.id, workspaceId) };
      case "agents": {
        const [agents, mayCreate] = await Promise.all([sidebarAgents(user.id, workspaceId), canCreateAgents(user.id, workspaceId)]);
        return {
          tab,
          agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon, description: a.description, enabled: a.enabled })),
          creation: mayCreate ? await agentCreationInfo(user.id, workspaceId) : null,
        };
      }
      case "skills": {
        const [skills, database] = await Promise.all([listSkills(user.id, workspaceId), findSkillDatabase(user.id, workspaceId)]);
        return {
          tab,
          canCreate: topLevel !== null || database !== null,
          skills: skills.map((s) => ({
            id: s.id,
            title: s.title,
            icon: s.icon,
            description: s.description,
            href: s.database ? withRow(pageHref(s.database.id), s.id) : pageHref(s.id),
            database: s.database ? s.database.title : null,
            when: s.updatedAt.toISOString(),
          })),
        };
      }
    }
  }

  return <LibraryPage workspaceId={workspaceId} tabs={tabs} data={data} privateOnly={topLevel === "private"} />;
}
