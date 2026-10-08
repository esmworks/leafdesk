import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { runActingFor } from "./acting-for";
import { hasLevel, levelFromRank, pageVisibleTo, type AccessLevel } from "./access";

vi.mock("@/db", () => ({ db: {} }));

describe("levelFromRank", () => {
  it("maps the SQL function's result to a level, and anything unexpected to none", () => {
    expect([0, 1, 2, 3, 4].map(levelFromRank)).toEqual(["none", "view", "comment", "edit", "full"]);
    expect(levelFromRank("3")).toBe("edit");
    expect(levelFromRank(null)).toBe("none");
    expect(levelFromRank(7)).toBe("none");
  });
});

describe("hasLevel", () => {
  const cases: [AccessLevel, "view" | "comment" | "edit" | "full", boolean][] = [
    ["none", "view", false],
    ["view", "view", true],
    ["view", "comment", false],
    ["view", "edit", false],
    ["comment", "view", true],
    ["comment", "comment", true],
    ["comment", "edit", false],
    ["edit", "comment", true],
    ["edit", "edit", true],
    ["edit", "full", false],
    ["full", "view", true],
    ["full", "full", true],
  ];
  it.each(cases)("%s satisfies %s: %s", (level, needed, expected) => {
    expect(hasLevel(level, needed)).toBe(expected);
  });
});

describe("pageVisibleTo", () => {
  const render = (userId: string, alias?: string) => new PgDialect().sqlToQuery(pageVisibleTo(userId, alias));

  it("asks page_access_level for at least view, with the user as a parameter", () => {
    const { sql, params } = render("user-1");
    expect(sql).toBe('page_access_level($1, "page"."id") > 0');
    expect(params).toEqual(["user-1"]);
  });

  it("uses the alias of a raw query", () => {
    expect(render("user-1", "p").sql).toBe('page_access_level($1, "p"."id") > 0');
  });

  it("refuses aliases that could inject SQL", () => {
    expect(() => pageVisibleTo("user-1", 'p"; drop table page; --')).toThrow();
  });
});

describe("acting for a member", () => {
  const render = (userId: string) => new PgDialect().sqlToQuery(pageVisibleTo(userId));

  it("gives the agent the lower of its and the member's access", () => {
    const { sql, params } = runActingFor({ userId: "agent", forUserId: "member" }, () => render("agent"));
    expect(sql).toBe('least(page_access_level($1, "page"."id"), page_access_level($2, "page"."id")) > 0');
    expect(params).toEqual(["agent", "member"]);
  });

  it("leaves everyone else's access, and the agent's outside the run, as it is", () => {
    expect(runActingFor({ userId: "agent", forUserId: "member" }, () => render("owner")).sql).toBe('page_access_level($1, "page"."id") > 0');
    expect(render("agent").sql).toBe('page_access_level($1, "page"."id") > 0');
  });
});

/**
 * Page access must be decided in access.ts only. A query that joins workspace_member elsewhere
 * would bypass page-level sharing once it exists, so membership tables may only appear in the
 * access module and in workspace/member management (groups.ts: who may be in a member group).
 */
describe("access checks stay in one place", () => {
  const root = join(__dirname, "..");
  // server/scim.ts is member management too: an identity provider adding and removing members.
  // server/guests.ts lists the guests; the pages it names are filtered with page_access_level.
  // server/join-requests.ts is member management too: requests that end in someone joining.
  const ALLOWED = new Set([
    "server/guests.ts",
    "server/join-requests.ts",
    "server/access.ts",
    "server/permissions.ts",
    "server/workspaces.ts",
    "server/teamspaces.ts",
    "server/scim.ts",
    "server/groups.ts",
  ]);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "db" && dir === root ? [] : sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  it("no other module reads workspace_member", () => {
    const offenders = sources(root)
      .map((path) => relative(root, path))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => /\bworkspaceMember\b|workspace_member/.test(readFileSync(join(root, path), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no other module reads teamspace_member: who is in a teamspace is teamspaces.ts's business", () => {
    const offenders = sources(root)
      .map((path) => relative(root, path))
      .filter((path) => path !== "server/teamspaces.ts")
      .filter((path) => /\bteamspaceMember\b|teamspace_member/.test(readFileSync(join(root, path), "utf8")));
    expect(offenders).toEqual([]);
  });
});
