import { describe, expect, it } from "vitest";
import { contentRole, exportReach, isWorkspaceRole, managesPeople, mayChangeRole, mayDeleteForever, mayExport, mayRemove, ROLE_ORDER, WORKSPACE_ROLES } from "./workspace-roles";

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

describe("keeping exports and deleting for good to owners", () => {
  it("lets everyone in export by default, nobody when export is off", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(mayExport({ export: true, exportBy: "everyone" }, role)).toBe(true);
      expect(mayExport({ export: false, exportBy: "everyone" }, role)).toBe(false);
      expect(mayExport({ export: false, exportBy: "owners" }, role)).toBe(false);
    }
    expect(mayExport({ export: true, exportBy: "everyone" }, null)).toBe(false);
  });

  it("keeps exports to owners when they say so: membership admins are no owners", () => {
    const settings = { export: true, exportBy: "owners" } as const;
    expect(WORKSPACE_ROLES.filter((role) => mayExport(settings, role))).toEqual(["owner"]);
  });

  it("lets the others print single pages only, and owners everything, with \"pages\"", () => {
    const settings = { export: true, exportBy: "pages" } as const;
    expect(WORKSPACE_ROLES.map((role) => exportReach(settings, role))).toEqual(["all", "page", "page", "page"]);
    expect(WORKSPACE_ROLES.filter((role) => mayExport(settings, role))).toEqual(["owner"]);
    expect(exportReach({ export: false, exportBy: "pages" }, "member")).toBe("none");
    expect(exportReach(settings, null)).toBe("none");
    expect(exportReach({ export: true, exportBy: "owners" }, "member")).toBe("none");
  });

  it("keeps deleting for good to owners when they say so", () => {
    expect(WORKSPACE_ROLES.every((role) => mayDeleteForever({ deleteForever: "full_access" }, role))).toBe(true);
    expect(WORKSPACE_ROLES.filter((role) => mayDeleteForever({ deleteForever: "owners" }, role))).toEqual(["owner"]);
    expect(mayDeleteForever({ deleteForever: "full_access" }, null)).toBe(false);
  });
});
