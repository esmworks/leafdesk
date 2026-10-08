import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session facts a collab connection is checked against. The database answers from a queue, one
 * result per query: the user's row first, then the session's.
 */
const results: unknown[][] = [];

function chain(): unknown {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from", "where"]) node[method] = () => node;
  node.limit = async () => results.shift() ?? [];
  return node;
}

vi.mock("@/db", () => ({ db: { select: () => (chain() as { select: () => unknown }).select() } }));

const { collabSessionFacts } = await import("./account-security");

const withTwoStep = [{ twoFactorEnabled: true }];
const withoutTwoStep = [{ twoFactorEnabled: false }];

beforeEach(() => {
  results.length = 0;
});

describe("collabSessionFacts", () => {
  it("reads the session the token was issued to", async () => {
    results.push(withoutTwoStep, [{ authMethod: "passkey", ssoProviderId: null }]);
    expect(await collabSessionFacts("s1", "u1")).toEqual({ strong: true, ssoProviderId: null });
    results.push(withoutTwoStep, [{ authMethod: "password", ssoProviderId: "acme" }]);
    expect(await collabSessionFacts("s1", "u1")).toEqual({ strong: false, ssoProviderId: "acme" });
  });

  it("refuses a token whose session has ended", async () => {
    results.push(withTwoStep, []);
    expect(await collabSessionFacts("revoked", "u1")).toBeNull();
    results.push(withoutTwoStep, []);
    expect(await collabSessionFacts("signed-out", "u1")).toBeNull();
  });

  it("refuses a token of an account that is gone", async () => {
    results.push([], [{ authMethod: "password", ssoProviderId: null }]);
    expect(await collabSessionFacts("s1", "u1")).toBeNull();
  });

  it("counts a token that names no session by the user alone", async () => {
    results.push(withTwoStep);
    expect(await collabSessionFacts(null, "u1")).toEqual({ strong: true, ssoProviderId: null });
    results.push(withoutTwoStep);
    expect(await collabSessionFacts(null, "u1")).toEqual({ strong: false, ssoProviderId: null });
  });
});
