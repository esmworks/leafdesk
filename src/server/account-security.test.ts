import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

/** What forgetUnprovenHolder deletes in its transaction: the table and the condition. */
const deleted: { table: unknown; where: SQL | undefined }[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => (chain() as { select: () => unknown }).select(),
    transaction: async (work: (tx: unknown) => Promise<void>) =>
      work({
        delete: (table: unknown) => ({ where: async (where?: SQL) => void deleted.push({ table, where }) }),
        update: () => ({ set: () => ({ where: async () => {} }) }),
      }),
  },
}));
vi.mock("@/server/api/tokens", () => ({ revokeAllApiTokens: vi.fn(async () => {}) }));
vi.mock("@/server/mcp/grants", () => ({ revokeAllConnectedApps: vi.fn(async () => {}) }));

const { collabSessionFacts, forgetUnprovenHolder } = await import("./account-security");
const { account, passkey, twoFactor } = await import("@/db/schema");

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

describe("forgetUnprovenHolder", () => {
  const render = (where: SQL | undefined) => (where ? new PgDialect().sqlToQuery(where) : null);

  beforeEach(() => {
    deleted.length = 0;
  });

  it("removes the earlier holder's provider and SSO logins, keeping the password and the proving login", async () => {
    await forgetUnprovenHolder("u1", "github-1");
    expect(deleted.map((d) => d.table)).toEqual([account, passkey, twoFactor]);
    const logins = render(deleted[0].where);
    expect(logins?.sql).toBe('("account"."user_id" = $1 and "account"."provider_id" <> $2 and "account"."id" <> $3)');
    expect(logins?.params).toEqual(["u1", "credential", "github-1"]);
  });

  it("removes every provider login when an emailed link proved the address", async () => {
    await forgetUnprovenHolder("u1");
    const logins = render(deleted[0].where);
    expect(logins?.sql).toBe('("account"."user_id" = $1 and "account"."provider_id" <> $2)');
    expect(logins?.params).toEqual(["u1", "credential"]);
  });
});
