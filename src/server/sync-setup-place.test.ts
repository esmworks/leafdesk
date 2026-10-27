import { describe, expect, it, vi } from "vitest";

// Setting up a calendar, PostgreSQL, GitHub or Google Sheets sync checks that the person may make the database
// where they asked before the server reaches out to anything.

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({ AccessError: class AccessError extends Error {} }));
vi.mock("@/server/databases", () => ({ addProperty: vi.fn(), addView: vi.fn(), requireDatabase: vi.fn(), updateView: vi.fn() }));
vi.mock("@/server/import/csv", () => ({ discardDatabase: vi.fn(), recordImport: vi.fn() }));
vi.mock("@/server/jira-sync/run", () => ({ claimSync: vi.fn(), runAndRecord: vi.fn() }));
vi.mock("@/server/secret-box", () => ({ openJson: vi.fn(), sealJson: vi.fn() }));
vi.mock("@/server/pages", () => ({ createPage: vi.fn(), requireDatabasePlace: vi.fn(async () => Promise.reject(new Error("no access"))) }));
vi.mock("@/server/ical-sync/run", () => ({ applyEvents: vi.fn(), fetchCalendar: vi.fn() }));
vi.mock("@/server/postgres-sync/client", () => ({
  describeTable: vi.fn(),
  PostgresSyncError: class extends Error {},
  readTable: vi.fn(),
  withPostgres: vi.fn(),
}));
vi.mock("@/server/postgres-sync/run", () => ({ applyTableRows: vi.fn(), readSyncedTable: vi.fn() }));
vi.mock("@/server/github-pulls/client", () => ({
  checkGithubApi: vi.fn(),
  fetchPulls: vi.fn(),
  GithubPullsError: class extends Error {},
  githubRepository: vi.fn(),
}));
vi.mock("@/server/github-pulls/run", () => ({ applyPulls: vi.fn() }));
vi.mock("@/server/sheets-sync/run", () => ({ applySheetRows: vi.fn(), readSheet: vi.fn(), sheetsConnection: vi.fn() }));
vi.mock("@/server/jira-sync/client", () => ({ JiraError: class extends Error {} }));

const { fetchCalendar } = await import("@/server/ical-sync/run");
const { withPostgres } = await import("@/server/postgres-sync/client");
const { githubRepository } = await import("@/server/github-pulls/client");
const { readSheet, sheetsConnection } = await import("@/server/sheets-sync/run");
const { createIcalSync } = await import("@/server/ical-sync/manage");
const { createPostgresSync } = await import("@/server/postgres-sync/manage");
const { createGithubPullsSync } = await import("@/server/github-pulls/manage");
const { createSheetsSync } = await import("@/server/sheets-sync/manage");

const place = { workspaceId: "ws1", parentId: "someone-elses-page" };

describe("setting a sync up", () => {
  it("reaches out only for someone who may make the database there", async () => {
    await expect(createIcalSync({ userId: "eve" }, { ...place, url: "https://calendar.example.test/a.ics" })).rejects.toThrow("no access");
    await expect(createPostgresSync({ userId: "eve" }, { ...place, url: "postgres://app:pw@db.example.test/shop", table: "orders" })).rejects.toThrow("no access");
    await expect(createGithubPullsSync({ userId: "eve" }, { ...place, query: { repo: "acme/app", state: "open" } })).rejects.toThrow("no access");
    await expect(
      createSheetsSync({ userId: "eve" }, { ...place, connectionId: "c1", link: "https://docs.google.com/spreadsheets/d/17AGsQSFVti7KUDNYLvq682TwnZF4N5MZKZpeNI_-lyc/edit" }),
    ).rejects.toThrow("no access");
    expect(fetchCalendar).not.toHaveBeenCalled();
    expect(withPostgres).not.toHaveBeenCalled();
    expect(githubRepository).not.toHaveBeenCalled();
    expect(sheetsConnection).not.toHaveBeenCalled();
    expect(readSheet).not.toHaveBeenCalled();
  });
});
