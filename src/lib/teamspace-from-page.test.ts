import { describe, expect, it } from "vitest";
import { accessFromPlace, teamspaceFromShares } from "./teamspace-from-page";

describe("teamspaceFromShares", () => {
  it("makes full access owners and edit access members, and leaves the rest their entries", () => {
    const plan = teamspaceFromShares(
      "me",
      [
        { userId: "ann", level: "full", eligible: true },
        { userId: "bo", level: "edit", eligible: true },
        { userId: "cy", level: "comment", eligible: true },
        { userId: "di", level: "view", eligible: true },
        { userId: "guest", level: "edit", eligible: false },
        { userId: "nobody", level: "none", eligible: true },
      ],
      [
        { groupId: "g-edit", level: "edit" },
        { groupId: "g-full", level: "full" },
        { groupId: "g-view", level: "view" },
      ],
    );
    expect(plan).toEqual({
      owners: ["me", "ann"],
      members: ["bo"],
      groupIds: ["g-edit", "g-full"],
      kept: ["cy", "di", "guest"],
    });
  });

  it("keeps whoever turns the page an owner once, whatever they are named with", () => {
    expect(teamspaceFromShares("me", [{ userId: "me", level: "edit", eligible: true }], []).owners).toEqual(["me"]);
    expect(teamspaceFromShares("me", [{ userId: "me", level: "full", eligible: true }], [])).toEqual({
      owners: ["me"],
      members: [],
      groupIds: [],
      kept: [],
    });
  });
});

describe("accessFromPlace", () => {
  it("keeps the teamspace as open as the page was", () => {
    expect(accessFromPlace(null)).toBe("private");
    expect(accessFromPlace("private")).toBe("private");
    expect(accessFromPlace("closed")).toBe("closed");
    expect(accessFromPlace("open")).toBe("open");
    expect(accessFromPlace("default")).toBe("open");
  });
});
