import { describe, expect, it } from "vitest";
import { cleanSidebarLayout, sidebarOrder, withSection } from "./sidebar-sections";

describe("sidebarOrder", () => {
  it("starts from the default order", () => {
    expect(sidebarOrder({})).toEqual(["favorites", "pages", "teamspaces", "shared", "private", "agents"]);
  });

  it("follows the saved order and appends the sections it leaves out", () => {
    expect(sidebarOrder({ order: ["private", "pages", "teamspaces"] })).toEqual(["private", "pages", "teamspaces", "favorites", "shared", "agents"]);
  });

  it("puts pages just above the teamspaces when the saved order doesn't list it", () => {
    expect(sidebarOrder({ order: ["private", "teamspaces"] })).toEqual(["private", "pages", "teamspaces", "favorites", "shared", "agents"]);
    expect(sidebarOrder({ order: ["teamspaces", "pages"] })).toEqual(["teamspaces", "pages", "favorites", "shared", "private", "agents"]);
  });

  it("puts a section added since an order was saved after the sections it lists", () => {
    expect(sidebarOrder({ order: ["favorites", "pages", "teamspaces", "shared", "private"] })).toEqual(["favorites", "pages", "teamspaces", "shared", "private", "agents"]);
  });

  it("drops the sections that moved to the rail from orders saved with them", () => {
    expect(sidebarOrder({ order: ["tasks", "private", "meetings"] } as never)).toEqual(["private", "favorites", "pages", "teamspaces", "shared", "agents"]);
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
