import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Turning a page into a teamspace (server/teamspace-from-page.ts): which pages follow the new
// teamspace's access, what the dialog counts, and the teamspace's locked top level. The moves
// themselves are checked against the database in scripts/teamspaces-e2e.ts.

type Query = { columns: Record<string, unknown>; where?: SQL };
const selects: Query[] = [];
const state = vi.hoisted(() => ({ children: [] as { id: string; title: string; kind: string; position: number; full: boolean }[] }));

/** What a select answers, by the columns it asks for. */
const answer = (columns: Record<string, unknown>) => {
  if ("full" in columns) return state.children;
  if ("count" in columns) return [{ count: state.children.length }];
  if ("access" in columns) return [{ access: "open" }];
  if ("kind" in columns) return [{ kind: "page" }];
  if ("title" in columns) return [{ title: "Parent" }];
  if ("name" in columns) return [{ name: "Old space" }];
  return [];
};

vi.mock("@/db", () => {
  const select = (columns: Record<string, unknown> = {}) => {
    const query: Query = { columns };
    selects.push(query);
    const chain = {
      from: () => chain,
      where: (where: SQL) => ((query.where = where), chain),
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(columns)).then(resolve, reject),
    };
    return chain;
  };
  const update = () => {
    const chain = { set: () => chain, where: () => Promise.resolve([]) };
    return chain;
  };
  const execute = vi.fn(async () => []);
  const tx = { select, update, execute };
  return { db: { select, update, execute, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

const access = vi.hoisted(() => ({ requirePageAccess: vi.fn() }));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("./access")>()), ...access }));

const teamspaces = vi.hoisted(() => {
  class TeamspaceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    TeamspaceError,
    canCreateTeamspace: vi.fn(async () => true),
    createTeamspaceFromPage: vi.fn(async () => ({ id: "ts-new", name: "Plans" })),
    mayArrangeTopLevel: vi.fn(async () => true),
    requireArrangeTopLevel: vi.fn(async () => {}),
    teamspaceEligible: vi.fn(async () => new Map<string, string>()),
  };
});
vi.mock("@/server/teamspaces", () => teamspaces);

const permissions = vi.hoisted(() => ({ followNewSpace: vi.fn(async () => {}), freezeInheritedEntries: vi.fn(async () => {}) }));
vi.mock("@/server/permissions", () => permissions);
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ broadcast: vi.fn(), disconnectLostAccess: vi.fn(async () => {}) }) }));
vi.mock("@/server/page-events", () => ({ pageChanged: vi.fn() }));
vi.mock("@/server/page-webhooks/queue", () => ({ queuePageMoved: vi.fn(async () => {}) }));

const { canTurnIntoTeamspace, previewTeamspaceFromPage, turnPageIntoTeamspace } = await import("./teamspace-from-page");

const render = (q: SQL) => new PgDialect().sqlToQuery(q).sql;

const plans = (extra: Record<string, unknown> = {}) => ({
  id: "p",
  workspaceId: "ws-1",
  teamspaceId: "ts-1",
  parentId: "parent" as string | null,
  kind: "page" as const,
  title: "Plans",
  icon: null,
  isTemplate: false,
  inTemplate: false,
  archivedAt: null,
  ...extra,
});

beforeEach(() => {
  selects.length = 0;
  vi.clearAllMocks();
  access.requirePageAccess.mockResolvedValue(plans());
  state.children = [
    { id: "c-mine", title: "Mine", kind: "page", position: 1, full: true },
    { id: "c-bobs", title: "Bob's", kind: "page", position: 2, full: false },
  ];
});

describe("turnPageIntoTeamspace", () => {
  it("lets a sub-page the user may not manage keep its own entries, a closed one staying closed", async () => {
    await turnPageIntoTeamspace("alice", "p");
    // Whether they have full access to each sub-page is read with the sub-pages, before anything moves.
    const children = selects.find((q) => "full" in q.columns)!;
    expect(render(children.columns.full as SQL)).toMatch(/page_access_level\(\$1, "page"\."id"\) >= \$2/);
    // Every page that moves keeps what it inherited…
    expect(permissions.freezeInheritedEntries.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["p", "c-mine", "c-bobs"]);
    // …but only the page and the sub-pages they may manage drop their "everyone" entry.
    expect(permissions.followNewSpace.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["p", "c-mine"]);
    expect(permissions.followNewSpace).toHaveBeenCalledWith(expect.anything(), "ws-1", "p", "alice", { changedSpace: true, toPrivate: false, privateTop: false });
  });

  it("refuses a top-level page of a teamspace whose top level is locked, before anything changes", async () => {
    access.requirePageAccess.mockResolvedValue(plans({ parentId: null }));
    teamspaces.requireArrangeTopLevel.mockRejectedValueOnce(new teamspaces.TeamspaceError("topLevelLocked", "locked"));
    await expect(turnPageIntoTeamspace("alice", "p")).rejects.toMatchObject({ code: "topLevelLocked" });
    expect(teamspaces.requireArrangeTopLevel).toHaveBeenCalledWith("alice", "ts-1");
    expect(teamspaces.createTeamspaceFromPage).not.toHaveBeenCalled();
    expect(permissions.followNewSpace).not.toHaveBeenCalled();
  });

  it("doesn't ask about the top level for a sub-page", async () => {
    await turnPageIntoTeamspace("alice", "p");
    expect(teamspaces.requireArrangeTopLevel).not.toHaveBeenCalled();
  });
});

describe("previewTeamspaceFromPage", () => {
  it("counts only the sub-pages the user can see", async () => {
    const preview = await previewTeamspaceFromPage("alice", "p");
    expect(preview.pages).toBe(3);
    const counted = selects.find((q) => "count" in q.columns)!;
    expect(render(counted.where!)).toMatch(/page_access_level\(\$\d+, "page"\."id"\) > 0/);
  });
});

describe("canTurnIntoTeamspace", () => {
  it("isn't offered on a top-level page of a teamspace whose top level the user may not arrange", async () => {
    teamspaces.mayArrangeTopLevel.mockResolvedValueOnce(false);
    expect(await canTurnIntoTeamspace("alice", plans({ parentId: null }), "full")).toBe(false);
    expect(teamspaces.mayArrangeTopLevel).toHaveBeenCalledWith("alice", "ts-1");
    expect(await canTurnIntoTeamspace("alice", plans({ parentId: null }), "full")).toBe(true);
    // A private top-level page has no teamspace to ask.
    vi.clearAllMocks();
    expect(await canTurnIntoTeamspace("alice", plans({ parentId: null, teamspaceId: null }), "full")).toBe(true);
    expect(teamspaces.mayArrangeTopLevel).not.toHaveBeenCalled();
  });
});
