import { beforeEach, describe, expect, it, vi } from "vitest";

// Setting a Jira sync up reaches out to Jira only for people who may make the database, and a
// sync's sign-in reads only what the person who gave it set it to read.

const stored: { row: Record<string, unknown> | null } = { row: null };
const updates: Record<string, unknown>[] = [];
vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => (stored.row ? [stored.row] : []) }) }),
    update: () => ({ set: (values: Record<string, unknown>) => (updates.push(values), { where: async () => [] }) }),
  },
}));
vi.mock("@/server/secret-box", () => ({ openJson: (value: unknown) => value, sealJson: (value: unknown) => value }));
vi.mock("@/server/access", () => ({ AccessError: class AccessError extends Error {}, requireMembership: vi.fn(async () => ({ role: "member" })) }));
vi.mock("@/server/databases", () => ({
  addProperty: vi.fn(),
  addView: vi.fn(),
  getProperties: vi.fn(async () => []),
  requireDatabase: vi.fn(async () => ({ id: "db1" })),
}));
vi.mock("@/server/pages", () => ({ createPage: vi.fn(), requireDatabasePlace: vi.fn(async () => {}) }));
vi.mock("@/server/import/csv", () => ({ discardDatabase: vi.fn(), recordImport: vi.fn() }));
vi.mock("./run", () => ({
  applyIssues: vi.fn(),
  claimSync: vi.fn(async () => stored.row),
  runAndRecord: vi.fn(async () => ({ error: null, count: 0 })),
}));
vi.mock("./client", () => ({
  JiraError: class JiraError extends Error {
    constructor(
      readonly code: string,
      message = code,
    ) {
      super(message);
    }
  },
  checkJiraSite: () => {},
  jiraAccount: vi.fn(async () => ({ name: "Ada" })),
  jiraProjects: vi.fn(async () => [{ key: "OPS", name: "Operations" }]),
  searchIssues: vi.fn(async () => []),
}));

const { requireMembership } = await import("@/server/access");
const { requireDatabasePlace } = await import("@/server/pages");
const { jiraAccount, jiraProjects, searchIssues } = await import("./client");
const { checkJira, createJiraSync, getJiraSync, JiraSignInNeeded, jiraProjectsOf, updateJiraSync } = await import("./manage");

const SITE = "https://example.atlassian.net";
const signIn = { email: "ada@example.test", token: "token-a" };

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  stored.row = {
    id: "s1",
    source: "jira",
    databaseId: "db1",
    siteUrl: SITE,
    query: { project: "OPS" },
    mapping: { key: "k" },
    secrets: { ...signIn, owner: "ada" },
    createdBy: "ada",
    runningUntil: null,
  };
});

describe("checking a sign-in", () => {
  it("asks the workspace before Jira", async () => {
    vi.mocked(requireMembership).mockRejectedValueOnce(new Error("not a member"));
    await expect(checkJira("eve", "ws1", { siteUrl: SITE, ...signIn })).rejects.toThrow("not a member");
    expect(jiraAccount).not.toHaveBeenCalled();
    expect(await checkJira("ada", "ws1", { siteUrl: SITE, ...signIn })).toEqual({ account: "Ada", projects: [{ key: "OPS", name: "Operations" }] });
  });
});

describe("setting a sync up", () => {
  it("checks the database's place before reaching Jira", async () => {
    vi.mocked(requireDatabasePlace).mockRejectedValueOnce(new Error("no access"));
    await expect(createJiraSync({ userId: "eve" }, { workspaceId: "ws1", parentId: "p1", siteUrl: SITE, ...signIn, query: { project: "OPS" } })).rejects.toThrow(
      "no access",
    );
    expect(searchIssues).not.toHaveBeenCalled();
  });
});

describe("a sync's sign-in", () => {
  it("is pointed elsewhere only by whoever gave it", async () => {
    await expect(updateJiraSync("bob", "db1", { query: { project: "HR" } })).rejects.toBeInstanceOf(JiraSignInNeeded);
    expect(updates).toEqual([]);
    // Others still change how often it runs, and may save the query it has.
    await updateJiraSync("bob", "db1", { intervalMinutes: 60, query: { project: "OPS" } });
    expect(updates[0]).toMatchObject({ runAs: "bob", intervalMinutes: 60 });
    await updateJiraSync("ada", "db1", { query: { project: "HR" } });
    expect(updates.at(-2)).toMatchObject({ query: { project: "HR" } });
  });

  it("is replaced by the sign-in of whoever points it elsewhere", async () => {
    await updateJiraSync("bob", "db1", { query: { project: "HR" }, email: "bob@example.test", token: "token-b" });
    expect(jiraAccount).toHaveBeenCalledWith(SITE, { email: "bob@example.test", token: "token-b" });
    expect(updates[0]).toMatchObject({ query: { project: "HR" }, secrets: { email: "bob@example.test", token: "token-b", owner: "bob" } });
  });

  it("lists projects to its owner, and to others only with their own", async () => {
    await expect(jiraProjectsOf("bob", "db1")).rejects.toBeInstanceOf(JiraSignInNeeded);
    expect(jiraProjects).not.toHaveBeenCalled();
    await jiraProjectsOf("bob", "db1", { email: "bob@example.test", token: "token-b" });
    expect(jiraProjects).toHaveBeenLastCalledWith(SITE, { email: "bob@example.test", token: "token-b" });
    await jiraProjectsOf("ada", "db1");
    expect(jiraProjects).toHaveBeenLastCalledWith(SITE, { ...signIn, owner: "ada" });
  });

  it("of a sync set up before owners were kept is nobody's", async () => {
    stored.row!.secrets = signIn;
    await expect(updateJiraSync("ada", "db1", { query: { project: "HR" } })).rejects.toBeInstanceOf(JiraSignInNeeded);
    expect((await getJiraSync("ada", "db1"))?.ownSignIn).toBe(false);
    stored.row!.secrets = { ...signIn, owner: "ada" };
    expect((await getJiraSync("ada", "db1"))?.ownSignIn).toBe(true);
  });
});
