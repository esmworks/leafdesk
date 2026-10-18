import { describe, expect, it } from "vitest";
import { cleanSidebarLayout, sidebarOrder, withSection } from "./sidebar-sections";

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
});

describe("cleanSidebarLayout", () => {
  it("keeps known sections once and drops the rest", () => {
    expect(cleanSidebarLayout({ order: ["private", "nope", "private"], folded: ["teamspaces"], extra: 1 })).toEqual({
      order: ["private"],
      folded: ["teamspaces"],
    });
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
