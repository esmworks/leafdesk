import { describe, expect, it } from "vitest";
import { cleanSidebarLayout, inTeamspaceOrder, MAX_TEAMSPACE_ORDER, moveTeamspace, sidebarOrder, withSection } from "./sidebar-sections";

describe("sidebarOrder", () => {
  it("starts from the default order", () => {
    expect(sidebarOrder({})).toEqual(["favorites", "pages", "teamspaces", "shared", "private"]);
  });

  it("follows the saved order and appends the sections it leaves out", () => {
    expect(sidebarOrder({ order: ["private", "pages", "teamspaces"] })).toEqual(["private", "pages", "teamspaces", "favorites", "shared"]);
  });

  it("puts pages just above the teamspaces when the saved order doesn't list it", () => {
    expect(sidebarOrder({ order: ["private", "teamspaces"] })).toEqual(["private", "pages", "teamspaces", "favorites", "shared"]);
    expect(sidebarOrder({ order: ["teamspaces", "pages"] })).toEqual(["teamspaces", "pages", "favorites", "shared", "private"]);
  });

  it("puts a section added since an order was saved after the sections it lists", () => {
    expect(sidebarOrder({ order: ["favorites", "pages", "teamspaces", "shared"] })).toEqual(["favorites", "pages", "teamspaces", "shared", "private"]);
  });

  it("drops the sections that moved to the rail from orders saved with them", () => {
    expect(sidebarOrder({ order: ["tasks", "private", "meetings", "agents"] } as never)).toEqual(["private", "favorites", "pages", "teamspaces", "shared"]);
    expect(cleanSidebarLayout({ order: ["tasks", "favorites"], hidden: ["meetings"] })).toEqual({ order: ["favorites"], hidden: [] });
  });
});

describe("cleanSidebarLayout", () => {
  it("keeps known sections once and drops the rest", () => {
    expect(cleanSidebarLayout({ order: ["private", "nope", "private"], folded: ["teamspaces"], extra: 1 })).toEqual({
      order: ["private"],
      folded: ["teamspaces"],
    });
  });

  it("keeps the agents' arrangement, cleaned", () => {
    expect(cleanSidebarLayout({ agents: { groups: [{ id: "g", name: "Sales", agents: ["a", "a"] }], loose: ["b"] } })).toEqual({
      agents: { groups: [{ id: "g", name: "Sales", agents: ["a"] }], loose: ["b"] },
    });
    expect(cleanSidebarLayout({ agents: "groups" })).toBeNull();
  });

  it("rejects what isn't a layout", () => {
    expect(cleanSidebarLayout(null)).toBeNull();
    expect(cleanSidebarLayout([])).toBeNull();
    expect(cleanSidebarLayout({ hidden: "private" })).toBeNull();
  });
});

describe("withSection", () => {
  it("adds and removes a section", () => {
    const folded = withSection({}, "folded", "private", true);
    expect(folded).toEqual({ folded: ["private"] });
    expect(withSection(folded, "folded", "private", true)).toEqual({ folded: ["private"] });
    expect(withSection(folded, "folded", "private", false)).toEqual({ folded: [] });
  });
});

describe("teamspace order", () => {
  const spaces = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((s) => s.id);

  it("puts the saved ones first, in their order, the rest after as they came", () => {
    expect(ids(inTeamspaceOrder(spaces, undefined))).toEqual(["a", "b", "c", "d"]);
    expect(ids(inTeamspaceOrder(spaces, ["c", "gone", "a"]))).toEqual(["c", "a", "b", "d"]);
  });

  it("moves one to a place counted before the move", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveTeamspace(order, "a", 0)).toEqual(order);
    expect(moveTeamspace(order, "a", 1)).toEqual(order);
    expect(moveTeamspace(order, "a", 2)).toEqual(["b", "a", "c", "d"]);
    expect(moveTeamspace(order, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(moveTeamspace(order, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTeamspace(order, "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(moveTeamspace(order, "b", -3)).toEqual(["b", "a", "c", "d"]);
    expect(moveTeamspace(order, "b", 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveTeamspace(order, "x", 0)).toBe(order);
  });

  it("keeps saved ids that are text, once each, up to the limit", () => {
    expect(cleanSidebarLayout({ teamspaces: ["a", 3, "", "a", "b"] })).toEqual({ teamspaces: ["a", "b"] });
    expect(cleanSidebarLayout({ teamspaces: "a" })).toBeNull();
    const many = Array.from({ length: MAX_TEAMSPACE_ORDER + 5 }, (_, i) => `t${i}`);
    expect(cleanSidebarLayout({ teamspaces: many })?.teamspaces).toHaveLength(MAX_TEAMSPACE_ORDER);
  });
});
