import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "./pages";

// The pages beside a page, for its breadcrumb: which query runs for a row, a subpage and a
// top-level page, what each asks of the database (visibility, order, templates, the trash), and
// what comes back.

type Query = { where?: SQL; orderBy: SQL[]; limit?: number };
const queries: Query[] = [];
const results: unknown[][] = [];

vi.mock("@/db", () => {
  const select = () => {
    const query: Query = { orderBy: [] };
    queries.push(query);
    const chain = {
      from: () => chain,
      where: (where: SQL) => ((query.where = where), chain),
      orderBy: (...order: SQL[]) => ((query.orderBy = order), chain),
      limit: (n: number) => ((query.limit = n), chain),
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(results.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select } };
});

const requirePageAccess = vi.fn();
vi.mock("@/server/access", async (original) => ({
  ...(await original<typeof import("./access")>()),
  requirePageAccess: (...args: unknown[]) => requirePageAccess(...args),
}));

const getTree = vi.fn<(userId: string, workspaceId: string) => Promise<TreeNode[]>>();
vi.mock("@/server/pages", () => ({ getTree: (userId: string, workspaceId: string) => getTree(userId, workspaceId) }));

const { getPageSiblings, topLevelSiblings, SIBLING_ROW_LIMIT } = await import("./page-siblings");

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const target = (extra: Record<string, unknown> = {}) => ({
  id: "me",
  workspaceId: "ws",
  parentId: null as string | null,
  title: "Mine",
  icon: null,
  kind: "page" as const,
  inTemplate: false,
  archivedAt: null as Date | null,
  ...extra,
});
const sibling = (id: string, kind = "page") => ({ id, title: id.toUpperCase(), icon: null, kind });
const node = (id: string, section: string, parentId: string | null = null): TreeNode => ({
  id,
  parentId,
  kind: "page",
  title: id,
  icon: null,
  position: 0,
  level: "edit",
  teamspaceId: section.startsWith("ts") ? section : null,
  section,
});

beforeEach(() => {
  queries.length = 0;
  results.length = 0;
  requirePageAccess.mockReset();
  getTree.mockReset();
});

describe("getPageSiblings", () => {
  it("refuses a page the user can't see, without reading anything else", async () => {
    requirePageAccess.mockRejectedValue(new Error("no access"));
    await expect(getPageSiblings("u1", "secret")).rejects.toThrow("no access");
    expect(requirePageAccess).toHaveBeenCalledWith("u1", "secret", "view");
    expect(queries).toHaveLength(0);
    expect(getTree).not.toHaveBeenCalled();
  });

  it("lists a subpage's visible siblings under the same parent, in the sidebar's order", async () => {
    requirePageAccess.mockResolvedValue(target({ parentId: "parent" }));
    results.push([{ ...sibling("parent"), level: 4 }], [sibling("a"), sibling("me"), sibling("b")]);
    const out = await getPageSiblings("u1", "me");
    expect(out).toEqual({ pages: [sibling("a"), sibling("me"), sibling("b")], database: null, more: false });

    const children = queries[1];
    const { sql, params } = render(children.where!);
    expect(sql).toContain('"page"."parent_id" = $1');
    expect(params[0]).toBe("parent");
    expect(sql).toContain('"page"."archived_at" is null');
    expect(sql).toContain('"page"."in_template" = $2');
    expect(params[1]).toBe(false);
    // Visibility is asked per page for the user (childVisibleTo falls back to page_access_level).
    expect(sql).toContain("page_access_level(");
    expect(params).toContain("u1");
    expect(children.orderBy.map((o) => render(o).sql)).toEqual(['"page"."position" asc', '"page"."created_at" asc']);
    expect(children.limit).toBeUndefined();
  });

  it("keeps the pages of a template among themselves", async () => {
    requirePageAccess.mockResolvedValue(target({ parentId: "parent", inTemplate: true }));
    results.push([{ ...sibling("parent"), level: 4 }], []);
    await getPageSiblings("u1", "me");
    expect(render(queries[1].where!).params[1]).toBe(true);
  });

  it("lists a row's visible rows of its database, capped, with the database last", async () => {
    requirePageAccess.mockResolvedValue(target({ parentId: "db" }));
    const rows = Array.from({ length: SIBLING_ROW_LIMIT + 1 }, (_, i) => sibling(`r${i}`));
    results.push([{ ...sibling("db", "database"), level: 1 }], rows);
    const out = await getPageSiblings("u1", "me");
    expect(out.pages).toEqual(rows.slice(0, SIBLING_ROW_LIMIT));
    expect(out.database).toEqual(sibling("db", "database"));
    expect(out.more).toBe(true);

    const query = queries[1];
    const { sql, params } = render(query.where!);
    expect(sql).toContain('"page"."parent_id" = $1');
    expect(params[0]).toBe("db");
    // Row templates aren't rows; rows in the trash aren't listed.
    expect(sql).toContain('"page"."is_template" = $2');
    expect(params[1]).toBe(false);
    expect(sql).toContain('"page"."archived_at" is null');
    expect(sql).not.toContain("in_template");
    expect(sql).toContain("page_access_level(");
    expect(query.orderBy.map((o) => render(o).sql)).toEqual(['"page"."position" asc', '"page"."created_at" asc']);
    expect(query.limit).toBe(SIBLING_ROW_LIMIT + 1);
  });

  it("says nothing more when every row fits", async () => {
    requirePageAccess.mockResolvedValue(target({ parentId: "db" }));
    results.push([{ ...sibling("db", "database"), level: 1 }], [sibling("me")]);
    expect(await getPageSiblings("u1", "me")).toEqual({ pages: [sibling("me")], database: sibling("db", "database"), more: false });
  });

  it("leaves out a database the user can't see, keeping the rows they can", async () => {
    requirePageAccess.mockResolvedValue(target({ parentId: "db" }));
    results.push([{ ...sibling("db", "database"), level: 0 }], [sibling("me")]);
    const out = await getPageSiblings("u1", "me");
    expect(out.database).toBeNull();
    expect(out.pages).toEqual([sibling("me")]);
  });

  it("lists a top-level page's section from the sidebar's tree, without its own query", async () => {
    requirePageAccess.mockResolvedValue(target());
    getTree.mockResolvedValue([node("x", "ts1"), node("me", "ts1"), node("sub", "ts1", "me"), node("p", "private"), node("y", "ts1")]);
    const out = await getPageSiblings("u1", "me");
    expect(getTree).toHaveBeenCalledWith("u1", "ws");
    expect(queries).toHaveLength(0);
    expect(out.pages.map((p) => p.id)).toEqual(["x", "me", "y"]);
  });
});

describe("topLevelSiblings", () => {
  const tree = [
    node("t1", "ts1"),
    node("p1", "private"),
    node("me", "private"),
    node("child", "private", "me"),
    node("s1", "shared"),
    node("p2", "private"),
    node("t2", "ts2"),
  ];

  it("keeps to the section the page shows in, at the top level, in the tree's order", () => {
    expect(topLevelSiblings(tree, target()).map((p) => p.id)).toEqual(["p1", "me", "p2"]);
    expect(topLevelSiblings(tree, target({ id: "s1" })).map((p) => p.id)).toEqual(["s1"]);
    expect(topLevelSiblings(tree, target({ id: "t2" })).map((p) => p.id)).toEqual(["t2"]);
  });

  it("lists a page the sidebar leaves out on its own, and nothing for one in the trash", () => {
    expect(topLevelSiblings(tree, target({ id: "elsewhere", title: "Open space" }))).toEqual([
      { id: "elsewhere", title: "Open space", icon: null, kind: "page" },
    ]);
    expect(topLevelSiblings(tree, target({ id: "gone", archivedAt: new Date() }))).toEqual([]);
  });
});
