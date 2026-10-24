import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/access";

/**
 * The check's logic over a made-up workspace. The queries themselves (and the access they check)
 * run against Postgres in scripts/workspace-check-e2e.ts; here the database answers each query by
 * what it selects, and `inArray` filters are honoured so lookups only see the ids they ask for.
 */

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  inArray: (_column: unknown, values: string[]) => ({ inArrayValues: values }),
}));

type Row = Record<string, unknown>;
const world = vi.hoisted(() => ({
  pages: [] as Row[],
  linked: [] as string[],
  levels: {} as Record<string, number>,
  markdown: {} as Record<string, string>,
  existing: [] as Row[],
  rows: [] as Row[],
  vectors: [] as { page_id: string; vector: number[] }[],
}));

vi.mock("@/db", () => {
  const sqlText = (query: { queryChunks?: unknown[] }) =>
    (query.queryChunks ?? []).map((c) => (c && typeof c === "object" && "value" in c ? String((c as { value: unknown }).value) : "")).join(" ");
  const chain = (answer: (ids: string[] | null) => Row[]) => {
    let ids: string[] | null = null;
    const c = {
      from: () => c,
      leftJoin: () => c,
      orderBy: () => c,
      limit: () => c,
      where: (cond: { inArrayValues?: string[] }) => {
        if (cond?.inArrayValues) ids = cond.inArrayValues;
        return c;
      },
      then: (ok: (rows: Row[]) => unknown, fail: (e: unknown) => unknown) => Promise.resolve().then(() => answer(ids)).then(ok, fail),
    };
    return c;
  };
  const only = (rows: Row[], ids: string[] | null) => (ids ? rows.filter((r) => ids.includes(r.id as string)) : rows);
  return {
    db: {
      select: (fields: Record<string, unknown>) => {
        const keys = Object.keys(fields).sort().join(",");
        if ("emptyBody" in fields) return chain(() => world.pages);
        if (keys === "id,level") return chain((ids) => only(world.pages, ids).map((p) => ({ id: p.id, level: world.levels[p.id as string] ?? 1 })));
        if (keys === "id,markdown") return chain((ids) => (ids ?? []).map((id) => ({ id, markdown: world.markdown[id] ?? "" })));
        if (keys === "icon,id,level,title") return chain((ids) => only(world.existing, ids));
        if (keys === "createdBy,id,parentId,properties") return chain((ids) => only(world.rows, ids));
        throw new Error(`unexpected select ${keys}`);
      },
      execute: async (query: { queryChunks?: unknown[] }) => {
        const text = sqlText(query);
        if (text.includes("page_link")) return world.linked.map((target_id) => ({ target_id }));
        if (text.includes("unnest")) return world.vectors;
        throw new Error(`unexpected query ${text}`);
      },
    },
  };
});

const access = vi.hoisted(() => ({ getMembership: vi.fn(), requirePageAccess: vi.fn() }));
vi.mock("@/server/access", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/access")>()), ...access }));

// Page refs as server/mentions resolves them: in the trash (and visible) or gone read "deleted",
// a page the user can't open reads "noAccess" whatever became of it.
const mentions = vi.hoisted(() => ({
  status: {} as Record<string, "ok" | "deleted" | "noAccess">,
  resolvePageRefs: vi.fn(),
  listUnlinkedMentions: vi.fn(),
}));
vi.mock("@/server/mentions", () => ({
  resolvePageRefs: mentions.resolvePageRefs,
  listUnlinkedMentions: mentions.listUnlinkedMentions,
}));

const ai = vi.hoisted(() => ({ embeddingsEnabled: vi.fn(() => true), embeddingModelFor: vi.fn(async (_workspaceId: string): Promise<string | null> => "test") }));
vi.mock("@/server/ai", () => ai);
const workspaces = vi.hoisted(() => ({ workspaceSettings: vi.fn(async () => ({}) as { ai?: boolean }) }));
vi.mock("@/server/workspaces", () => workspaces);
const derived = vi.hoisted(() => ({ loadProperties: vi.fn() }));
vi.mock("@/server/derived", () => derived);
const propertyAccess = vi.hoisted(() => ({ propertyAccessFor: vi.fn() }));
vi.mock("@/server/property-access", () => propertyAccess);
const databases = vi.hoisted(() => ({ updateRowProperties: vi.fn() }));
vi.mock("@/server/databases", () => databases);
const verification = vi.hoisted(() => ({ expiredVerifications: vi.fn(async (): Promise<{ id: string; by: string | null; until: string }[]> => []) }));
vi.mock("@/server/verification", () => verification);

const { checkWorkspace, removeRelationTarget } = await import("./workspace-check");

const NOW = new Date("2026-10-17T12:00:00Z");
const RECENT = new Date("2026-10-01T00:00:00Z");
const OLD = new Date("2025-01-01T00:00:00Z");

const pageRow = (id: string, over: Row = {}): Row => ({
  id,
  title: id[0].toUpperCase() + id.slice(1),
  icon: null,
  kind: "page",
  parentId: null,
  parentKind: null,
  isSkill: false,
  updatedAt: RECENT,
  emptyBody: false,
  hasRefs: false,
  hasChildren: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  access.getMembership.mockResolvedValue({ role: "member" });
  ai.embeddingsEnabled.mockReturnValue(true);
  ai.embeddingModelFor.mockResolvedValue("test");
  workspaces.workspaceSettings.mockResolvedValue({});
  world.pages = [
    pageRow("roadmap", { hasRefs: true }),
    pageRow("notes", { hasChildren: true }),
    pageRow("old", { parentId: "notes", parentKind: "page", updatedAt: OLD }),
    pageRow("loose"),
    pageRow("blank", { emptyBody: true }),
    pageRow("skill", { isSkill: true }),
    pageRow("tasks", { kind: "database", hasChildren: true }),
    pageRow("r1", { parentId: "tasks", parentKind: "database", emptyBody: true }),
    pageRow("r2", { parentId: "tasks", parentKind: "database", emptyBody: true }),
  ];
  world.linked = ["notes"];
  world.levels = { roadmap: 3, loose: 1, blank: 3, r1: 3, trashed: 3, trashedRow: 1 };
  world.markdown = {
    roadmap: [
      "[page](/w/ws/p/notes)",
      "[page](/w/ws/p/trashed)",
      "[page](/w/ws/p/gone)",
      "[page](/w/ws/p/secret)",
      "[page](/w/ws/p/roadmap)",
      "```",
      "[page](/w/ws/p/fenced)",
      "```",
    ].join("\n"),
  };
  mentions.status = { trashed: "deleted", gone: "deleted", fenced: "deleted", secret: "noAccess", trashedRow: "deleted", goneRow: "deleted" };
  mentions.resolvePageRefs.mockImplementation(async (_user: string, ids: string[]) =>
    ids.map((id) => ({ id, status: mentions.status[id] ?? "ok" })),
  );
  mentions.listUnlinkedMentions.mockImplementation(async (_user: string, id: string) =>
    id === "loose" ? [{ id: "notes", title: "Notes", icon: null, canEdit: false }, { id: "roadmap", title: "Roadmap", icon: "🗺", canEdit: true }] : [],
  );
  world.existing = [
    { id: "trashed", title: "Old plan", icon: "📄", level: 3 },
    { id: "trashedRow", title: "Done task", icon: null, level: 1 },
  ];
  derived.loadProperties.mockResolvedValue(
    new Map([
      [
        "tasks",
        [
          { id: "prop-rel", name: "Blocked by", type: "relation" },
          { id: "prop-text", name: "Notes", type: "text" },
          { id: "prop-hidden", name: "Secret link", type: "relation" },
        ],
      ],
    ]),
  );
  world.rows = [
    { id: "r1", parentId: "tasks", properties: { "prop-rel": ["r2", "trashedRow", "goneRow"], "prop-hidden": ["goneRow"] }, createdBy: null },
    { id: "r2", parentId: "tasks", properties: { "prop-rel": ["trashedRow"] }, createdBy: null },
  ];
  propertyAccess.propertyAccessFor.mockResolvedValue({
    levelOf: (propertyId: string, row: { id: string }) =>
      propertyId === "prop-hidden" ? "view_property" : row.id === "r2" ? "view" : "edit_values",
  });
  world.vectors = [
    { page_id: "roadmap", vector: [1, 0, 0] },
    { page_id: "loose", vector: [0.99, 0.05, 0] },
    { page_id: "notes", vector: [0, 1, 0] },
  ];
});

describe("checkWorkspace", () => {
  it("is for owners and members: guests and outsiders are refused", async () => {
    access.getMembership.mockResolvedValueOnce({ role: "guest" });
    await expect(checkWorkspace("u", "ws")).rejects.toBeInstanceOf(AccessError);
    access.getMembership.mockResolvedValueOnce(null);
    await expect(checkWorkspace("u", "ws")).rejects.toBeInstanceOf(AccessError);
  });

  it("finds links to pages in the trash or deleted, never to pages the user can't open", async () => {
    const check = await checkWorkspace("u", "ws", { now: NOW });
    expect(check.brokenLinks.total).toBe(2);
    expect(check.brokenLinks.items.map((f) => f.target)).toEqual([
      { id: "trashed", status: "trash", title: "Old plan", icon: "📄", canRestore: true },
      { id: "gone", status: "deleted" },
    ]);
    expect(check.brokenLinks.items[0].source).toMatchObject({ id: "roadmap", canEdit: true });
    // Fenced code isn't a link, and the hidden page is neither named nor counted.
    expect(JSON.stringify(check)).not.toContain("secret");
    expect(JSON.stringify(check)).not.toContain("fenced");
  });

  it("lists top-level pages nothing leads to, with a page that could link them", async () => {
    const { orphans } = await checkWorkspace("u", "ws", { now: NOW });
    // roadmap: no link to it either; notes is linked and has pages inside; blank is empty; skills aren't.
    expect(orphans.items.map((p) => p.id)).toEqual(["roadmap", "loose"]);
    expect(orphans.items[1]).toMatchObject({ canEdit: false, linkFrom: { id: "roadmap", title: "Roadmap", icon: "🗺" } });
    expect(orphans.items[0].linkFrom).toBeUndefined();
  });

  it("lists empty pages (not rows) and pages untouched for the months asked, oldest first", async () => {
    const check = await checkWorkspace("u", "ws", { now: NOW, staleMonths: 12 });
    expect(check.empty.items).toEqual([{ id: "blank", title: "Blank", icon: null, kind: "page", canEdit: true }]);
    expect(check.stale.items.map((p) => [p.id, p.updatedAt])).toEqual([["old", OLD.toISOString()]]);
    expect(check.staleMonths).toBe(12);
    const recent = await checkWorkspace("u", "ws", { now: new Date("2025-03-01T00:00:00Z"), staleMonths: 3 });
    expect(recent.stale.total).toBe(0);
  });

  it("lists pages whose verification ended, of the pages it looked at", async () => {
    verification.expiredVerifications.mockResolvedValue([
      { id: "old", by: "Ada", until: "2026-09-01T00:00:00.000Z" },
      // One the check didn't look at (a template, the trash, past its cap) stays out.
      { id: "elsewhere", by: null, until: "2026-09-02T00:00:00.000Z" },
    ]);
    const { expiredVerifications } = await checkWorkspace("u", "ws", { now: NOW });
    expect(expiredVerifications).toEqual({ items: [expect.objectContaining({ id: "old", kind: "page", by: "Ada", until: "2026-09-01T00:00:00.000Z" })], total: 1 });
  });

  it("pairs pages whose meaning is nearly the same", async () => {
    const { duplicates } = await checkWorkspace("u", "ws", { now: NOW });
    expect(duplicates).toMatchObject({ status: "done", compared: 3, total: 1 });
    if (duplicates.status !== "done") throw new Error("not checked");
    expect([duplicates.items[0].a.id, duplicates.items[0].b.id]).toEqual(["roadmap", "loose"]);
    expect(duplicates.items[0].similarity).toBeGreaterThan(0.99);
  });

  it("skips duplicates without an embeddings model, or with AI off in the workspace", async () => {
    ai.embeddingsEnabled.mockReturnValue(false);
    expect((await checkWorkspace("u", "ws")).duplicates).toEqual({ status: "skipped", reason: "noEmbeddings" });
    ai.embeddingsEnabled.mockReturnValue(true);
    workspaces.workspaceSettings.mockResolvedValue({ ai: false });
    expect((await checkWorkspace("u", "ws")).duplicates).toEqual({ status: "skipped", reason: "aiOff" });
  });

  it("finds relations to rows in the trash or deleted, in properties the user sees, and says who may fix them", async () => {
    const { brokenRelations } = await checkWorkspace("u", "ws", { now: NOW });
    expect(
      brokenRelations.items.map((f) => [f.row.id, f.property.name, f.target.id, f.target.status, f.canFix]),
    ).toEqual([
      ["r1", "Blocked by", "trashedRow", "trash", true],
      ["r1", "Blocked by", "goneRow", "deleted", true],
      // Only "view" on r2's property: it can't be changed there.
      ["r2", "Blocked by", "trashedRow", "trash", false],
    ]);
    expect(brokenRelations.items[0]).toMatchObject({
      database: { id: "tasks", title: "Tasks" },
      target: { title: "Done task", canRestore: false },
    });
  });

  it("checks no more than its cap of pages and says so", async () => {
    const { MAX_CHECKED_PAGES } = await import("@/lib/workspace-check");
    world.pages = Array.from({ length: MAX_CHECKED_PAGES + 1 }, (_, i) => pageRow(`p${i}`));
    world.markdown = {};
    const check = await checkWorkspace("u", "ws", { now: NOW });
    expect(check).toMatchObject({ pages: MAX_CHECKED_PAGES, truncated: true });
  }, 30_000);
});

describe("removeRelationTarget", () => {
  it("keeps the relation's other rows, hidden ones included", async () => {
    access.requirePageAccess.mockResolvedValue({ properties: { rel: ["a", "dead", "hidden"] } });
    expect(await removeRelationTarget("u", "row", "rel", "dead")).toBe(true);
    expect(access.requirePageAccess).toHaveBeenCalledWith("u", "row", "edit");
    expect(databases.updateRowProperties).toHaveBeenCalledWith("u", "row", { rel: ["a", "hidden"] });
  });

  it("changes nothing when the relation no longer holds the row", async () => {
    access.requirePageAccess.mockResolvedValue({ properties: { rel: ["a"] } });
    expect(await removeRelationTarget("u", "row", "rel", "dead")).toBe(false);
    expect(databases.updateRowProperties).not.toHaveBeenCalled();
  });
});
