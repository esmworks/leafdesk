/** The workspace settings tabs, in the order the settings navigation shows them. */
export const SETTINGS_TABS = [
  "general",
  "members",
  "guests",
  "teamspaces",
  "groups",
  "agents",
  "connections",
  "email",
  "storage",
  "analytics",
  "health",
  "security",
  "audit",
  "site",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);

/** Tabs only the workspace's owners get. */
const OWNER_TABS: readonly SettingsTab[] = ["connections", "storage", "analytics", "audit"];

/**
 * The tabs someone gets. Guests don't see the workspace's members or policies: only its name, and
 * leaving it. The guests themselves are for those who may bring guests in (`canInviteGuests`:
 * owners, and members when Settings > Security lets them). Analytics, which counts what each
 * person did, the audit log, which says who changed what, and connections to outside services
 * (their credentials are the workspace's) and where the workspace's files are stored are for owners. Email is for everyone but guests: owners
 * choose where mail lands, each member connects their own mailbox. Agents are listed to
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
 * named so they don't clash with the workspace tabs: the account's "security" is "accountSecurity".
 */
export const ACCOUNT_SETTINGS_TABS = ["profile", "accountSecurity", "preferences", "apps", "about"] as const;
export type AccountSettingsTab = (typeof ACCOUNT_SETTINGS_TABS)[number];

export function accountTabForSettings(tab: AccountSettingsTab) {
  return tab === "accountSecurity" ? "security" : tab;
}

export function settingsTabForAccount(tab: "profile" | "security" | "preferences" | "apps" | "about"): AccountSettingsTab {
  return tab === "security" ? "accountSecurity" : tab;
}
