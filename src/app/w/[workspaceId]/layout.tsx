import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AiChatProvider } from "@/components/ai-chat/chat-panel";
import { StaleClientScreen } from "@/components/collab/stale-client";
import { OfflineProvider } from "@/components/offline/offline-context";
import { Sidebar } from "@/components/sidebar/sidebar";
import { FloatingSidebarButton, SidebarProvider } from "@/components/sidebar/sidebar-context";
import { requestedPageId } from "@/lib/access-requests";
import { canCreateWorkspace, isInstanceAdmin } from "@/lib/instance-admin";
import { USER_MARKER } from "@/lib/offline";
import { parseSidebarCookie, SIDEBAR_COOKIE } from "@/lib/sidebar-layout";
import { getMembership } from "@/server/access";
import { isEnabled as aiConfigured } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { joinableWorkspaces } from "@/server/join-requests";
import { listFavorites } from "@/server/page-meta";
import { getSidebar, listWorkspaces } from "@/server/pages";
import { requestedPath, requireSession, requireWorkspaceSession } from "@/server/session";
import { canCreateTeamspace } from "@/server/teamspaces";
import { getSidebarLayout, topLevelAccess } from "@/server/workspaces";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { user } = await requireSession();
  const { workspaceId } = await params;
  // Before anything that reads the workspace (those throw for a held-back session). It only
  // redirects members, so outsiders don't learn the workspace exists.
  await requireWorkspaceSession(workspaceId);
  if (!(await getMembership(user.id, workspaceId))) {
    // A link to a page gets the "You don't have access" screen, without anything of the workspace
    // around it (the page route shows the same screen whether the page or workspace exists).
    if (requestedPageId(await requestedPath(), workspaceId)) {
      return <main className="h-full overflow-y-auto">{children}</main>;
    }
    notFound();
  }
  const [workspaces, joinable, sidebar, favorites, topLevel, canCreate, cookieStore, ai, sidebarLayout] = await Promise.all([
    listWorkspaces(user.id),
    joinableWorkspaces(user.id),
    getSidebar(user.id, workspaceId),
    listFavorites(user.id, workspaceId),
    topLevelAccess(user.id, workspaceId),
    canCreateTeamspace(user.id, workspaceId),
    cookies(),
    aiAvailable(workspaceId),
    getSidebarLayout(user.id, workspaceId),
  ]);

  const body = (
    <div className="flex h-full">
      <Sidebar
        workspaceId={workspaceId}
        workspaces={workspaces}
        joinable={joinable}
        initialTree={sidebar.tree}
        initialTeamspaces={sidebar.teamspaces}
        canCreateTeamspace={canCreate}
        canCreateWorkspace={canCreateWorkspace(user)}
        isInstanceAdmin={isInstanceAdmin(user)}
        initialFavorites={favorites}
        topLevel={topLevel}
        initialLayout={sidebarLayout}
        user={{ id: user.id, name: user.name, email: user.email, image: user.image ?? null }}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <FloatingSidebarButton />
        {children}
      </main>
    </div>
  );

  return (
    <OfflineProvider userId={user.id}>
      {/* The service worker files this page's HTML under this user for offline use (public/sw.js). */}
      <meta name={USER_MARKER} content={user.id} />
      <StaleClientScreen />
      <SidebarProvider initial={parseSidebarCookie(cookieStore.get(SIDEBAR_COOKIE)?.value)}>
        {/* The AI chat panel (#41), when the server has an AI provider. */}
        {aiConfigured() ? (
          <AiChatProvider workspaceId={workspaceId} available={ai}>
            {body}
          </AiChatProvider>
        ) : (
          body
        )}
      </SidebarProvider>
    </OfflineProvider>
  );
}
