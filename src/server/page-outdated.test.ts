import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyView } from "@/lib/properties";

// Archived pages (server/page-outdated.ts): the SQL that leaves them out of lists, who may archive
// and unarchive, why a page counts as archived, and that the sidebar, search, semantic search and
// pickers ask for them to be left out. Which pages the walk down finds is checked against the
// database in scripts/page-archive-e2e.ts.

const executed: SQL[] = [];
const results: unknown[][] = [];
const selects: { where?: SQL; columns?: Record<string, unknown> }[] = [];

vi.mock("@/db", () => {
  const select = (columns?: Record<string, unknown>) => {
    const query: { where?: SQL; columns?: Record<string, unknown> } = { columns };
    selects.push(query);
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: (where: SQL) => ((query.where = where), chain),
      orderBy: () => chain,
      limit: () => chain,
      as: () => ({ id: {}, title: {}, icon: {}, kind: {}, updatedAt: {} }),
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  };
  const execute = vi.fn(async (query: SQL) => {
    executed.push(query);
    return results.shift() ?? [];
  });
  return { db: { execute, select } };
});

const collab = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => collab }));

const access = vi.hoisted(() => ({
  requirePageAccess: vi.fn(),
  requireMembership: vi.fn(async () => ({ role: "member" })),
  enforceWorkspacePolicy: vi.fn(async () => {}),
  workspacesHeldBack: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("./access")>()), ...access }));
vi.mock("@/server/teamspaces", () => ({ sidebarTeamspaces: vi.fn(async () => []), placeTopLevel: vi.fn(), requireTeamspaceForPages: vi.fn() }));
vi.mock("@/server/workspaces", () => ({
  listWorkspaces: vi.fn(async () => [{ id: "ws-1" }]),
  requireTopLevel: vi.fn(),
  workspaceSettings: vi.fn(async () => ({ ai: true })),
}));
vi.mock("@/server/file-text", () => ({ sweepDocuments: vi.fn(async () => {}) }));

const { listedPage, isOutdated, outdatedIds, outdatedState, setPageOutdated, OutdatedError } = await import("./page-outdated");
const pages = await import("./pages");
const { AccessError, FULL_RANK } = await import("./access");

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const OUTDATED_WALK = /with recursive outdated as/;

const page = (extra: Record<string, unknown> = {}) => ({
  id: "p1",
  workspaceId: "ws-1",
  parentId: null as string | null,
  isTemplate: false,
  inTemplate: false,
  archivedAt: null as Date | null,
  outdatedAt: null as Date | null,
  ...extra,
});

beforeEach(() => {
  executed.length = 0;
  results.length = 0;
  selects.length = 0;
  vi.clearAllMocks();
});

describe("the SQL that leaves archived pages out", () => {
  it("walks down from the archived pages of the workspaces asked about", () => {
    const { sql, params } = render(outdatedIds(["ws-1", "ws-2"]));
    expect(sql).toMatch(OUTDATED_WALK);
    expect(sql).toMatch(/o\.workspace_id in \(\$1, \$2\) and o\.outdated_at is not null/);
    // Down through children in the same workspace (page_workspace_parent_idx); union drops pages found twice.
    expect(sql).toMatch(/union\s+select c\.id, c\.workspace_id from "page" c\s+join outdated on c\.workspace_id = outdated\.workspace_id and c\.parent_id = outdated\.id/);
    expect(params).toEqual(["ws-1", "ws-2"]);
    expect(render(outdatedIds([])).sql).toMatch(/where false/);
  });

  it("listedPage: out of the trash and templates, and not archived unless asked", () => {
    const listed = render(listedPage("ws-1", { alias: "p" })).sql;
    expect(listed).toMatch(/"p"\."archived_at" is null and not "p"\."in_template"/);
    expect(listed).toMatch(/"p"\."id" not in \(\s*with recursive outdated/);
    const all = render(listedPage("ws-1", { alias: "p", includeOutdated: true })).sql;
    expect(all).toMatch(/"p"\."archived_at" is null and not "p"\."in_template"/);
    expect(all).not.toMatch(OUTDATED_WALK);
    // Without an alias it names the page table's columns.
    expect(render(listedPage("ws-1")).sql).toMatch(/"page"\."archived_at" is null and not "page"\."in_template" and "page"\."id" not in/);
    expect(render(isOutdated("ws-1", "p")).sql).toMatch(/"p"\."id" in \(\s*with recursive outdated/);
    expect(() => listedPage("ws-1", { alias: "p; drop" })).toThrow(/Bad table alias/);
  });
});

describe("outdatedState", () => {
  const at = new Date("2026-10-01T09:00:00Z");

  it("is null for a page that neither is archived nor lies under one", async () => {
    results.push([]);
    expect(await outdatedState("u1", "p1")).toBeNull();
    // Walks up only until it meets an archived page.
    expect(render(executed[0]).sql).toMatch(/where chain\.outdated_at is null and chain\.depth < 64/);
  });

  it("names who archived the page itself, and whether the user may unarchive it", async () => {
    results.push([{ id: "p1", depth: 0, title: "Prices 2025", outdated_at: at, by: "Ada", level: FULL_RANK }]);
    expect(await outdatedState("u1", "p1")).toEqual({ pageId: "p1", own: true, title: "Prices 2025", at, by: "Ada", canUnarchive: true });
  });

  it("names the page above it that is archived, unless the user can't open that page", async () => {
    results.push([{ id: "top", depth: 2, title: "Old offers", outdated_at: at, by: null, level: 3 }]);
    expect(await outdatedState("u1", "p1")).toEqual({ pageId: "top", own: false, title: "Old offers", at, by: null, canUnarchive: false });
    results.push([{ id: "top", depth: 1, title: "Secret", outdated_at: at, by: "Ada", level: 0 }]);
    expect(await outdatedState("u1", "p1")).toMatchObject({ pageId: "top", own: false, title: null, canUnarchive: false });
  });
});

describe("setPageOutdated", () => {
  it("needs full access to the page", async () => {
    access.requirePageAccess.mockRejectedValueOnce(new AccessError());
    await expect(setPageOutdated("u1", "p1", true)).rejects.toBeInstanceOf(AccessError);
    expect(access.requirePageAccess).toHaveBeenCalledWith("u1", "p1", "full");
    expect(executed).toHaveLength(0);
  });

  it("archives the page alone, keeping its edited time, and tells open tabs and the sidebar", async () => {
    access.requirePageAccess.mockResolvedValueOnce(page({ parentId: "db-1" }));
    await setPageOutdated("u1", "p1", true);
    const { sql, params } = render(executed[0]);
    expect(sql).toMatch(/^update "page" set outdated_at = now\(\), outdated_by = \$1 where id = \$2 and outdated_at is null$/);
    expect(sql).not.toMatch(/updated_at/);
    expect(params).toEqual(["u1", "p1"]);
    expect(collab.broadcast.mock.calls).toEqual([
      ["ws:ws-1", "tree"],
      ["db:db-1", "rows"],
      ["page:p1", "header"],
    ]);
  });

  it("unarchives the page, which brings the pages under it back with it", async () => {
    access.requirePageAccess.mockResolvedValueOnce(page({ outdatedAt: new Date() }));
    await setPageOutdated("u1", "p1", false);
    expect(render(executed[0]).sql).toMatch(/^update "page" set outdated_at = null, outdated_by = null where id = \$1$/);
  });

  it("does nothing when the page already is (or isn't) archived itself", async () => {
    access.requirePageAccess.mockResolvedValueOnce(page({ outdatedAt: new Date() }));
    await setPageOutdated("u1", "p1", true);
    access.requirePageAccess.mockResolvedValueOnce(page());
    await setPageOutdated("u1", "p1", false);
    expect(executed).toHaveLength(0);
    expect(collab.broadcast).not.toHaveBeenCalled();
  });

  it("refuses templates, pages in them and pages in the trash", async () => {
    for (const [found, code] of [
      [page({ isTemplate: true, inTemplate: true }), "template"],
      [page({ inTemplate: true }), "template"],
      [page({ archivedAt: new Date() }), "inTrash"],
    ] as const) {
      access.requirePageAccess.mockResolvedValueOnce(found);
      const error = await setPageOutdated("u1", "p1", true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutdatedError);
      expect((error as InstanceType<typeof OutdatedError>).code).toBe(code);
    }
    expect(executed).toHaveLength(0);
  });
});

describe("lists that leave archived pages out", () => {
  it("the sidebar leaves out archived pages with everything under them", async () => {
    results.push([]);
    await pages.getTree("u1", "ws-1");
    const { sql, params } = render(executed[0]);
    expect(sql).toMatch(/"p"\."archived_at" is null and not "p"\."in_template" and "p"\."id" not in \(\s*with recursive outdated/);
    expect(params).toContain("ws-1");
  });

  it("full-text search leaves them out of page and document matches unless asked, and marks them when asked", async () => {
    results.push([]);
    await pages.fullTextSearch("u1", "prices", { workspaceId: "ws-1" });
    const plain = render(executed[0]).sql;
    // The page's own text and the documents it shows.
    expect(plain.match(/"p"\."id" not in \(\s*with recursive outdated/g)).toHaveLength(2);
    expect(plain).toMatch(/false as outdated/);

    results.push([{ id: "p2", workspace_id: "ws-1", teamspace_id: null, parent_id: null, kind: "page", title: "Prices", icon: null, content_text: "", updated_at: new Date(), file_id: null, file_name: null, file_text: null, outdated: true }]);
    const hits = await pages.fullTextSearch("u1", "prices", { workspaceId: "ws-1", includeOutdated: true });
    const all = render(executed[1]).sql;
    expect(all).not.toMatch(/not in \(\s*with recursive outdated/);
    expect(all).toMatch(/"p"\."id" in \(\s*with recursive outdated[\s\S]*\) as outdated/);
    expect(hits[0].outdated).toBe(true);
  });

  it("the search box passes Include archived through, to the in: filter as well", async () => {
    results.push([]);
    await pages.searchWithQuery("u1", "ws-1", "prices", 20, { includeOutdated: true });
    expect(render(executed[0]).sql).not.toMatch(/not in \(\s*with recursive outdated/);
    await pages.searchWithQuery("u1", "ws-1", 'in:"Offers" prices');
    // The in: filter's pages (a select) leave archived ones out too.
    expect(render(selects.at(-1)!.where!).sql).toMatch(/"page"\."id" not in \(\s*with recursive outdated/);
  });

  it("recent pages leave them out", async () => {
    await pages.recentPages("u1", "ws-1");
    expect(selects.some((s) => s.where && /not in \(\s*with recursive outdated/.test(render(s.where).sql))).toBe(true);
  });

  it("listing pages: under a parent those archived themselves, at the top every archived one, unless asked", async () => {
    await pages.listChildren("u1", "ws-1", "parent-1");
    const under = render(selects.at(-1)!.where!).sql;
    expect(under).toMatch(/"page"\."outdated_at" is null/);
    expect(under).not.toMatch(OUTDATED_WALK);
    await pages.listChildren("u1", "ws-1", null);
    expect(render(selects.at(-1)!.where!).sql).toMatch(/"page"\."id" not in \(\s*with recursive outdated/);
    await pages.listChildren("u1", "ws-1", "parent-1", { includeOutdated: true });
    expect(render(selects.at(-1)!.where!).sql).not.toMatch(/outdated_at/);
  });
});

describe("database views", () => {
  const row = (id: string, outdated?: boolean) => ({ id, title: id, properties: {}, createdAt: new Date(0), updatedAt: new Date(0), outdated });

  it("leave rows archived on their own out unless the view shows them", () => {
    const rows = [row("a"), row("b", true), row("c", false)];
    expect(applyView(rows, {}).map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyView(rows, { showOutdated: true }).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
