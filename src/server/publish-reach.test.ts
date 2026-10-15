import { beforeEach, describe, expect, it, vi } from "vitest";
import { newWidget, serializeDashboard } from "@/lib/dashboard";
import type { PageBlock } from "./blocknote";

/**
 * Which databases shown in a page's body lie outside it, and which of them its publication shows.
 * The page tree is the map below (child → parent); a database is published with the page when it
 * lies under it, as chainTo (mocked) decides from the same tree. The database answers from a queue,
 * one result per query: the referenced databases the user can see, then the page's publication.
 * Writes land in `written`.
 */
const ROOT = "root";
const parents = new Map<string, string | null>();
const results: unknown[][] = [];
let blocks: unknown[] = [];
let publishing = true;
let blocker: string | null = null;
const written: unknown[] = [];
const chainTo = vi.fn(async (_publisher: string, pageId: string, rootId: string) => {
  for (let id: string | null | undefined = pageId; id; id = parents.get(id)) if (id === rootId) return [];
  return null;
});

function chain(): unknown {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from"]) node[method] = () => node;
  // Answers when awaited (as it is, or after `limit`), so queries run together answer in order.
  const answer = { then: (done: (rows: unknown[]) => unknown) => Promise.resolve(results.shift() ?? []).then(done) };
  node.where = () => ({ ...answer, limit: () => answer });
  return node;
}

vi.mock("@/db", () => ({
  db: {
    select: () => (chain() as { select: () => unknown }).select(),
    update: () => ({ set: (values: unknown) => ({ where: () => ({ returning: async () => (written.push(values), [{ pageId: ROOT }]) }) }) }),
  },
}));
vi.mock("@/server/access", () => ({
  accessRank: () => "rank",
  requirePageAccess: async (_userId: string, pageId: string) => ({ id: pageId, kind: pageId === ROOT ? "page" : "database", workspaceId: "w" }),
}));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ readBlocks: async () => ({ title: "", blocks }) }) }));
vi.mock("@/server/publication", () => ({ chainTo, publishBlocker: async () => blocker, PublishError: class extends Error {} }));
vi.mock("@/server/workspaces", () => ({ publishingOn: async () => publishing }));

const { outsideDatabases, setOutsideDatabases } = await import("./publish-reach");
const { bodyDatabaseIds } = await import("./published-body");

const dashboard = (...databaseIds: string[]) => ({
  type: "dashboard",
  props: { widgets: serializeDashboard(databaseIds.map((id, i) => newWidget(`w${i}`, id))) },
  children: [],
});
const embed = (type: "database" | "linkedView", databaseId: string) => ({ type, props: { databaseId }, children: [] });
const header = (id: string) => ({ id, title: id.toUpperCase(), icon: null });
const listed = (id: string, shown = false) => ({ ...header(id), shown });

beforeEach(() => {
  parents.clear();
  results.length = 0;
  blocks = [];
  publishing = true;
  blocker = null;
  written.length = 0;
  chainTo.mockClear();
});

describe("bodyDatabaseIds", () => {
  it("lists dashboard widgets' and database blocks' databases once, wherever they sit", () => {
    const body = [
      { type: "paragraph", props: {}, children: [embed("linkedView", "nested")] },
      dashboard("cards", "installments", "cards"),
      {
        type: "columnList",
        props: {},
        children: [{ type: "column", props: {}, children: [embed("database", "inline"), dashboard("monthly")] }],
      },
      embed("linkedView", "cards"),
      { type: "linkedView", props: { databaseId: "" }, children: [] },
    ];
    expect(bodyDatabaseIds(body as unknown as PageBlock[])).toEqual(["nested", "cards", "installments", "inline", "monthly"]);
  });
});

describe("outsideDatabases", () => {
  it("names the databases that sit beside the page rather than under it", async () => {
    parents.set(ROOT, "workspace-root").set("cards", "workspace-root").set("installments", "workspace-root").set("inline", ROOT);
    blocks = [dashboard("cards", "installments"), embed("database", "inline")];
    results.push([header("installments"), header("inline"), header("cards")], []);
    expect(await outsideDatabases("u1", ROOT)).toEqual([listed("cards"), listed("installments")]);
  });

  it("marks the ones the publication shows anyway", async () => {
    blocks = [dashboard("cards", "installments")];
    results.push([header("cards"), header("installments")], [{ publishedBy: "u1", outside: ["installments", "gone"] }]);
    expect(await outsideDatabases("u1", ROOT)).toEqual([listed("cards"), listed("installments", true)]);
  });

  it("names nothing once those databases are moved under the page", async () => {
    parents.set("cards", ROOT).set("installments", "cards");
    blocks = [dashboard("cards", "installments")];
    results.push([header("cards"), header("installments")], []);
    expect(await outsideDatabases("u1", ROOT)).toEqual([]);
  });

  it("asks for whoever published the page", async () => {
    blocks = [dashboard("cards")];
    results.push([header("cards")], [{ publishedBy: "publisher", outside: [] }]);
    await outsideDatabases("u1", ROOT);
    expect(chainTo).toHaveBeenCalledWith("publisher", "cards", ROOT);
  });

  it("names nothing while publishing is off, or for a body without databases", async () => {
    publishing = false;
    blocks = [dashboard("cards")];
    expect(await outsideDatabases("u1", ROOT)).toEqual([]);
    publishing = true;
    blocks = [{ type: "paragraph", props: {}, children: [] }];
    expect(await outsideDatabases("u1", ROOT)).toEqual([]);
    expect(chainTo).not.toHaveBeenCalled();
  });

  it("names nothing for a database, which has no body", async () => {
    blocks = [dashboard("cards")];
    expect(await outsideDatabases("u1", "cards")).toEqual([]);
  });
});

describe("setOutsideDatabases", () => {
  it("keeps only the page's outside databases", async () => {
    parents.set("inline", ROOT);
    blocks = [dashboard("cards", "inline")];
    results.push([header("cards"), header("inline")], [{ publishedBy: "u1", outside: [] }]);
    await setOutsideDatabases("u1", ROOT, ["cards", "inline", "elsewhere"]);
    expect(written).toEqual([{ outsideDatabaseIds: ["cards"] }]);
  });

  it("asks for what publishing needs", async () => {
    blocker = "notAllowed";
    await expect(setOutsideDatabases("u1", ROOT, ["cards"])).rejects.toThrow();
    expect(written).toEqual([]);
  });
});
