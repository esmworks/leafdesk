/** The workspace settings tabs, in the order the settings navigation shows them. */
export const SETTINGS_TABS = ["general", "members", "guests", "teamspaces", "groups", "agents", "analytics", "security", "audit", "site"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);

/** Tabs only the workspace's owners get. */
const OWNER_TABS: readonly SettingsTab[] = ["analytics", "audit"];

/**
 * The tabs someone gets. Guests don't see the workspace's members or policies: only its name, and
 * leaving it. The guests themselves are for those who may bring guests in (`canInviteGuests`:
 * owners, and members when Settings > Security lets them). Analytics, which counts what each
 * person did, and the audit log, which says who changed what, are for owners. Agents are listed to
 * members too (they pick them in automations); only owners change them.
 */
export function visibleSettingsTabs({
  guest,
  managesGuests,
  owner = false,
}: {
  guest: boolean;
  managesGuests: boolean;
  owner?: boolean;
}): SettingsTab[] {
  if (guest) return ["general"];
  return SETTINGS_TABS.filter((tab) => (tab !== "guests" || managesGuests) && (!OWNER_TABS.includes(tab) || owner));
}

/**
 * The person's own settings (see components/account/account-tabs) under a workspace's Settings,
 * named so they don't clash with the workspace tabs: the account's "security" is "accountSecurity".
 */
export const ACCOUNT_SETTINGS_TABS = ["profile", "accountSecurity", "preferences", "apps"] as const;
export type AccountSettingsTab = (typeof ACCOUNT_SETTINGS_TABS)[number];

export function accountTabForSettings(tab: AccountSettingsTab) {
  return tab === "accountSecurity" ? "security" : tab;
}

export function settingsTabForAccount(tab: "profile" | "security" | "preferences" | "apps"): AccountSettingsTab {
  return tab === "security" ? "accountSecurity" : tab;
}
