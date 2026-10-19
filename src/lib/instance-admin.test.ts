import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEmailsFrom, canCreateWorkspace, isInstanceAdmin, workspaceCreationFrom } from "./instance-admin";

const verified = (email: string) => ({ email, emailVerified: true });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("adminEmailsFrom", () => {
  it("splits on commas, trims and lowercases", () => {
    expect([...adminEmailsFrom(" Ada@Example.com ,bob@example.com,, ")]).toEqual(["ada@example.com", "bob@example.com"]);
  });

  it("is empty when unset or blank", () => {
    expect(adminEmailsFrom(undefined).size).toBe(0);
    expect(adminEmailsFrom("").size).toBe(0);
    expect(adminEmailsFrom(" , ").size).toBe(0);
  });
});

describe("isInstanceAdmin", () => {
  const admins = adminEmailsFrom("Ada@Example.com, root@example.org");

  it("matches listed addresses case-insensitively", () => {
    expect(isInstanceAdmin(verified("ada@example.com"), admins)).toBe(true);
    expect(isInstanceAdmin(verified("ADA@EXAMPLE.COM"), admins)).toBe(true);
    expect(isInstanceAdmin(verified(" root@example.org "), admins)).toBe(true);
  });

  it("only counts verified addresses", () => {
    expect(isInstanceAdmin({ email: "ada@example.com", emailVerified: false }, admins)).toBe(false);
    expect(isInstanceAdmin({ email: "ada@example.com", emailVerified: null }, admins)).toBe(false);
    expect(isInstanceAdmin({ email: "ada@example.com" }, admins)).toBe(false);
  });

  it("refuses everyone else", () => {
    expect(isInstanceAdmin(verified("bob@example.com"), admins)).toBe(false);
    // No partial or domain matches.
    expect(isInstanceAdmin(verified("xada@example.com"), admins)).toBe(false);
    expect(isInstanceAdmin(verified("ada@example.com.evil.test"), admins)).toBe(false);
    expect(isInstanceAdmin(null, admins)).toBe(false);
    expect(isInstanceAdmin(undefined, admins)).toBe(false);
    expect(isInstanceAdmin({ emailVerified: true }, admins)).toBe(false);
  });

  it("has no admins when ADMIN_EMAILS is unset or empty", () => {
    vi.stubEnv("ADMIN_EMAILS", undefined);
    expect(isInstanceAdmin(verified("ada@example.com"))).toBe(false);
    vi.stubEnv("ADMIN_EMAILS", "");
    expect(isInstanceAdmin(verified("ada@example.com"))).toBe(false);
    vi.stubEnv("ADMIN_EMAILS", " , ");
    expect(isInstanceAdmin(verified(""))).toBe(false);
  });

  it("counts the server's first account by id, verified or not, next to ADMIN_EMAILS", () => {
    const none = adminEmailsFrom("");
    expect(isInstanceAdmin({ id: "first", email: "owner@example.com", emailVerified: false }, none, "first")).toBe(true);
    expect(isInstanceAdmin({ id: "second", email: "owner@example.com", emailVerified: true }, none, "first")).toBe(false);
    // Not by address: another account can't take it by signing up with the first one's.
    expect(isInstanceAdmin({ id: "other", email: "owner@example.com" }, none, "first")).toBe(false);
    expect(isInstanceAdmin({ email: "owner@example.com", emailVerified: true }, none, "first")).toBe(false);
    // ADMIN_EMAILS still works with a first account, and without one nobody is named by id.
    expect(isInstanceAdmin(verified("ada@example.com"), admins, "first")).toBe(true);
    expect(isInstanceAdmin({ id: "first", email: "x@example.com", emailVerified: true }, none, null)).toBe(false);
    expect(isInstanceAdmin({ id: "", email: "x@example.com" }, none, "")).toBe(false);
  });

  it("reads ADMIN_EMAILS by default", () => {
    vi.stubEnv("ADMIN_EMAILS", "Ada@Example.com");
    expect(isInstanceAdmin(verified("ada@example.com"))).toBe(true);
    expect(isInstanceAdmin({ email: "ada@example.com", emailVerified: false })).toBe(false);
  });
});

describe("workspace creation", () => {
  it("defaults to everyone", () => {
    expect(workspaceCreationFrom(undefined)).toBe("everyone");
    expect(workspaceCreationFrom("")).toBe("everyone");
    expect(workspaceCreationFrom(" Everyone ")).toBe("everyone");
  });

  it("restricts to admins, also for values it doesn't know", () => {
    expect(workspaceCreationFrom("admins")).toBe("admins");
    expect(workspaceCreationFrom("ADMINS")).toBe("admins");
    expect(workspaceCreationFrom("admin")).toBe("admins");
    expect(workspaceCreationFrom("nobody")).toBe("admins");
  });

  it("lets the first account create workspaces under `admins`", () => {
    const none = adminEmailsFrom("");
    expect(canCreateWorkspace({ id: "first", email: "owner@example.com" }, "admins", none, "first")).toBe(true);
    expect(canCreateWorkspace({ id: "second", email: "b@example.com" }, "admins", none, "first")).toBe(false);
  });

  it("lets everyone create workspaces by default, only verified admins with `admins`", () => {
    const admins = adminEmailsFrom("ada@example.com");
    expect(canCreateWorkspace(verified("bob@example.com"), "everyone", admins)).toBe(true);
    expect(canCreateWorkspace(verified("ada@example.com"), "admins", admins)).toBe(true);
    expect(canCreateWorkspace(verified("bob@example.com"), "admins", admins)).toBe(false);
    expect(canCreateWorkspace({ email: "ada@example.com", emailVerified: false }, "admins", admins)).toBe(false);
  });

  it("reads WORKSPACE_CREATION and ADMIN_EMAILS by default", () => {
    vi.stubEnv("ADMIN_EMAILS", "ada@example.com");
    vi.stubEnv("WORKSPACE_CREATION", "admins");
    expect(canCreateWorkspace(verified("ada@example.com"))).toBe(true);
    expect(canCreateWorkspace(verified("bob@example.com"))).toBe(false);
    vi.stubEnv("WORKSPACE_CREATION", undefined);
    expect(canCreateWorkspace(verified("bob@example.com"))).toBe(true);
  });
});
