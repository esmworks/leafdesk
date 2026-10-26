import { describe, expect, it, vi } from "vitest";

// The pages someone watches, for their notification settings (server/page-watch.ts listWatches):
// filtered in SQL only, so pages of a workspace whose policies hold back the session stay out.

const results = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/db", () => {
  const select = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select } };
});
const access = vi.hoisted(() => ({ workspacesHeldBack: vi.fn(async () => new Set(["ws-held"])) }));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("./access")>()), ...access }));
vi.mock("@/server/teamspaces", () => ({ getTeamspace: vi.fn(async () => ({})) }));
vi.mock("@/server/notifications", () => ({ pageRecipients: vi.fn(), recordPageUpdate: vi.fn() }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));

const { listWatches } = await import("./page-watch");

describe("listWatches", () => {
  it("leaves out the pages of workspaces whose policies hold back the session", async () => {
    const watched = (id: string, workspaceId: string) => ({ id, workspaceId, workspaceName: workspaceId, title: id, icon: null });
    results.push([watched("p-1", "ws-ok"), watched("p-2", "ws-held")], []);
    const { pages } = await listWatches("u1");
    expect(pages.map((p) => p.id)).toEqual(["p-1"]);
    expect(access.workspacesHeldBack).toHaveBeenCalledWith("u1", ["ws-ok", "ws-held"]);
  });
});
