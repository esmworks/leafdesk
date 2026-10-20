/** The workspace settings tabs; the navigation shows them in SETTINGS_TAB_GROUPS. */
export const SETTINGS_TABS = [
  "general",
  "members",
  "guests",
  "teamspaces",
  "groups",
  "agents",
  "snippets",
  "connections",
  "storage",
  "analytics",
  "aiUsage",
  "health",
  "security",
  "audit",
  "site",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);

/**
 * The navigation's three groups of workspace tabs, in its order: the workspace and its people,
 * what it does, and how it is run.
 */
export const SETTINGS_TAB_GROUPS = [
  { label: "workspace", tabs: ["general", "members", "guests", "teamspaces", "groups"] },
  { label: "features", tabs: ["agents", "snippets", "connections", "site"] },
  { label: "admin", tabs: ["security", "storage", "analytics", "aiUsage", "health", "audit"] },
] as const satisfies readonly { label: string; tabs: readonly SettingsTab[] }[];

/** Tabs only the workspace's owners get. */
const OWNER_TABS: readonly SettingsTab[] = ["connections", "storage", "analytics", "aiUsage", "audit"];

/**
 * The tabs someone gets. Guests don't see the workspace's members or policies: only its name, and
 * leaving it. The guests themselves are for those who may bring guests in (`canInviteGuests`:
 * owners, and members when Settings > Security lets them). Analytics, which counts what each
 * person did, the audit log, which says who changed what, and connections to outside services
 * (their credentials are the workspace's), where the workspace's files are stored and what its AI
 * costs are for owners. Email on rows has no tab: it is under General, and each member connects
 * their own mailbox under their account (Account > Email and calendar). Agents are listed to
 * members too (they pick them in automations); only owners change them. The health check covers
 * the pages each person can open, so owners and members get it alike.
 */
export function visibleSettingsTabs({
  guest,
  managesGuests,
  owner = false,
  localMode = false,
}: {
  guest: boolean;
  managesGuests: boolean;
  owner?: boolean;
  /** Leafdesk on one computer (lib/env.ts localMode): no guests, no groups of one, and no site to publish. */
  localMode?: boolean;
}): SettingsTab[] {
  if (guest) return ["general"];
  return SETTINGS_TABS.filter(
    (tab) =>
      (tab !== "guests" || managesGuests) &&
      (!OWNER_TABS.includes(tab) || owner) &&
      !(localMode && LOCAL_MODE_HIDDEN_TABS.includes(tab)),
  );
}

/** Tabs that need other people or a public address, hidden when Leafdesk runs on one computer. */
const LOCAL_MODE_HIDDEN_TABS: readonly SettingsTab[] = ["guests", "groups", "site"];

/**
 * The person's own settings (see components/account/account-tabs) under a workspace's Settings,
 * named so they don't clash with the workspace tabs: the account's "security" is "accountSecurity",
 * its "snippets" (the person's own) "mySnippets".
 */
export const ACCOUNT_SETTINGS_TABS = ["profile", "accountSecurity", "preferences", "mail", "mySnippets", "apps", "about"] as const;
export type AccountSettingsTab = (typeof ACCOUNT_SETTINGS_TABS)[number];

export function accountTabForSettings(tab: AccountSettingsTab) {
  return tab === "accountSecurity" ? "security" : tab === "mySnippets" ? "snippets" : tab;
}

export function settingsTabForAccount(tab: "profile" | "security" | "preferences" | "mail" | "snippets" | "apps" | "about"): AccountSettingsTab {
  return tab === "security" ? "accountSecurity" : tab === "snippets" ? "mySnippets" : tab;
}
