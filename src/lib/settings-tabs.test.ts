import { describe, expect, it } from "vitest";
import { ACCOUNT_SETTINGS_TABS, SETTINGS_TAB_GROUPS, SETTINGS_TABS, settingsTabForAccount, visibleSettingsTabs } from "./settings-tabs";

describe("settings tabs", () => {
  it("puts every workspace tab in exactly one navigation group", () => {
    const grouped = SETTINGS_TAB_GROUPS.flatMap((group) => [...group.tabs]);
    expect([...grouped].sort()).toEqual([...SETTINGS_TABS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("offers page webhooks to owners only", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: false, owner: true })).toContain("webhooks");
    expect(visibleSettingsTabs({ guest: false, managesGuests: true, owner: false })).not.toContain("webhooks");
    expect(visibleSettingsTabs({ guest: true, managesGuests: false })).not.toContain("webhooks");
  });

  it("keeps the person's own tabs apart from the workspace's", () => {
    for (const tab of ACCOUNT_SETTINGS_TABS) expect(SETTINGS_TABS as readonly string[]).not.toContain(tab);
  });

  it("keeps email on rows under General: the mailbox is the person's own, under their account", () => {
    expect(SETTINGS_TABS as readonly string[]).not.toContain("email");
    expect(visibleSettingsTabs({ guest: false, managesGuests: false, owner: true })).toContain("general");
    expect(ACCOUNT_SETTINGS_TABS).toContain("mail");
  });

  it("keeps the person's own snippets on the Snippets tab, beside the workspace's", () => {
    expect(ACCOUNT_SETTINGS_TABS as readonly string[]).not.toContain("mySnippets");
    expect(settingsTabForAccount("snippets")).toBe("snippets");
    expect(visibleSettingsTabs({ guest: true, managesGuests: false })).toContain("snippets");
  });
});
