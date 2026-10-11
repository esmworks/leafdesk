import { describe, expect, it } from "vitest";
import {
  cleanName,
  confirmsDeletion,
  confirmsWorkspaceName,
  passwordProblem,
  planAccountDeletion,
  proofKindFor,
  type WorkspaceStanding,
} from "./account";

const ws = (id: string, role: WorkspaceStanding["role"], people: number, owners: number): WorkspaceStanding => ({
  id,
  name: `WS ${id}`,
  role,
  people,
  owners,
});

describe("planAccountDeletion", () => {
  it("deletes workspaces nobody else is in, whatever the role", () => {
    const plan = planAccountDeletion([ws("a", "owner", 1, 1), ws("b", "member", 1, 0)]);
    expect(plan.deleted.map((w) => w.id)).toEqual(["a", "b"]);
    expect(plan.blockers).toEqual([]);
    expect(plan.left).toEqual([]);
  });

  it("refuses while the person is the only owner of a workspace others are in", () => {
    const plan = planAccountDeletion([ws("shared", "owner", 3, 1), ws("mine", "owner", 1, 1)]);
    expect(plan.blockers).toEqual([{ id: "shared", name: "WS shared" }]);
    // Guests count as others: a workspace can't be left to guests alone.
    expect(planAccountDeletion([ws("g", "owner", 2, 1)]).blockers.map((w) => w.id)).toEqual(["g"]);
  });

  it("leaves shared workspaces with another owner, and ones it doesn't own", () => {
    const plan = planAccountDeletion([ws("co", "owner", 4, 2), ws("m", "member", 5, 1), ws("g", "guest", 3, 1)]);
    expect(plan.left.map((w) => w.id)).toEqual(["co", "m", "g"]);
    // The role they leave with goes to each workspace's audit log.
    expect(plan.left.map((w) => w.role)).toEqual(["owner", "member", "guest"]);
    expect(plan.blockers).toEqual([]);
    expect(plan.deleted).toEqual([]);
  });
});

describe("proofKindFor", () => {
  it("asks for the password first, then a code, then a recent sign-in", () => {
    expect(proofKindFor({ hasPassword: true, twoFactorEnabled: true })).toBe("password");
    expect(proofKindFor({ hasPassword: false, twoFactorEnabled: true })).toBe("code");
    expect(proofKindFor({ hasPassword: false, twoFactorEnabled: false })).toBe("recentSignIn");
  });
});

describe("cleanName", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanName("  Ayşe   Yılmaz \n")).toEqual({ ok: true, name: "Ayşe Yılmaz" });
  });

  it("refuses empty, non-string and too long names", () => {
    expect(cleanName("   ")).toEqual({ ok: false, error: "nameRequired" });
    expect(cleanName(42)).toEqual({ ok: false, error: "nameRequired" });
    expect(cleanName("x".repeat(81))).toEqual({ ok: false, error: "nameTooLong" });
    // Counted in characters, not UTF-16 units.
    expect(cleanName("😀".repeat(80)).ok).toBe(true);
  });
});

describe("passwordProblem", () => {
  it("checks the length bounds", () => {
    expect(passwordProblem("short")).toBe("passwordTooShort");
    expect(passwordProblem(undefined)).toBe("passwordTooShort");
    expect(passwordProblem("x".repeat(129))).toBe("passwordTooLong");
    expect(passwordProblem("long enough")).toBeNull();
  });
});

describe("confirmsDeletion", () => {
  it("takes the account's email in any case, trimmed", () => {
    expect(confirmsDeletion(" Ada@Example.test ", "ada@example.test")).toBe(true);
    expect(confirmsDeletion("ada@example.tes", "ada@example.test")).toBe(false);
    expect(confirmsDeletion(null, "ada@example.test")).toBe(false);
  });
});

describe("confirmsWorkspaceName", () => {
  it("takes the workspace's name as shown, trimmed", () => {
    expect(confirmsWorkspaceName(" GNY Antalya ", "GNY Antalya")).toBe(true);
    expect(confirmsWorkspaceName("gny antalya", "GNY Antalya")).toBe(false);
    expect(confirmsWorkspaceName("GNY", "GNY Antalya")).toBe(false);
    expect(confirmsWorkspaceName(undefined, "GNY Antalya")).toBe(false);
  });

  it("matches a name however its letters are composed", () => {
    expect(confirmsWorkspaceName("Kişisel", "Kişisel")).toBe(true);
  });
});
