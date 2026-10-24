import { describe, expect, it } from "vitest";
import { invitedTeamspaces } from "./invited-teamspaces";

describe("invitedTeamspaces", () => {
  it("keeps well-formed entries, one per teamspace, owner winning", () => {
    expect(
      invitedTeamspaces([
        { id: "a", role: "member" },
        { id: "b", role: "owner" },
        { id: "a", role: "owner" },
        { id: "b", role: "member" },
        { id: "c", role: "admin" },
      ]),
    ).toEqual([
      { id: "a", role: "owner" },
      { id: "b", role: "owner" },
      { id: "c", role: "member" },
    ]);
  });

  it("drops anything else", () => {
    expect(invitedTeamspaces(null)).toEqual([]);
    expect(invitedTeamspaces({ id: "a" })).toEqual([]);
    expect(invitedTeamspaces([null, "a", { id: "" }, { id: 3, role: "owner" }, { role: "owner" }])).toEqual([]);
  });
});
