import {
  Bot,
  Boxes,
  ChartColumn,
  ContactRound,
  Globe,
  Plug,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";
import { ACCOUNT_ICONS, AccountTabContent } from "@/components/account/account-tabs";
import { AgentsPanel } from "@/components/settings/agents-panel";
import { AnalyticsPanel } from "@/components/settings/analytics-panel";
import { AuditPanel } from "@/components/settings/audit-panel";
import { ConnectionsPanel } from "@/components/settings/connections-panel";
import { GroupsPanel } from "@/components/settings/groups-panel";
import { GuestsPanel } from "@/components/settings/guests-panel";
import { AiSettings } from "@/components/settings/ai-settings";
import { LeaveWorkspaceRow } from "@/components/settings/leave-workspace";
import { MembersPanel } from "@/components/settings/members-panel";
import { PublicForms } from "@/components/settings/public-forms";
import { PublishedPages } from "@/components/settings/published-pages";
import {
  AccessRequestsSetting,
  ConnectedAppsSetting,
  ExportSetting,
  GuestInviteSetting,
  GuestPrivatePagesSetting,
  HistoryRetentionNote,
  MembershipSettings,
  PublishingSetting,
  RequireTwoFactorSetting,
  TrashRetentionSetting,
} from "@/components/settings/security-settings";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { SettingsNav } from "@/components/settings/settings-nav";
import {
  LoginMethodSetting,
  ScimSettings,
  SsoConnectionForm,
  SsoSetupDetails,
} from "@/components/settings/sso-settings";
import { SitePages, SiteSettings } from "@/components/settings/site-settings";
import { TeamspacesPanel } from "@/components/settings/teamspaces-panel";
import { WorkspaceExport } from "@/components/settings/workspace-export";
import { WorkspaceNameForm } from "@/components/settings/workspace-settings";
import { parseAnalyticsPeriod } from "@/lib/analytics";
import { parseAuditFilters } from "@/lib/audit";
import { isStrongSession } from "@/lib/auth-security";
import { isInstanceAdmin } from "@/lib/instance-admin";
import {
  ACCOUNT_SETTINGS_TABS,
  accountTabForSettings,
  type AccountSettingsTab,
  isSettingsTab,
  type SettingsTab,
  visibleSettingsTabs,
} from "@/lib/settings-tabs";
import { AccessError, isGuest } from "@/server/access";
import { builtinAgents } from "@/server/agents/builtin";
import { listAgents } from "@/server/agents/manage";
import { listConnections } from "@/server/connections/manage";
import { aiInfo, embeddingModel } from "@/server/ai";
import { workspaceAnalytics } from "@/server/analytics";
import { auditActors, listAuditEvents } from "@/server/audit";
import { listWorkspaceFormPublications } from "@/server/forms";
import { listJoinRequests } from "@/server/join-requests";
import { mailStatus } from "@/server/mail";
import { groupsByMember, listGroups } from "@/server/groups";
import { listGuests } from "@/server/guests";
import { listWorkspacePublications } from "@/server/publication";
import { listScimTokens, scimManagedCount } from "@/server/scim";
import { getSsoConnection, ssoSetupInfo } from "@/server/sso";
import { getSession, requireWorkspaceSession } from "@/server/session";
import { getSite } from "@/server/site";
import { canCreateTeamspace, listTeamspaces, teamspacesByMember } from "@/server/teamspaces";
import {
  canInviteGuests,
  countMembersWithoutTwoFactor,
  getJoinLink,
  getWorkspace,
  getWorkspaceSettings,
  lastEdits,
  listInvitations,
  listMembers,
  memberInviteAccess,
  ssoAvailable,
} from "@/server/workspaces";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("metaTitle") };
}

const ICONS: Record<SettingsTab, LucideIcon> = {
  general: Settings,
  members: Users,
  guests: ContactRound,
  teamspaces: Boxes,
  groups: UsersRound,
  agents: Bot,
  connections: Plug,
  analytics: ChartColumn,
  security: Shield,
  audit: ScrollText,
  site: Globe,
};

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const session = await requireWorkspaceSession(workspaceId);
  const { user } = session;
  const workspace = await getWorkspace(user.id, workspaceId).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (!workspace) notFound();
  const isOwner = workspace.role === "owner";
  const guest = isGuest(workspace.role);
  const managesGuests = !guest && (await canInviteGuests(user.id, workspaceId));
  const tabs = visibleSettingsTabs({ guest, managesGuests, owner: isOwner });
  // The person's own settings come first, then the workspace's (the workspace sidebar is hidden here).
  const accountTab = ACCOUNT_SETTINGS_TABS.find((name) => name === query.tab);
  // A workspace tab this person may not open is not found, the way its data routes answer, rather
  // than quietly showing General: the link isn't broken for them, the tab isn't theirs.
  if (isSettingsTab(query.tab) && !tabs.includes(query.tab)) notFound();
  const tab: SettingsTab | AccountSettingsTab = accountTab ?? tabs.find((name) => name === query.tab) ?? "general";
  const [t, ta] = await Promise.all([getTranslations("settings"), getTranslations("account")]);
  const href = (name: string) => `/w/${workspaceId}/settings?tab=${name}`;

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav
        label={t("title")}
        back={{ href: `/w/${workspaceId}`, label: ta("back", { workspace: workspace.name }) }}
        groups={[
          {
            label: ta("title"),
            items: [
              ...ACCOUNT_SETTINGS_TABS.map((name) => {
                const account = accountTabForSettings(name);
                return { href: href(name), label: ta(`nav.${account}`), icon: ACCOUNT_ICONS[account], active: tab === name };
              }),
              // Instance admins (ADMIN_EMAILS) reach the server's administration from here too.
              ...(isInstanceAdmin(user)
                ? [{ href: `/admin?from=${encodeURIComponent(workspaceId)}`, label: ta("nav.admin"), icon: ShieldCheck }]
                : []),
            ],
          },
          {
            label: t("nav.workspace"),
            items: tabs.map((name) => ({ href: href(name), label: t(`nav.${name}`), icon: ICONS[name], active: tab === name })),
          },
        ]}
      />

      <div className="min-w-0 flex-1 px-4 py-8 sm:px-8 md:py-12">
        <div className="mx-auto max-w-3xl">
          {accountTab && <AccountTabContent tab={accountTabForSettings(accountTab)} session={session} />}
          {tab === "general" && (
            <>
              <SettingsHeader title={t("nav.general")} description={t("workspace.description")} />
              <SettingsGroup title={t("workspace.heading")}>
                <WorkspaceNameForm workspaceId={workspaceId} name={workspace.name} canEdit={isOwner} />
                {/* Guests can't open the members list, where everyone else leaves from. */}
                {guest && <LeaveWorkspaceRow workspaceId={workspaceId} userId={user.id} />}
              </SettingsGroup>
              {!guest && <AiGroup workspaceId={workspaceId} userId={user.id} isOwner={isOwner} />}
              {/* Exporting everything is for owners, like the members list download. */}
              {isOwner && <ExportGroup workspaceId={workspaceId} userId={user.id} />}
            </>
          )}
          {tab === "members" && (
            <MembersTab
              workspaceId={workspaceId}
              userId={user.id}
              isOwner={isOwner}
              view={typeof query.view === "string" ? query.view : undefined}
            />
          )}
          {tab === "guests" && <GuestsTab workspaceId={workspaceId} userId={user.id} isOwner={isOwner} />}
          {tab === "teamspaces" && <TeamspacesTab workspaceId={workspaceId} userId={user.id} isOwner={isOwner} />}
          {tab === "groups" && <GroupsTab workspaceId={workspaceId} userId={user.id} isOwner={isOwner} />}
          {tab === "agents" && (
            <AgentsTab
              workspaceId={workspaceId}
              userId={user.id}
              isOwner={isOwner}
              agentId={typeof query.agent === "string" ? query.agent : undefined}
              runId={typeof query.run === "string" ? query.run : undefined}
            />
          )}
          {tab === "connections" && (
            <ConnectionsTab
              workspaceId={workspaceId}
              userId={user.id}
              connectionId={typeof query.connection === "string" ? query.connection : undefined}
              notice={query.signedIn === "1" ? "signedIn" : query.connectionError === "oauthFailed" ? "oauthFailed" : undefined}
            />
          )}
          {tab === "analytics" && <AnalyticsTab workspaceId={workspaceId} userId={user.id} days={query.days} />}
          {tab === "security" && <SecurityTab workspaceId={workspaceId} userId={user.id} isOwner={isOwner} />}
          {tab === "audit" && <AuditTab workspaceId={workspaceId} userId={user.id} query={query} />}
          {tab === "site" && (
            <SiteTab workspaceId={workspaceId} workspaceName={workspace.name} userId={user.id} isOwner={isOwner} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Settings > General > AI: the workspace's switch and the server's provider (see server/ai). */
async function AiGroup({ workspaceId, userId, isOwner }: { workspaceId: string; userId: string; isOwner: boolean }) {
  const [settings, t] = await Promise.all([getWorkspaceSettings(userId, workspaceId), getTranslations("ai.settings")]);
  return (
    <SettingsGroup title={t("heading")} description={t("description")} className="mt-10">
      <AiSettings workspaceId={workspaceId} enabled={settings.ai !== false} canEdit={isOwner} provider={aiInfo()} embeddings={embeddingModel()} />
    </SettingsGroup>
  );
}

/** Settings > General > Export, for owners: off while the workspace has export turned off. */
async function ExportGroup({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const [settings, t] = await Promise.all([getWorkspaceSettings(userId, workspaceId), getTranslations("settings")]);
  return (
    <SettingsGroup title={t("export.heading")} className="mt-10">
      <WorkspaceExport workspaceId={workspaceId} disabled={settings.export === false} />
    </SettingsGroup>
  );
}

async function SecurityTab({ workspaceId, userId, isOwner }: { workspaceId: string; userId: string; isOwner: boolean }) {
  const [settings, publications, forms, session, withoutTwoFactor, canUseSso, connection, scimTokens, scimManaged, t] =
    await Promise.all([
      getWorkspaceSettings(userId, workspaceId),
      isOwner ? listWorkspacePublications(userId, workspaceId) : null,
      isOwner ? listWorkspaceFormPublications(userId, workspaceId) : null,
      getSession(),
      isOwner ? countMembersWithoutTwoFactor(userId, workspaceId) : 0,
      ssoAvailable(workspaceId),
      isOwner ? getSsoConnection(userId, workspaceId) : null,
      isOwner ? listScimTokens(userId, workspaceId) : [],
      isOwner ? scimManagedCount(workspaceId) : 0,
      getTranslations("settings"),
    ]);
  const setup = ssoSetupInfo(workspaceId);
  return (
    <div className="space-y-10">
      <div>
        <SettingsHeader title={t("nav.security")} description={t("security.description")} />
        <SettingsGroup title={t("security.authenticationHeading")}>
          <RequireTwoFactorSetting
            workspaceId={workspaceId}
            settings={settings}
            canEdit={isOwner}
            ownSessionPasses={Boolean(session && isStrongSession(session))}
            withoutTwoFactor={withoutTwoFactor}
          />
          <LoginMethodSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} available={canUseSso} />
        </SettingsGroup>
      </div>
      <SettingsGroup title={t("security.membersHeading")}>
        <MembershipSettings workspaceId={workspaceId} settings={settings} canEdit={isOwner} mailEnabled={mailStatus() !== "disabled"} />
      </SettingsGroup>
      {isOwner && (
        <SettingsGroup title={t("security.sso.title")} description={t("security.sso.description")}>
          <SsoSetupDetails info={setup} />
          <SsoConnectionForm workspaceId={workspaceId} connection={connection} />
        </SettingsGroup>
      )}
      {isOwner && (
        <SettingsGroup title={t("security.scim.title")} description={t("security.scim.description")}>
          <ScimSettings
            workspaceId={workspaceId}
            baseUrl={setup.scimBaseUrl}
            managed={scimManaged}
            tokens={scimTokens.map((token) => ({
              id: token.id,
              name: token.name,
              prefix: token.prefix,
              createdAt: token.createdAt.toISOString(),
              lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
            }))}
          />
        </SettingsGroup>
      )}
      <SettingsGroup title={t("security.sharingHeading")}>
        <AccessRequestsSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
      </SettingsGroup>
      <div>
        <SettingsGroup title={t("security.guestsHeading")}>
          <GuestInviteSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
          <GuestPrivatePagesSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
        </SettingsGroup>
      </div>
      <SettingsGroup title={t("security.dataHeading")}>
        <ExportSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
        <ConnectedAppsSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
      </SettingsGroup>
      <SettingsGroup title={t("security.publishingHeading")}>
        <PublishingSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
      </SettingsGroup>
      {publications && (
        <SettingsGroup
          title={t("security.publications.title")}
          description={t(settings.publishing === "off" ? "security.publications.off" : "security.publications.description")}
        >
          <PublishedPages workspaceId={workspaceId} publications={publications} />
        </SettingsGroup>
      )}
      {forms && (
        <SettingsGroup
          title={t("security.forms.title")}
          description={t(settings.publishing === "off" ? "security.forms.off" : "security.forms.description")}
        >
          <PublicForms workspaceId={workspaceId} forms={forms} />
        </SettingsGroup>
      )}
      <SettingsGroup title={t("security.retentionHeading")}>
        <TrashRetentionSetting workspaceId={workspaceId} settings={settings} canEdit={isOwner} />
        <HistoryRetentionNote />
      </SettingsGroup>
    </div>
  );
}

async function SiteTab({
  workspaceId,
  workspaceName,
  userId,
  isOwner,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  isOwner: boolean;
}) {
  const [site, publications, t] = await Promise.all([
    getSite(userId, workspaceId),
    isOwner ? listWorkspacePublications(userId, workspaceId) : null,
    getTranslations("settings"),
  ]);
  return (
    <div className="space-y-10">
      <div>
        <SettingsHeader title={t("nav.site")} description={t("site.description")} />
        <SettingsGroup title={t("site.heading")}>
          <SiteSettings
            // A new form once the site is saved or taken down, starting from what is stored.
            key={site ? `${site.slug}:${site.homePageId}` : "none"}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            site={site}
            publications={publications}
            canEdit={isOwner}
          />
        </SettingsGroup>
      </div>
      {publications && (
        <SettingsGroup title={t("site.pagesHeading")} description={t("site.pagesDescription")}>
          <SitePages workspaceId={workspaceId} publications={publications} homePageId={site?.homePageId ?? null} />
        </SettingsGroup>
      )}
    </div>
  );
}

async function MembersTab({
  workspaceId,
  userId,
  isOwner,
  view,
}: {
  workspaceId: string;
  userId: string;
  isOwner: boolean;
  view: string | undefined;
}) {
  const [members, edits, invitations, joinLink, teamspaces, groups, requests, addMembers, settings] = await Promise.all([
    listMembers(userId, workspaceId),
    lastEdits(userId, workspaceId),
    isOwner ? listInvitations(userId, workspaceId) : [],
    isOwner ? getJoinLink(userId, workspaceId) : null,
    teamspacesByMember(userId, workspaceId),
    groupsByMember(userId, workspaceId),
    isOwner ? listJoinRequests(userId, workspaceId) : [],
    memberInviteAccess(userId, workspaceId),
    getWorkspaceSettings(userId, workspaceId),
  ]);
  return (
    <MembersPanel
      workspaceId={workspaceId}
      currentUserId={userId}
      isOwner={isOwner}
      initialTab={view === "requests" && isOwner ? "requests" : view === "invitations" && isOwner ? "invitations" : "members"}
      addMembers={addMembers}
      members={members.map((m) => ({ ...m, lastEditedAt: edits.get(m.userId) ?? null }))}
      invitations={invitations}
      requests={requests}
      joinLink={joinLink}
      joinLinkAsks={settings.joinRequests === "anyone_with_link"}
      // A plain object: a Map doesn't cross to the client component.
      teamspaces={Object.fromEntries(teamspaces)}
      groups={Object.fromEntries(groups)}
      now={new Date()}
    />
  );
}

async function GuestsTab({ workspaceId, userId, isOwner }: { workspaceId: string; userId: string; isOwner: boolean }) {
  const guests = await listGuests(userId, workspaceId);
  return <GuestsPanel workspaceId={workspaceId} isOwner={isOwner} guests={guests} now={new Date()} />;
}

async function GroupsTab({ workspaceId, userId, isOwner }: { workspaceId: string; userId: string; isOwner: boolean }) {
  const [groups, members] = await Promise.all([listGroups(userId, workspaceId), listMembers(userId, workspaceId)]);
  return (
    <GroupsPanel
      workspaceId={workspaceId}
      isOwner={isOwner}
      groups={groups}
      members={members.map(({ userId: id, name, email, image, role }) => ({ userId: id, name, email, image, role }))}
    />
  );
}

/**
 * Settings > Agents: owners create and change agents, choose what they may open and read their
 * runs; members see the list (they pick agents in automations). `agent` (and `run`) open one.
 */
async function AgentsTab({
  workspaceId,
  userId,
  isOwner,
  agentId,
  runId,
}: {
  workspaceId: string;
  userId: string;
  isOwner: boolean;
  agentId?: string;
  runId?: string;
}) {
  const [agents, settings, templates] = await Promise.all([
    listAgents(userId, workspaceId, { archived: isOwner }),
    getWorkspaceSettings(userId, workspaceId),
    isOwner ? getLocale().then(builtinAgents) : [],
  ]);
  const ai = !aiInfo() ? "unavailable" : settings.ai === false ? "off" : "on";
  return (
    <AgentsPanel
      workspaceId={workspaceId}
      isOwner={isOwner}
      agents={agents}
      templates={templates}
      ai={ai}
      initialAgentId={isOwner ? agentId : undefined}
      initialRunId={isOwner ? runId : undefined}
    />
  );
}

/**
 * Settings > Connections, for owners (the tab isn't offered to anyone else, and the list refuses
 * them). `connection` opens one; `notice` says how a sign-in the browser came back from went.
 */
async function ConnectionsTab({
  workspaceId,
  userId,
  connectionId,
  notice,
}: {
  workspaceId: string;
  userId: string;
  connectionId?: string;
  notice?: "signedIn" | "oauthFailed";
}) {
  const [connections, agents] = await Promise.all([listConnections(userId, workspaceId), listAgents(userId, workspaceId)]);
  return (
    <ConnectionsPanel
      workspaceId={workspaceId}
      connections={connections}
      agents={agents.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, icon: a.icon }))}
      initialConnectionId={connectionId}
      notice={notice}
    />
  );
}

/** Settings > Analytics, for owners (the tab isn't offered to anyone else, and the report refuses them). */
async function AnalyticsTab({ workspaceId, userId, days }: { workspaceId: string; userId: string; days: unknown }) {
  const now = new Date();
  const report = await workspaceAnalytics(userId, workspaceId, parseAnalyticsPeriod(days), now);
  return <AnalyticsPanel workspaceId={workspaceId} report={report} now={now} />;
}

/** Settings > Audit log, for owners (the tab isn't offered to anyone else, and the list refuses them). */
async function AuditTab({
  workspaceId,
  userId,
  query,
}: {
  workspaceId: string;
  userId: string;
  query: Record<string, string | string[] | undefined>;
}) {
  const filters = parseAuditFilters(query);
  // The date range is in days of the viewer's clock (the time zone cookie, UTC without one).
  const timeZone = await getTimeZone();
  const [{ events, hasMore }, actors] = await Promise.all([
    listAuditEvents(userId, workspaceId, filters, { timeZone }),
    auditActors(userId, workspaceId),
  ]);
  return <AuditPanel workspaceId={workspaceId} events={events} hasMore={hasMore} filters={filters} actors={actors} />;
}

async function TeamspacesTab({ workspaceId, userId, isOwner }: { workspaceId: string; userId: string; isOwner: boolean }) {
  const [teamspaces, canCreate, settings, members] = await Promise.all([
    listTeamspaces(userId, workspaceId, { archived: "all" }),
    canCreateTeamspace(userId, workspaceId),
    getWorkspaceSettings(userId, workspaceId),
    listMembers(userId, workspaceId),
  ]);
  return (
    <TeamspacesPanel
      workspaceId={workspaceId}
      currentUserId={userId}
      isOwner={isOwner}
      teamspaces={teamspaces}
      canCreate={canCreate}
      teamspaceCreation={settings.teamspaceCreation}
      members={members.map(({ userId: id, name, email, role }) => ({ userId: id, name, email, role }))}
    />
  );
}
