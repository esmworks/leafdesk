import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { FirstAdminNotice } from "@/components/admin/first-admin-notice";
import { AiChatProvider } from "@/components/ai-chat/chat-panel";
import { StaleClientScreen } from "@/components/collab/stale-client";
import { CalloutStylesProvider } from "@/components/page/callout-styles-context";
import { RowPanelProvider } from "@/components/database/row-panel";
import { MeetingRecorderProvider } from "@/components/voice/meeting-recorder";
import { OfflineProvider } from "@/components/offline/offline-context";
import { Sidebar } from "@/components/sidebar/sidebar";
import { FloatingSidebarButton, SidebarProvider } from "@/components/sidebar/sidebar-context";
import { DesktopLinkOffer } from "@/components/workspace/desktop-link-offer";
import { Toaster } from "@/components/toast";
import { TruncatedTitles } from "@/components/workspace/truncated-titles-watcher";
import { requestedPageId } from "@/lib/access-requests";
import { env } from "@/lib/env";
import { canCreateWorkspace, isInstanceAdmin } from "@/lib/instance-admin";
import { USER_MARKER } from "@/lib/offline";
import { parseSidebarCookie, SIDEBAR_COOKIE } from "@/lib/sidebar-layout";
import { getMembership } from "@/server/access";
import { aiEnabledFor } from "@/server/ai";
import { chatOptionsFor } from "@/server/ai-chat";
import { memoryAvailable } from "@/server/ai-memory";
import { aiAvailable } from "@/server/ai-writing";
import { calloutStylesOf } from "@/server/callout-styles";
import { getDesktopLinks } from "@/server/desktop-links";
import { firstAdminId } from "@/server/first-admin";
import { joinableWorkspaces } from "@/server/join-requests";
import { listFavorites } from "@/server/page-meta";
import { getSidebar, listWorkspaces } from "@/server/pages";
import { requestedPath, requireSession, requireWorkspaceSession } from "@/server/session";
import { canCreateTeamspace } from "@/server/teamspaces";
import { voiceNoteLimits } from "@/server/voice-notes";
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
  const [workspaces, joinable, sidebar, favorites, topLevel, canCreate, cookieStore, ai, sidebarLayout, memory, aiConfigured, calloutStyles, firstAdmin, voice, chatOptions, desktopLinks] = await Promise.all([
    listWorkspaces(user.id),
    joinableWorkspaces(user.id),
    getSidebar(user.id, workspaceId),
    listFavorites(user.id, workspaceId),
    topLevelAccess(user.id, workspaceId),
    canCreateTeamspace(user.id, workspaceId),
    cookies(),
    aiAvailable(workspaceId),
    getSidebarLayout(user.id, workspaceId),
    memoryAvailable(workspaceId),
    aiEnabledFor(workspaceId),
    calloutStylesOf(workspaceId),
    firstAdminId(),
    voiceNoteLimits(workspaceId),
    chatOptionsFor(user.id, workspaceId),
    env.localMode ? ("off" as const) : getDesktopLinks(user.id),
  ]);

  const body = (
    // Database rows open in a panel at the right; the page beside it keeps clear of it. Every
    // editor in the workspace draws styled callouts with its callout styles (lib/callout-styles).
    <CalloutStylesProvider styles={calloutStyles}>
      {/* Meetings keep recording while the person moves around the workspace (meeting-recorder.tsx). */}
      <MeetingRecorderProvider workspaceId={workspaceId} limits={voice}>
      <RowPanelProvider workspaceId={workspaceId} user={{ id: user.id, name: user.name }}>
        {/* Wider windows: the sidebar on a gray shell, the page on a card raised from it. */}
        <div className="flex h-full md:bg-bg-shell">
          <Sidebar
            workspaceId={workspaceId}
            workspaces={workspaces}
            joinable={joinable}
            initialTree={sidebar.tree}
            initialTeamspaces={sidebar.teamspaces}
            initialJournalPageId={sidebar.journalPageId}
            canCreateTeamspace={canCreate}
            canCreateWorkspace={canCreateWorkspace(user, undefined, undefined, firstAdmin)}
            isInstanceAdmin={isInstanceAdmin(user, undefined, firstAdmin)}
            initialFavorites={favorites}
            topLevel={topLevel}
            initialLayout={sidebarLayout}
            user={{ id: user.id, name: user.name, email: user.email, image: user.image ?? null }}
          />
          <main className="min-w-0 flex-1 overflow-y-auto md:my-2 md:ms-2 md:me-[calc(var(--row-panel-width,0px)+0.5rem)] md:rounded-md md:border md:border-border md:bg-bg md:shadow-[0_1px_3px_rgb(0_0_0/0.05)]">
            <FloatingSidebarButton />
            {children}
          </main>
          {/* The first account of a new server: it administers it, and sign-up is still open. */}
          {firstAdmin === user.id && !env.signUpDisabled && <FirstAdminNotice workspaceId={workspaceId} />}
          {/* A page opened in a browser offers to go on to the desktop app, for those who turned it on. */}
          {desktopLinks !== "off" && <DesktopLinkOffer preference={desktopLinks} />}
          {/* Notes after moving or trashing, with Undo (components/toast). */}
          <Toaster />
          {/* Text cut short shows in full as a tooltip (components/workspace/truncated-titles). */}
          <TruncatedTitles />
        </div>
      </RowPanelProvider>
      </MeetingRecorderProvider>
    </CalloutStylesProvider>
  );

  return (
    <OfflineProvider userId={user.id}>
      {/* The service worker files this page's HTML under this user for offline use (public/sw.js). */}
      <meta name={USER_MARKER} content={user.id} />
      <StaleClientScreen />
      <SidebarProvider initial={parseSidebarCookie(cookieStore.get(SIDEBAR_COOKIE)?.value)}>
        {/* The AI chat panel (#41), when the workspace has an AI provider (the server's or its own account's). */}
        {aiConfigured ? (
          <AiChatProvider workspaceId={workspaceId} available={ai} memory={ai && memory} voice={voice} options={chatOptions}>
            {body}
          </AiChatProvider>
        ) : (
          body
        )}
      </SidebarProvider>
    </OfflineProvider>
  );
}
