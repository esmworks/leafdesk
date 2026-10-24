import { describe, expect, it } from "vitest";
import {
  analyticsCsvRows,
  type AnalyticsReport,
  DEFAULT_ANALYTICS_PERIOD,
  isAnalyticsTable,
  parseAnalyticsPeriod,
  periodStart,
} from "./analytics";
import { visibleSettingsTabs } from "./settings-tabs";

const at = new Date("2026-09-20T12:00:00Z");

const report: AnalyticsReport = {
  days: 30,
  since: new Date("2026-08-29T12:00:00Z"),
  recording: true,
  views: {
    total: 12,
    viewers: 2,
    pagesViewed: 2,
    people: [
      { userId: "a", name: "Ayşe", email: "ayse@example.test", image: null, role: "owner", views: 9, pages: 2, lastViewAt: at },
      { userId: "b", name: "=cmd()", email: "b@example.test", image: null, role: "member", views: 0, pages: 0, lastViewAt: null },
    ],
    pages: [
      { id: "p1", title: "Roadmap", icon: null, kind: "page", views: 10, viewers: 2, lastViewAt: at },
      { id: null, title: null, icon: null, kind: null, views: 2, viewers: 1, lastViewAt: at },
    ],
  },
  totalEdits: 7,
  pagesEdited: 2,
  activeMembers: 1,
  memberCount: 2,
  people: [
    { userId: "a", name: "Ayşe", email: "ayse@example.test", image: null, role: "owner", edits: 7, pages: 2, lastEditAt: at },
    { userId: "b", name: "=cmd()", email: "b@example.test", image: null, role: "member", edits: 0, pages: 0, lastEditAt: null },
  ],
  pages: [
    { id: "p1", title: "Roadmap", icon: null, kind: "page", edits: 5, editors: 1, lastEditAt: at },
    { id: null, title: null, icon: null, kind: null, edits: 2, editors: 1, lastEditAt: at },
  ],
};

describe("parseAnalyticsPeriod", () => {
  it("accepts the offered periods, as numbers or query strings", () => {
    expect(parseAnalyticsPeriod("7")).toBe(7);
    expect(parseAnalyticsPeriod(90)).toBe(90);
  });

  it("falls back to the default for anything else", () => {
    for (const value of ["14", "", "30days", undefined, null, ["7"], 365, -7]) {
      expect(parseAnalyticsPeriod(value)).toBe(DEFAULT_ANALYTICS_PERIOD);
    }
  });
});

describe("periodStart", () => {
  it("goes back whole days from now", () => {
    expect(periodStart(at, 7).toISOString()).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("analyticsCsvRows", () => {
  it("lists every person with their counts", () => {
    expect(analyticsCsvRows(report, "members")).toEqual([
      ["name", "email", "role", "edits", "pages_edited", "last_edited_at"],
      ["Ayşe", "ayse@example.test", "owner", 7, 2, at],
      ["=cmd()", "b@example.test", "member", 0, 0, null],
    ]);
  });

  it("keeps pages the owner can't open counted but untitled", () => {
    expect(analyticsCsvRows(report, "pages")).toEqual([
      ["title", "private", "edits", "editors", "last_edited_at"],
      ["Roadmap", "no", 5, 1, at],
      [null, "yes", 2, 1, at],
    ]);
  });

  it("lists every member's views, and the most viewed pages untitled where the owner can't open them", () => {
    expect(analyticsCsvRows(report, "viewers")).toEqual([
      ["name", "email", "role", "views", "pages_viewed", "last_viewed_at"],
      ["Ayşe", "ayse@example.test", "owner", 9, 2, at],
      ["=cmd()", "b@example.test", "member", 0, 0, null],
    ]);
    expect(analyticsCsvRows(report, "viewed")).toEqual([
      ["title", "private", "views", "viewers", "last_viewed_at"],
      ["Roadmap", "no", 10, 2, at],
      [null, "yes", 2, 1, at],
    ]);
  });

  it("gives only the headers of the views tables while views aren't recorded", () => {
    const off = { ...report, recording: false, views: null };
    expect(analyticsCsvRows(off, "viewers")).toEqual([["name", "email", "role", "views", "pages_viewed", "last_viewed_at"]]);
    expect(analyticsCsvRows(off, "viewed")).toEqual([["title", "private", "views", "viewers", "last_viewed_at"]]);
  });

  it("knows its tables", () => {
    expect(isAnalyticsTable("members")).toBe(true);
    expect(isAnalyticsTable("pages")).toBe(true);
    expect(isAnalyticsTable("viewers")).toBe(true);
    expect(isAnalyticsTable("viewed")).toBe(true);
    expect(isAnalyticsTable("people")).toBe(false);
  });
});

describe("visibleSettingsTabs: analytics", () => {
  it("is for owners only", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: true, owner: true })).toContain("analytics");
    expect(visibleSettingsTabs({ guest: false, managesGuests: true })).not.toContain("analytics");
    expect(visibleSettingsTabs({ guest: true, managesGuests: false, owner: true })).toEqual(["general", "snippets"]);
  });
});
