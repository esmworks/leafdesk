// The OAuth consent screen: scope descriptions, safe redirect URLs and signed queries.
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { describeScope, safeHttpUrl, verifySignedAuthorizationQuery } from "./consent";

vi.mock("@/db", () => ({ db: {} }));

const SECRET = "test-secret-test-secret-test-secret";

/** Signs like the oauth-provider plugin: HMAC over the sorted parameters, sig appended. */
async function sign(params: Record<string, string | string[]>) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) query.append(k, x);
  const sorted = new URLSearchParams([...query.entries()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1)));
  query.set("sig", await makeSignature(sorted.toString(), SECRET));
  return query;
}

const future = String(Math.floor(Date.now() / 1000) + 600);

describe("verifySignedAuthorizationQuery", () => {
  it("accepts a valid signature regardless of parameter order", async () => {
    const query = await sign({ client_id: "abc", scope: "pages:read", exp: future, ba_param: ["client_id", "exp", "scope"] });
    const reordered = new URLSearchParams([...query.entries()].reverse());
    expect(await verifySignedAuthorizationQuery(reordered, SECRET)).toBe(true);
  });

  it("rejects tampering, expiry and duplicate signatures", async () => {
    const query = await sign({ client_id: "abc", scope: "pages:read", exp: future });
    const tampered = new URLSearchParams(query);
    tampered.set("client_id", "evil");
    expect(await verifySignedAuthorizationQuery(tampered, SECRET)).toBe(false);

    const expired = await sign({ client_id: "abc", exp: String(Math.floor(Date.now() / 1000) - 1) });
    expect(await verifySignedAuthorizationQuery(expired, SECRET)).toBe(false);

    const doubled = new URLSearchParams(query);
    doubled.append("sig", query.get("sig")!);
    expect(await verifySignedAuthorizationQuery(doubled, SECRET)).toBe(false);
    expect(await verifySignedAuthorizationQuery(query, "another-secret-another-secret-x")).toBe(false);
  });
});

describe("display helpers", () => {
  it("describes known scopes and passes unknown ones through", () => {
    expect(describeScope("pages:write")).toMatch(/edit/);
    expect(describeScope("custom:thing")).toBe("custom:thing");
  });

  it("only allows http(s) urls", () => {
    expect(safeHttpUrl("https://claude.ai/logo.png")).toBe("https://claude.ai/logo.png");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});
