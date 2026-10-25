import { describe, expect, it } from "vitest";
import { contentRole, isWorkspaceRole, managesPeople, mayChangeRole, mayRemove, ROLE_ORDER, WORKSPACE_ROLES } from "./workspace-roles";

describe("workspace roles", () => {
  it("knows the four roles and nothing else", () => {
    expect(WORKSPACE_ROLES).toEqual(["owner", "membership_admin", "member", "guest"]);
    expect(isWorkspaceRole("membership_admin")).toBe(true);
    expect(isWorkspaceRole("admin")).toBe(false);
    expect(isWorkspaceRole(undefined)).toBe(false);
  });

  it("treats a membership admin as a member on content", () => {
    expect(contentRole("membership_admin")).toBe("member");
    expect(contentRole("member")).toBe("member");
    expect(contentRole("owner")).toBe("owner");
    expect(contentRole("guest")).toBe("guest");
  });

  it("lets owners and membership admins manage people, nobody else", () => {
    expect(managesPeople("owner")).toBe(true);
    expect(managesPeople("membership_admin")).toBe(true);
    expect(managesPeople("member")).toBe(false);
    expect(managesPeople("guest")).toBe(false);
    expect(managesPeople(null)).toBe(false);
  });

  it("lets owners change any role", () => {
    for (const from of WORKSPACE_ROLES) for (const to of WORKSPACE_ROLES) expect(mayChangeRole("owner", from, to)).toBe(true);
  });

  it("keeps membership admins away from owners", () => {
    const others = WORKSPACE_ROLES.filter((r) => r !== "owner");
    for (const from of others) for (const to of others) expect(mayChangeRole("membership_admin", from, to)).toBe(true);
    for (const r of WORKSPACE_ROLES) {
      expect(mayChangeRole("membership_admin", "owner", r)).toBe(false);
      expect(mayChangeRole("membership_admin", r, "owner")).toBe(false);
    }
  });

  it("lets members and guests change no role", () => {
    for (const actor of ["member", "guest", null] as const) {
      for (const from of WORKSPACE_ROLES) for (const to of WORKSPACE_ROLES) expect(mayChangeRole(actor, from, to)).toBe(false);
    }
  });

  it("lets membership admins remove anyone but owners", () => {
    expect(mayRemove("membership_admin", "member")).toBe(true);
    expect(mayRemove("membership_admin", "guest")).toBe(true);
    expect(mayRemove("membership_admin", "membership_admin")).toBe(true);
    expect(mayRemove("membership_admin", "owner")).toBe(false);
    expect(mayRemove("owner", "owner")).toBe(true);
    expect(mayRemove("member", "guest")).toBe(false);
  });

  it("sorts owners, membership admins, members, guests", () => {
    expect([...WORKSPACE_ROLES].reverse().sort((a, b) => ROLE_ORDER[a] - ROLE_ORDER[b])).toEqual(WORKSPACE_ROLES);
  });
});
