import { getTranslations } from "next-intl/server";
import type { WorkspaceRole } from "@/db/schema";
import { env } from "@/lib/env";
import { SETTINGS_SEARCH_ENTRIES, type SettingsSearchContext, type SettingsSearchItem } from "@/lib/settings-search";
import { ACCOUNT_SETTINGS_TABS, accountTabForSettings, type SettingsTab, visibleSettingsTabs } from "@/lib/settings-tabs";
import { isGuest } from "./access";
import { isEnabled as aiMayBeOn } from "./ai";
import { hasOwnStorage } from "./storage/workspace";
import { canInviteGuests, getWorkspace } from "./workspaces";

/**
 * The workspace settings tabs someone gets: visibleSettingsTabs, with Storage only where storage of
 * one's own is on (or the workspace has some from before) and AI usage only where AI may run. The
 * settings page and its search both ask here, so the search never finds a tab the page won't open.
 */
export async function settingsTabsFor(userId: string, workspaceId: string, role: WorkspaceRole): Promise<SettingsTab[]> {
  const owner = role === "owner";
  const guest = isGuest(role);
  const [managesGuests, ownStorage] = await Promise.all([
    guest ? false : canInviteGuests(userId, workspaceId),
    owner && !env.ownStorageEnabled ? hasOwnStorage(workspaceId) : true,
  ]);
  return visibleSettingsTabs({ guest, managesGuests, owner, localMode: env.localMode }).filter(
    (name) => (name !== "storage" || env.ownStorageEnabled || !owner || ownStorage) && (name !== "aiUsage" || aiMayBeOn()),
  );
}

/**
 * Every setting this person can see in this workspace's Settings, named in their language, with
 * the link that opens it (lib/settings-search.ts). Throws AccessError when they aren't in it.
 */
export async function settingsSearchIndex(userId: string, workspaceId: string): Promise<SettingsSearchItem[]> {
  const workspace = await getWorkspace(userId, workspaceId);
  const [tabs, t] = await Promise.all([settingsTabsFor(userId, workspaceId, workspace.role), getTranslations()]);
  const context: SettingsSearchContext = {
    owner: workspace.role === "owner",
    guest: isGuest(workspace.role),
    local: env.localMode,
    ownAiKeys: env.ownAiKeysEnabled,
    telegram: Boolean(env.telegramBotToken),
  };
  const shown = new Set<string>([...ACCOUNT_SETTINGS_TABS, ...tabs]);
  // Keys come from the entries, checked against the English texts by settings-search.test.ts.
  const text = (key: string) => (t as unknown as (key: string) => string)(key.replace(":", "."));
  const tabName = (tab: string) =>
    (ACCOUNT_SETTINGS_TABS as readonly string[]).includes(tab)
      ? text(`account:nav.${accountTabForSettings(tab as (typeof ACCOUNT_SETTINGS_TABS)[number])}`)
      : text(`settings:nav.${tab}`);
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => shown.has(entry.tab) && (entry.when?.(context) ?? true)).map((entry) => ({
    id: entry.id,
    href: `/w/${workspaceId}/settings?tab=${entry.tab}${entry.label ? `&setting=${entry.id}` : ""}`,
    tab: tabName(entry.tab),
    label: entry.label ? text(entry.label) : tabName(entry.tab),
    keywords: entry.keywords ? text(`settings:search.keywords.${entry.id}`) : "",
  }));
}
