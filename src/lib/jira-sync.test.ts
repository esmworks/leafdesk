import { describe, expect, it } from "vitest";
import {
  issueRow,
  jiraErrorMessage,
  jiraSiteUrl,
  jqlOf,
  optionsNeeded,
  parseJiraQuery,
  pausesJiraSync,
  projectsOf,
  rowValues,
  searchPage,
  statusGroupOf,
  type JiraMapping,
} from "./jira-sync";

const SITE = "https://acme.atlassian.net";

/** Issues as `GET /rest/api/3/search/jql` writes them, with the fields a sync asks for. */
const ISSUES = [
  {
    id: "10001",
    key: "OPS-1",
    fields: {
      summary: "  Fix the login page  ",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      assignee: { accountId: "a1", displayName: "Ada Lovelace", emailAddress: "ada@example.com" },
      reporter: { accountId: "a2", displayName: "Grace Hopper", emailAddress: "grace@example.com" },
      priority: { name: "High" },
      labels: ["web", "urgent", "web"],
      duedate: "2026-11-02",
      issuetype: { name: "Bug" },
    },
  },
  {
    id: "10002",
    key: "OPS-2",
    fields: {
      summary: "Write the release notes",
      status: { name: "To Do", statusCategory: { key: "new" } },
      // Jira Cloud usually leaves the address out (profile privacy).
      assignee: { accountId: "a2", displayName: "Grace Hopper" },
      priority: null,
      labels: [],
      duedate: null,
      issuetype: { name: "Task" },
    },
  },
  {
    id: "10003",
    key: "OPS-3",
    fields: {
      summary: "",
      status: { name: "Done", statusCategory: { key: "done" } },
      assignee: null,
      priority: { name: "Low" },
      labels: ["web"],
      duedate: "not a day",
    },
  },
];

const MAPPING: JiraMapping = {
  key: "pKey",
  status: "pStatus",
  assignee: "pAssignee",
  assigneeOthers: "pOthers",
  reporter: "pReporter",
  priority: "pPriority",
  type: "pType",
  labels: "pLabels",
  due: "pDue",
  link: "pLink",
};

describe("issueRow", () => {
  it("reads an issue's fields", () => {
    expect(issueRow(ISSUES[0], SITE)).toEqual({
      key: "OPS-1",
      title: "Fix the login page",
      status: { name: "In Progress", group: "in_progress" },
      assignee: { name: "Ada Lovelace", email: "ada@example.com" },
      reporter: { name: "Grace Hopper", email: "grace@example.com" },
      priority: "High",
      type: "Bug",
      labels: ["web", "urgent"],
      due: "2026-11-02",
      link: "https://acme.atlassian.net/browse/OPS-1",
    });
  });

  it("leaves out what an issue doesn't have", () => {
    expect(issueRow(ISSUES[1], SITE)).toMatchObject({
      assignee: { name: "Grace Hopper", email: null },
      priority: null,
      labels: [],
      due: null,
    });
    // No summary: the key is the title; a due date that isn't a day is none.
    expect(issueRow(ISSUES[2], SITE)).toMatchObject({ title: "OPS-3", assignee: null, due: null, type: null, status: { name: "Done", group: "done" } });
  });

  it("passes over what isn't an issue", () => {
    expect(issueRow(null, SITE)).toBeNull();
    expect(issueRow({ id: "1", fields: {} }, SITE)).toBeNull();
    expect(issueRow({ key: "A-1" }, SITE)).toMatchObject({ key: "A-1", title: "A-1", status: null });
  });
});

describe("statusGroupOf", () => {
  it("follows Jira's status categories", () => {
    expect(statusGroupOf("new")).toBe("todo");
    expect(statusGroupOf("indeterminate")).toBe("in_progress");
    expect(statusGroupOf("done")).toBe("done");
    expect(statusGroupOf(undefined)).toBe("todo");
  });
});

describe("rowValues", () => {
  const rows = ISSUES.map((issue) => issueRow(issue, SITE)!);
  const people: Record<string, string> = { "ada@example.com": "user-ada", "grace@example.com": "user-grace" };
  const person = (a: { email: string | null }) => (a.email ? (people[a.email] ?? null) : null);

  it("writes every mapped property, a member as a person", () => {
    expect(rowValues(rows[0], MAPPING, person)).toEqual({
      pKey: "OPS-1",
      pStatus: "In Progress",
      pAssignee: ["user-ada"],
      pOthers: null,
      pReporter: ["user-grace"],
      pPriority: "High",
      pType: "Bug",
      pLabels: ["web", "urgent"],
      pDue: "2026-11-02",
      pLink: "https://acme.atlassian.net/browse/OPS-1",
    });
  });

  it("writes someone the workspace doesn't have as text, and clears what the issue lacks", () => {
    expect(rowValues(rows[1], MAPPING, person)).toMatchObject({ pAssignee: null, pOthers: "Grace Hopper", pPriority: null, pLabels: null, pDue: null });
    expect(rowValues(rows[2], MAPPING, person)).toMatchObject({ pAssignee: null, pOthers: null, pReporter: null });
  });

  it("writes only the properties still mapped", () => {
    const { assignee: _, ...withoutPerson } = MAPPING;
    // Without the person property, a member's name goes in the text.
    expect(rowValues(rows[0], withoutPerson, person)).toMatchObject({ pOthers: "Ada Lovelace" });
    expect(Object.keys(rowValues(rows[0], { key: "pKey" }, person))).toEqual(["pKey"]);
  });
});

describe("optionsNeeded", () => {
  it("lists each option once, in the order first seen", () => {
    const rows = ISSUES.map((issue) => issueRow(issue, SITE)!);
    expect(optionsNeeded(rows)).toEqual({
      status: [
        { name: "In Progress", group: "in_progress" },
        { name: "To Do", group: "todo" },
        { name: "Done", group: "done" },
      ],
      priority: ["High", "Low"],
      type: ["Bug", "Task"],
      labels: ["web", "urgent"],
    });
  });
});

describe("queries and sites", () => {
  it("reads a project or a JQL query", () => {
    expect(parseJiraQuery({ project: " ops " })).toEqual({ project: "OPS" });
    expect(parseJiraQuery({ project: "1OPS" })).toBeNull();
    expect(parseJiraQuery({ project: 'OPS" OR x = "' })).toBeNull();
    expect(parseJiraQuery({ jql: " assignee = currentUser() " })).toEqual({ jql: "assignee = currentUser()" });
    expect(parseJiraQuery({ jql: "  " })).toBeNull();
    expect(parseJiraQuery({ jql: "x".repeat(2001) })).toBeNull();
    expect(parseJiraQuery(null)).toBeNull();
  });

  it("turns a project into JQL", () => {
    expect(jqlOf({ project: "OPS" })).toBe('project = "OPS" ORDER BY key ASC');
    expect(jqlOf({ jql: "labels = web" })).toBe("labels = web");
  });

  it("reads a site's address as typed", () => {
    expect(jiraSiteUrl("acme.atlassian.net")).toBe(SITE);
    expect(jiraSiteUrl(" https://acme.atlassian.net/jira/software/projects/OPS ")).toBe(SITE);
    expect(jiraSiteUrl("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(jiraSiteUrl("ftp://acme.atlassian.net")).toBeNull();
    expect(jiraSiteUrl("https://user:pw@acme.atlassian.net")).toBeNull();
    expect(jiraSiteUrl("acme atlassian")).toBeNull();
    expect(jiraSiteUrl("")).toBeNull();
  });
});

describe("Jira's answers", () => {
  it("reads a search page and its next token", () => {
    expect(searchPage({ issues: [1, 2], nextPageToken: "t2" })).toEqual({ issues: [1, 2], next: "t2" });
    expect(searchPage({ issues: [1], nextPageToken: "t2", isLast: true })).toEqual({ issues: [1], next: null });
    expect(searchPage({ issues: [] })).toEqual({ issues: [], next: null });
    expect(searchPage({ values: [] })).toBeNull();
  });

  it("reads projects", () => {
    expect(projectsOf({ values: [{ key: "OPS", name: "Operations" }, { key: "bad key" }, { key: "WEB" }] })).toEqual([
      { key: "OPS", name: "Operations" },
      { key: "WEB", name: "WEB" },
    ]);
    expect(projectsOf(null)).toEqual([]);
  });

  it("finds Jira's own words in an error", () => {
    expect(jiraErrorMessage({ errorMessages: ["The value 'NOPE' does not exist for the field 'project'."] })).toBe(
      "The value 'NOPE' does not exist for the field 'project'.",
    );
    expect(jiraErrorMessage({ errorMessages: [], errors: { jql: "Bad JQL" } })).toBe("Bad JQL");
    expect(jiraErrorMessage("<html>")).toBeNull();
  });

  it("pauses for problems that won't pass", () => {
    expect(pausesJiraSync("unauthorized")).toBe(true);
    expect(pausesJiraSync("keyGone")).toBe(true);
    expect(pausesJiraSync("unreachable")).toBe(false);
    expect(pausesJiraSync("failed")).toBe(false);
  });
});
