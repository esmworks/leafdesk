import type { AccountSettingsTab, SettingsTab } from "./settings-tabs";
import { searchFold } from "./search-fold";

/**
 * What Settings' search box and the command list (Cmd/Ctrl+K, then ">") find: each setting, the
 * tab it is on and the text that names it. `label` is an existing key ("<namespace>:<key>"), the
 * heading the setting already shows; `keywords` names a `settings.search.keywords.<id>` text of
 * other words people look for it by. An entry without `label` is a whole tab, named as the
 * navigation names it. `when` mirrors the condition the settings page shows it under; the tab
 * itself must be among the person's tabs too (server/settings-search.ts). The page marks each
 * setting with `id="setting-<id>"` (SettingsGroup and SettingsRow take `anchor`), where a jump
 * scrolls to and highlights it.
 */
export type SettingsSearchEntry = {
  id: string;
  tab: SettingsTab | AccountSettingsTab;
  label?: string;
  keywords?: boolean;
  when?: (context: SettingsSearchContext) => boolean;
};

/** What decides, beyond the tab, whether someone sees a setting. */
export type SettingsSearchContext = {
  owner: boolean;
  guest: boolean;
  /** Leafdesk on one computer (lib/env.ts localMode). */
  local: boolean;
  /** People bring their own AI keys (env ownAiKeysEnabled). */
  ownAiKeys: boolean;
  /** The server has a Telegram bot. */
  telegram: boolean;
};

const member = ({ guest }: SettingsSearchContext) => !guest;
const owner = ({ owner }: SettingsSearchContext) => owner;
const online = ({ local }: SettingsSearchContext) => !local;
const ownerOnline = ({ owner, local }: SettingsSearchContext) => owner && !local;

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // The person's account.
  { id: "profile", tab: "profile", label: "account:profile.heading", keywords: true },
  { id: "email", tab: "profile", label: "account:email.heading", keywords: true, when: online },
  { id: "deleteAccount", tab: "profile", label: "account:delete.heading", keywords: true },
  { id: "password", tab: "accountSecurity", label: "account:password.heading", keywords: true },
  { id: "twoFactor", tab: "accountSecurity", label: "security:twoFactor.heading", keywords: true },
  { id: "passkeys", tab: "accountSecurity", label: "security:passkeys.heading", keywords: true },
  { id: "sessions", tab: "accountSecurity", label: "account:sessions.heading", keywords: true },
  { id: "language", tab: "preferences", label: "settings:language.heading", keywords: true },
  { id: "theme", tab: "preferences", label: "settings:theme.heading", keywords: true },
  { id: "contrast", tab: "preferences", label: "settings:theme.contrast.label", keywords: true },
  { id: "openOnStart", tab: "preferences", label: "settings:openOnStart.heading", keywords: true },
  { id: "desktopLinks", tab: "preferences", label: "settings:desktopLinks.heading", keywords: true, when: online },
  { id: "notifications", tab: "preferences", label: "settings:notifications.heading", keywords: true },
  { id: "watchedPages", tab: "preferences", label: "settings:notifications.watchedHeading", keywords: true },
  { id: "dashboardEmails", tab: "preferences", label: "settings:notifications.dashboardEmailsHeading", keywords: true, when: online },
  { id: "offlineDevice", tab: "offline", label: "offline:settings.deviceHeading", keywords: true },
  { id: "offlinePages", tab: "offline", label: "offline:settings.pagesHeading", keywords: true },
  { id: "mailboxes", tab: "mail", label: "account:mail.mailboxHeading", keywords: true },
  { id: "calendars", tab: "mail", label: "account:mail.calendarsHeading", keywords: true },
  { id: "storageAccounts", tab: "apps", label: "settings:storage.accounts.heading", keywords: true },
  { id: "connectedApps", tab: "apps", label: "settings:connectedApps.listHeading", keywords: true },
  { id: "aiAccounts", tab: "apps", label: "ai:accounts.heading", keywords: true, when: ({ ownAiKeys }) => ownAiKeys },
  { id: "telegram", tab: "apps", label: "account:telegram.title", keywords: true, when: ({ telegram }) => telegram },
  { id: "mcp", tab: "apps", label: "settings:mcp.heading", keywords: true },
  { id: "apiTokens", tab: "apps", label: "apiTokens:heading", keywords: true },
  { id: "about", tab: "about", keywords: true },

  // The workspace.
  { id: "workspaceName", tab: "general", label: "settings:workspace.heading", keywords: true },
  { id: "calloutStyles", tab: "general", label: "settings:calloutStyles.heading", when: member },
  { id: "ai", tab: "general", label: "ai:settings.heading", keywords: true, when: member },
  { id: "workspaceMail", tab: "general", label: "settings:email.heading", keywords: true, when: member },
  { id: "ownPageViews", tab: "general", label: "settings:pageViews.title", keywords: true, when: member },
  { id: "export", tab: "general", label: "settings:export.heading", keywords: true, when: owner },
  { id: "deleteWorkspace", tab: "general", label: "settings:deleteWorkspace.heading", when: owner },
  { id: "members", tab: "members", keywords: true },
  { id: "guests", tab: "guests" },
  { id: "teamspaces", tab: "teamspaces" },
  { id: "groups", tab: "groups" },
  { id: "agents", tab: "agents", keywords: true },
  { id: "agentTemplates", tab: "agents", label: "settings:agents.templates.heading" },
  { id: "snippets", tab: "snippets", keywords: true },
  { id: "letterheads", tab: "pdf", label: "settings:letterheads.heading", keywords: true },
  { id: "connections", tab: "connections", keywords: true },
  { id: "webhooks", tab: "webhooks", keywords: true },
  { id: "site", tab: "site", label: "settings:site.heading", keywords: true },
  { id: "sitePages", tab: "site", label: "settings:site.pagesHeading", when: owner },
  { id: "siteTheme", tab: "site", label: "settings:site.themeLabel", when: owner },
  { id: "siteHeader", tab: "site", label: "settings:site.linksLabel", keywords: true, when: owner },
  { id: "siteDescription", tab: "site", label: "settings:site.descriptionLabel", keywords: true, when: owner },
  { id: "siteAnalytics", tab: "site", label: "settings:site.analyticsLabel", keywords: true, when: owner },
  { id: "siteDomain", tab: "site", label: "settings:site.domainLabel", keywords: true, when: owner },

  { id: "authentication", tab: "security", label: "settings:security.authenticationHeading" },
  { id: "requireTwoFactor", tab: "security", label: "settings:security.requireTwoFactor.title", keywords: true },
  { id: "loginMethod", tab: "security", label: "settings:security.loginMethod.title", keywords: true, when: online },
  { id: "allowedNetworks", tab: "security", label: "settings:security.allowedNetworks.title", keywords: true, when: online },
  { id: "membership", tab: "security", label: "settings:security.membersHeading", keywords: true, when: online },
  { id: "sso", tab: "security", label: "settings:security.sso.title", keywords: true, when: ownerOnline },
  { id: "scim", tab: "security", label: "settings:security.scim.title", keywords: true, when: ownerOnline },
  // Listed only while the workspace has verified domains, which the search doesn't know: it then opens the tab.
  { id: "domainPeople", tab: "security", label: "settings:domainPeople.title", keywords: true, when: ownerOnline },
  { id: "accessRequests", tab: "security", label: "settings:security.accessRequests.title", when: online },
  { id: "guestPolicies", tab: "security", label: "settings:security.guestsHeading", when: online },
  { id: "exportPolicy", tab: "security", label: "settings:security.export.title", keywords: true },
  { id: "connectedAppsPolicy", tab: "security", label: "settings:security.connectedApps.title", keywords: true },
  { id: "onlyApprovedApps", tab: "security", label: "settings:security.onlyApprovedApps.title", keywords: true },
  { id: "sensitiveContent", tab: "security", label: "settings:sensitiveContent.title", keywords: true, when: owner },
  { id: "sensitiveFindings", tab: "security", label: "settings:sensitiveContent.findingsTitle", keywords: true, when: owner },
  { id: "workspaceApps", tab: "security", label: "settings:security.workspaceApps.title", when: owner },
  { id: "publishing", tab: "security", label: "settings:security.publishingHeading", keywords: true, when: online },
  { id: "publications", tab: "security", label: "settings:security.publications.title", when: ownerOnline },
  { id: "pageReports", tab: "security", label: "settings:security.pageReports.title", keywords: true, when: ownerOnline },
  { id: "forms", tab: "security", label: "settings:security.forms.title", when: ownerOnline },
  { id: "retention", tab: "security", label: "settings:security.retentionHeading", keywords: true },
  { id: "legalHolds", tab: "security", label: "settings:legalHolds.title", keywords: true, when: owner },

  { id: "storage", tab: "storage", keywords: true },
  { id: "pageViews", tab: "analytics", label: "settings:analytics.recording.title", keywords: true },
  { id: "analyticsPeople", tab: "analytics", label: "settings:analytics.peopleHeading", keywords: true },
  { id: "analyticsPages", tab: "analytics", label: "settings:analytics.pagesHeading" },
  { id: "aiUsageLimit", tab: "aiUsage", label: "settings:aiUsage.limitHeading", keywords: true },
  { id: "aiUsageMonths", tab: "aiUsage", label: "settings:aiUsage.monthsHeading" },
  { id: "aiUsagePeople", tab: "aiUsage", label: "settings:search.labels.aiUsagePeople", keywords: true },
  { id: "health", tab: "health", keywords: true },
  { id: "audit", tab: "audit", keywords: true },
  { id: "eventStream", tab: "audit", label: "settings:eventStream.title", keywords: true, when: owner },
];

/** The DOM id a setting's group or row carries, which a jump scrolls to. */
export const settingAnchor = (id: string) => `setting-${id}`;

/** One found setting, its texts already in the person's language. */
export type SettingsSearchItem = {
  id: string;
  href: string;
  /** The tab's name. */
  tab: string;
  /** The setting's name; the tab's for a whole tab. */
  label: string;
  /** Other words it is found by. */
  keywords: string;
};

/** The settings whose names, tab or other words hold every word of `query`, best first. */
export function matchSettings(items: readonly SettingsSearchItem[], query: string, limit = 8): SettingsSearchItem[] {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { item: SettingsSearchItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = searchFold(item.label);
    const tab = searchFold(item.tab);
    const all = `${label} ${tab} ${searchFold(item.keywords)}`;
    if (!words.every((word) => all.includes(word))) return;
    // A name that starts with what was typed first, then one that holds it, then the rest.
    const score = label.startsWith(words[0]) ? 0 : words.every((word) => label.includes(word)) ? 1 : tab.includes(words[0]) ? 2 : 3;
    scored.push({ item, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}
