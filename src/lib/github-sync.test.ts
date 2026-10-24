import { describe, expect, it } from "vitest";
import {
  EMPTY_GITHUB_MAPPING,
  findIds,
  MAX_GITHUB_LINKS,
  MAX_GITHUB_ROWS,
  nextStatus,
  pullRequestIds,
  pullRequestOf,
  statusMove,
  withLink,
  type GithubMapping,
} from "./github-sync";

const payload = (over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  repository: { full_name: "acme/app" },
  pull_request: {
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    title: "Fix login (TASK-12)",
    body: "Also closes task-3 and [TASK-40].",
    draft: false,
    merged: false,
    head: { ref: "feature/TASK-5-login" },
    ...pr,
  },
  ...over,
});

describe("finding row IDs", () => {
  it("finds the prefix's IDs in any case, apart from letters and digits", () => {
    expect(findIds("TASK-12 task-3 Task-4", "TASK")).toEqual([12, 3, 4]);
    expect(findIds("feature/TASK-5-login_fix", "TASK")).toEqual([5]);
    expect(findIds("[TASK-40] (TASK-41) #TASK-42 TASK-43_x", "TASK")).toEqual([40, 41, 42, 43]);
  });

  it("doesn't take longer numbers, other prefixes or glued text", () => {
    expect(findIds("XTASK-12 TASK-12a TASK-0 BUG-3 TASKS-4", "TASK")).toEqual([]);
    expect(findIds("TASK-123", "TASK")).toEqual([123]);
    expect(findIds("TASK-12 TASK-12", "TASK")).toEqual([12]);
    expect(findIds("TASK-12", "")).toEqual([]);
  });

  it("reads a pull request's title, then description, then branch, at most MAX_GITHUB_ROWS", () => {
    const pr = pullRequestOf(payload())!;
    expect(pullRequestIds(pr, "TASK")).toEqual([12, 3, 40, 5]);
    const many = Array.from({ length: MAX_GITHUB_ROWS + 5 }, (_, i) => `TASK-${i + 1}`).join(" ");
    expect(pullRequestIds({ title: many, body: "", branch: "" }, "TASK")).toHaveLength(MAX_GITHUB_ROWS);
  });
});

describe("reading a pull request event", () => {
  it("takes what the rows need", () => {
    expect(pullRequestOf(payload())).toEqual({
      action: "opened",
      repo: "acme/app",
      number: 7,
      title: "Fix login (TASK-12)",
      body: "Also closes task-3 and [TASK-40].",
      url: "https://github.com/acme/app/pull/7",
      branch: "feature/TASK-5-login",
      draft: false,
      merged: false,
    });
  });

  it("has none without a pull request link", () => {
    expect(pullRequestOf({ zen: "Keep it logically awesome." })).toBeNull();
    expect(pullRequestOf(payload({}, { html_url: "javascript:alert(1)" }))).toBeNull();
    expect(pullRequestOf("text")).toBeNull();
  });
});

describe("the status a pull request gives a row", () => {
  const mapping: GithubMapping = { ...EMPTY_GITHUB_MAPPING, statusPropertyId: "s", opened: "review", merged: "done", closed: "todo" };
  const options = [
    { id: "todo", group: "todo" as const },
    { id: "doing", group: "in_progress" as const },
    { id: "review", group: "in_progress" as const },
    { id: "done", group: "done" as const },
    { id: "wontfix", group: "done" as const },
  ];

  it("moves on opening (a draft once it is ready), merging and closing", () => {
    expect(statusMove({ action: "opened", draft: false, merged: false })).toBe("opened");
    expect(statusMove({ action: "opened", draft: true, merged: false })).toBeNull();
    expect(statusMove({ action: "ready_for_review", draft: false, merged: false })).toBe("opened");
    expect(statusMove({ action: "reopened", draft: false, merged: false })).toBe("opened");
    expect(statusMove({ action: "closed", draft: false, merged: true })).toBe("merged");
    expect(statusMove({ action: "closed", draft: false, merged: false })).toBe("closed");
    expect(statusMove({ action: "edited", draft: false, merged: false })).toBeNull();
  });

  it("sets the option the setup gives, unless the row has it", () => {
    expect(nextStatus("doing", "opened", mapping, options)).toBe("review");
    expect(nextStatus(undefined, "opened", mapping, options)).toBe("review");
    expect(nextStatus("review", "opened", mapping, options)).toBeNull();
    expect(nextStatus("review", "merged", mapping, options)).toBe("done");
    expect(nextStatus("review", "closed", mapping, options)).toBe("todo");
  });

  it("never takes a finished row back, but a merge still finishes it", () => {
    expect(nextStatus("done", "opened", mapping, options)).toBeNull();
    expect(nextStatus("done", "closed", mapping, options)).toBeNull();
    expect(nextStatus("wontfix", "opened", mapping, options)).toBeNull();
    expect(nextStatus("wontfix", "merged", mapping, options)).toBe("done");
  });

  it("leaves rows alone for moves without an option, and for options deleted since", () => {
    expect(nextStatus("doing", "closed", { ...mapping, closed: null }, options)).toBeNull();
    expect(nextStatus("doing", "opened", { ...mapping, opened: "gone" }, options)).toBeNull();
    expect(nextStatus("doing", null, mapping, options)).toBeNull();
  });
});

describe("adding a pull request's link", () => {
  const url = "https://github.com/acme/app/pull/7";

  it("keeps every link in a text property, once each", () => {
    expect(withLink(undefined, url, "text")).toBe(url);
    expect(withLink("https://github.com/acme/app/pull/3", url, "text")).toBe(`https://github.com/acme/app/pull/3\n${url}`);
    expect(withLink(`https://github.com/acme/app/pull/3\n${url}\n`, url, "text")).toBeNull();
  });

  it("keeps the latest links when there are many", () => {
    const old = Array.from({ length: MAX_GITHUB_LINKS }, (_, i) => `https://github.com/acme/app/pull/${100 + i}`).join("\n");
    const next = withLink(old, url, "text")!.split("\n");
    expect(next).toHaveLength(MAX_GITHUB_LINKS);
    expect(next.at(-1)).toBe(url);
  });

  it("keeps the latest in a url property", () => {
    expect(withLink("https://github.com/acme/app/pull/3", url, "url")).toBe(url);
    expect(withLink(url, url, "url")).toBeNull();
  });
});
