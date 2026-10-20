import { describe, expect, it } from "vitest";
import type { Guest, GuestPage } from "@/server/guests";
import { GUESTS_CSV_HEADER, guestsCsvRows } from "./guests-csv";
import { visibleSettingsTabs } from "./settings-tabs";

const at = new Date("2026-09-01T10:00:00Z");
const pageOf = (pageId: string, extra: Partial<GuestPage> = {}): GuestPage => ({
  pageId,
  title: pageId,
  icon: null,
  kind: "page",
  level: "view",
  by: { id: "o", name: "Olivia" },
  at,
  inTrash: false,
  canManage: true,
  ...extra,
});
const guestOf = (extra: Partial<Guest>): Guest => ({
  userId: "g",
  name: "Gina",
  email: "gina@example.test",
  image: null,
  addedAt: at,
  invitedBy: { id: "o", name: "Olivia" },
  expiresAt: null,
  invitationId: null,
  pages: [],
  hiddenPages: 0,
  invitations: [],
  hiddenInvitations: 0,
  ...extra,
});
const url = (id: string) => `https://app.test/p/${id}`;

describe("guestsCsvRows", () => {
  it("writes a row per page given or waiting, with who shared it", () => {
    const rows = guestsCsvRows(
      [
        guestOf({
          pages: [pageOf("A", { level: "edit" }), pageOf("B", { inTrash: true, by: null })],
          invitations: [pageOf("C", { level: "comment" })],
          hiddenPages: 2,
        }),
      ],
      url,
    );
    expect(rows[0]).toEqual([...GUESTS_CSV_HEADER]);
    expect(rows.slice(1)).toEqual([
      ["Gina", "gina@example.test", "joined", at, "Olivia", 2, "A", url("A"), "entry", "edit", "Olivia", at, "no"],
      ["Gina", "gina@example.test", "joined", at, "Olivia", 2, "B", url("B"), "entry", "view", null, at, "yes"],
      ["Gina", "gina@example.test", "joined", at, "Olivia", 2, "C", url("C"), "invitation", "comment", "Olivia", at, "no"],
    ]);
  });

  it("keeps guests with nothing shared, and people who haven't joined", () => {
    const rows = guestsCsvRows(
      [guestOf({}), guestOf({ userId: null, name: "", email: "new@example.test", invitedBy: null, hiddenInvitations: 1 })],
      url,
    );
    expect(rows.slice(1)).toEqual([
      ["Gina", "gina@example.test", "joined", at, "Olivia", 0, null, null, null, null, null, null, null],
      ["", "new@example.test", "invited", at, null, 1, null, null, null, null, null, null, null],
    ]);
  });
});

describe("visibleSettingsTabs", () => {
  it("shows guests only the general tab and their own snippets", () => {
    expect(visibleSettingsTabs({ guest: true, managesGuests: true })).toEqual(["general", "snippets"]);
  });

  it("shows the guests tab to those who may bring guests in", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: true })).toContain("guests");
    expect(visibleSettingsTabs({ guest: false, managesGuests: false })).not.toContain("guests");
    expect(visibleSettingsTabs({ guest: false, managesGuests: false })).toContain("members");
  });
});
