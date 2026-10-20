import { describe, expect, it } from "vitest";
import { ACCOUNT_SETTINGS_TABS, SETTINGS_TAB_GROUPS, SETTINGS_TABS, visibleSettingsTabs } from "./settings-tabs";

describe("settings tabs", () => {
  it("puts every workspace tab in exactly one navigation group", () => {
    const grouped = SETTINGS_TAB_GROUPS.flatMap((group) => [...group.tabs]);
    expect([...grouped].sort()).toEqual([...SETTINGS_TABS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("keeps the person's own tabs apart from the workspace's", () => {
    for (const tab of ACCOUNT_SETTINGS_TABS) expect(SETTINGS_TABS as readonly string[]).not.toContain(tab);
  });

  it("gives email to owners only: members connect their mailbox under their account", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: false, owner: true })).toContain("email");
    expect(visibleSettingsTabs({ guest: false, managesGuests: false, owner: false })).not.toContain("email");
    expect(ACCOUNT_SETTINGS_TABS).toContain("mail");
  });
});
