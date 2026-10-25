import { describe, expect, it } from "vitest";
import { GITHUB_API_URL, githubApiUrl, githubRepo, labelsNeeded, parseGithubQuery, pullRow, pullValues, type GithubPullsMapping } from "./github-pulls-sync";

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Fix the login",
  state: "open",
  draft: false,
  merged_at: null,
  user: { id: 1, login: "ada" },
  assignees: [
    { id: 2, login: "bob" },
    { id: 3, login: "cem" },
  ],
  labels: [{ name: "bug" }, { name: "Bug" }, { name: "ui" }],
  head: { ref: "fix-login" },
  base: { ref: "main" },
  created_at: "2026-10-01T10:00:00Z",
  html_url: "https://github.com/acme/app/pull/7",
  ...overrides,
});

describe("githubRepo", () => {
  it("takes owner/name and repository addresses", () => {
    expect(githubRepo("acme/app")).toBe("acme/app");
    expect(githubRepo(" https://github.com/acme/app/pulls ")).toBe("acme/app");
    expect(githubRepo("github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepo("acme/my.repo_1")).toBe("acme/my.repo_1");
  });
  it("refuses what can't be one", () => {
    for (const value of ["", "acme", "acme/app/extra", "-acme/app", "acme/..", "acme/app?x=1", "a b/c", 7, null]) {
      expect(githubRepo(value)).toBeNull();
    }
  });
});

describe("githubApiUrl", () => {
  it("is github.com's API for nothing typed or github.com", () => {
    expect(githubApiUrl(undefined)).toBe(GITHUB_API_URL);
    expect(githubApiUrl("  ")).toBe(GITHUB_API_URL);
    expect(githubApiUrl("https://github.com")).toBe(GITHUB_API_URL);
  });
  it("puts a server's API under /api/v3", () => {
    expect(githubApiUrl("ghe.acme.com")).toBe("https://ghe.acme.com/api/v3");
    expect(githubApiUrl("https://ghe.acme.com/api/v3/")).toBe("https://ghe.acme.com/api/v3");
  });
  it("refuses what isn't an address", () => {
    expect(githubApiUrl("ftp://ghe.acme.com")).toBeNull();
    expect(githubApiUrl("https://user:pass@ghe.acme.com")).toBeNull();
    expect(githubApiUrl("not an address")).toBeNull();
    expect(githubApiUrl(3)).toBeNull();
  });
});

describe("parseGithubQuery", () => {
  it("defaults to open pull requests", () => {
    expect(parseGithubQuery({ repo: "acme/app" })).toEqual({ repo: "acme/app", state: "open" });
    expect(parseGithubQuery({ repo: "https://github.com/acme/app", state: "all" })).toEqual({ repo: "acme/app", state: "all" });
  });
  it("refuses other states and missing repositories", () => {
    expect(parseGithubQuery({ repo: "acme/app", state: "closed" })).toBeNull();
    expect(parseGithubQuery({ state: "open" })).toBeNull();
    expect(parseGithubQuery("acme/app")).toBeNull();
  });
});

describe("pullRow", () => {
  it("reads a pull request", () => {
    expect(pullRow(pull())).toEqual({
      number: 7,
      title: "Fix the login",
      stage: "open",
      author: { id: "1", login: "ada" },
      assignees: [
        { id: "2", login: "bob" },
        { id: "3", login: "cem" },
      ],
      labels: ["bug", "Bug", "ui"],
      branch: "fix-login",
      base: "main",
      created: "2026-10-01T10:00:00.000Z",
      merged: null,
      link: "https://github.com/acme/app/pull/7",
    });
  });
  it("tells the stage: merged before closed, draft only while open", () => {
    expect(pullRow(pull({ draft: true }))?.stage).toBe("draft");
    expect(pullRow(pull({ state: "closed", draft: true }))?.stage).toBe("closed");
    expect(pullRow(pull({ state: "closed", merged_at: "2026-10-02T00:00:00Z" }))?.stage).toBe("merged");
  });
  it("skips what has no number, and links that aren't web addresses", () => {
    expect(pullRow({ title: "x" })).toBeNull();
    expect(pullRow(pull({ number: 0 }))).toBeNull();
    expect(pullRow(pull({ html_url: "javascript:alert(1)" }))?.link).toBeNull();
    expect(pullRow(pull({ title: "" }))?.title).toBe("#7");
  });
});

describe("labelsNeeded", () => {
  it("keeps the first spelling of each label", () => {
    expect(labelsNeeded([pullRow(pull())!, pullRow(pull({ labels: [{ name: "UI" }, { name: "docs" }] }))!])).toEqual(["bug", "ui", "docs"]);
  });
});

describe("pullValues", () => {
  const mapping: GithubPullsMapping = {
    number: "n",
    state: "s",
    author: "a",
    authorOthers: "ao",
    assignees: "p",
    assigneesOthers: "po",
    labels: "l",
    branch: "b",
    base: "bb",
    created: "c",
    merged: "m",
    link: "u",
    stages: { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" },
  };
  const people: Record<string, string> = { "1": "user-ada", "2": "user-bob" };
  const person = (user: { id: string }) => people[user.id] ?? null;

  it("writes every mapped property, people the workspace has as people and the rest as logins", () => {
    expect(pullValues(pullRow(pull())!, mapping, person)).toEqual({
      n: 7,
      s: "Open",
      a: ["user-ada"],
      ao: null,
      p: ["user-bob"],
      po: "cem",
      l: ["bug", "Bug", "ui"],
      b: "fix-login",
      bb: "main",
      c: "2026-10-01T10:00:00.000Z",
      m: null,
      u: "https://github.com/acme/app/pull/7",
    });
  });
  it("puts people in the text beside when there is no person property", () => {
    const { author: _a, assignees: _p, ...withoutPeople } = mapping;
    const values = pullValues(pullRow(pull())!, withoutPeople, person);
    expect(values.ao).toBe("ada");
    expect(values.po).toBe("bob, cem");
    expect(values).not.toHaveProperty("a");
  });
});
