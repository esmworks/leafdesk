import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestSession } from "./request-session";

/**
 * The workspace sign-in policies in the access checks (two-step verification, single sign-on only):
 * which sessions they hold back, and that they ask the database once per request and workspace.
 * The database answers from a queue, one result per query.
 */
const results: unknown[][] = [];
let queries = 0;

function chain(): unknown {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where"]) node[method] = () => node;
  node.limit = async () => {
    queries++;
    return results.shift() ?? [];
  };
  return node;
}

vi.mock("@/db", () => ({ db: { select: () => (chain() as { select: () => unknown }).select() } }));

let current: RequestSession | null = null;
vi.mock("./request-session", () => ({ requestSession: async () => current }));

const {
  AccessError,
  ConnectedAppReadOnlyError,
  getMembership,
  findMembership,
  resolvePageAccess,
  requireMembership,
  TwoFactorRequiredError,
  SsoRequiredError,
  workspacesHeldBack,
} = await import("./access");
const { asWrite, runAsConnectedApp } = await import("./connected-app");
const { authorizeCollab } = await import("./collab/authorize");

const session = (userId: string, strong: boolean, ssoProviderId: string | null = null): RequestSession => ({
  userId,
  strong,
  ssoProviderId,
  heldBack: new Map(),
});
const member = [{ role: "member" }];
/** The policy lookup's row (see policyStateOf). */
const policy = (state: { role?: string; requireTwoFactor?: boolean; loginMethod?: string | null; hasConnection?: boolean }) => [
  { role: "member", requireTwoFactor: false, loginMethod: null, hasConnection: false, ...state },
];
const applies = policy({ requireTwoFactor: true });
const relaxed = policy({});
const ssoOnly = policy({ loginMethod: "sso", hasConnection: true });
const visiblePage = [{ id: "p1", workspaceId: "ws1", title: "Plan", level: 1 }];

beforeEach(() => {
  results.length = 0;
  queries = 0;
  current = null;
});

describe("the two-step policy in access checks", () => {
  it("leaves requests without a browser session alone (collab server, scripts, MCP)", async () => {
    results.push(member);
    expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
    expect(queries).toBe(1);
  });

  it("holds back a session that doesn't pass, once per request and workspace", async () => {
    current = session("u1", false);
    results.push(member, applies);
    await expect(getMembership("u1", "ws1")).rejects.toBeInstanceOf(TwoFactorRequiredError);
    results.push(member);
    const error = await requireMembership("u1", "ws1").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "TwoFactorRequiredError", workspaceId: "ws1", hold: "two-factor" });
    expect(queries).toBe(3); // two memberships, one policy lookup
  });

  it("lets sessions through that pass, or where the workspace doesn't require it", async () => {
    current = session("u1", true);
    results.push(member, applies);
    expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
    current = session("u1", false);
    results.push(member, relaxed);
    expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
  });

  it("doesn't apply to questions about other people", async () => {
    current = session("u1", false);
    results.push(member);
    expect(await getMembership("u2", "ws1")).toEqual({ role: "member" });
    expect(queries).toBe(1);
  });

  it("leaves findMembership (the policy's own lookups) alone", async () => {
    current = session("u1", false);
    results.push(member);
    expect(await findMembership("u1", "ws1")).toEqual({ role: "member" });
  });

  it("holds back pages only when they are visible, so nothing leaks about the others", async () => {
    current = session("u1", false);
    results.push([{ ...visiblePage[0], level: 0 }]);
    expect((await resolvePageAccess("u1", "p1")).level).toBe("none");
    results.push(visiblePage, applies);
    await expect(resolvePageAccess("u1", "p1")).rejects.toMatchObject({ workspaceId: "ws1" });
  });

  it("names the workspaces a list has to leave out", async () => {
    current = session("u1", false);
    results.push(applies, relaxed);
    expect([...(await workspacesHeldBack("u1", ["ws1", "ws2", "ws1"]))]).toEqual(["ws1"]);
  });
});

describe("the single sign-on policy in access checks", () => {
  it("holds back a member who didn't sign in through the workspace's identity provider", async () => {
    current = session("u1", true);
    results.push(member, ssoOnly);
    const error = await getMembership("u1", "ws1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsoRequiredError);
    expect(error).toMatchObject({ workspaceId: "ws1", hold: "sso" });
  });

  it("lets through a session from the workspace's own connection, not another's", async () => {
    current = session("u1", false, "ws-ws1");
    results.push(member, ssoOnly);
    expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
    current = session("u1", false, "ws-ws2");
    results.push(member, ssoOnly);
    await expect(getMembership("u1", "ws1")).rejects.toBeInstanceOf(SsoRequiredError);
  });

  it("exempts owners and guests", async () => {
    current = session("u1", false);
    results.push([{ role: "owner" }], policy({ role: "owner", loginMethod: "sso", hasConnection: true }));
    expect(await getMembership("u1", "ws1")).toEqual({ role: "owner" });
    current = session("u1", false);
    results.push([{ role: "guest" }], policy({ role: "guest", loginMethod: "sso", hasConnection: true }));
    expect(await getMembership("u1", "ws1")).toEqual({ role: "guest" });
  });

  it("does nothing while no identity provider can sign members in", async () => {
    current = session("u1", false);
    results.push(member, policy({ loginMethod: "sso", hasConnection: false }));
    expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
  });

  it("asks for two-step verification first when both apply", async () => {
    current = session("u1", false);
    results.push(member, policy({ requireTwoFactor: true, loginMethod: "sso", hasConnection: true }));
    await expect(getMembership("u1", "ws1")).rejects.toBeInstanceOf(TwoFactorRequiredError);
  });
});

describe("collab connections", () => {
  it("need a session that passes when the workspace requires it", async () => {
    results.push(visiblePage, applies);
    await expect(authorizeCollab("u1", { kind: "page", id: "p1" })).rejects.toBeInstanceOf(TwoFactorRequiredError);
    results.push(visiblePage, applies);
    expect(await authorizeCollab("u1", { kind: "page", id: "p1" }, { strong: true, ssoProviderId: null })).toEqual({
      readOnly: true,
    });
    results.push(member, applies);
    await expect(authorizeCollab("u1", { kind: "ws", id: "ws1" })).rejects.toBeInstanceOf(TwoFactorRequiredError);
    results.push(member, relaxed);
    expect(await authorizeCollab("u1", { kind: "ws", id: "ws1" })).toEqual({ readOnly: true });
  });

  it("open signal documents read-only, even for people who may edit", async () => {
    const editable = [{ ...visiblePage[0], level: 4 }];
    results.push(editable, relaxed);
    expect(await authorizeCollab("u1", { kind: "page", id: "p1" })).toEqual({ readOnly: false });
    results.push(editable, relaxed);
    expect(await authorizeCollab("u1", { kind: "db", id: "p1" })).toEqual({ readOnly: true });
    results.push(member, relaxed);
    expect(await authorizeCollab("u1", { kind: "ws", id: "ws1" })).toEqual({ readOnly: true });
  });

  it("need a single sign-on session in an SSO-only workspace", async () => {
    results.push(member, ssoOnly);
    await expect(authorizeCollab("u1", { kind: "ws", id: "ws1" }, { strong: true, ssoProviderId: null })).rejects.toBeInstanceOf(
      SsoRequiredError,
    );
    results.push(member, ssoOnly);
    expect(await authorizeCollab("u1", { kind: "ws", id: "ws1" }, { strong: false, ssoProviderId: "ws-ws1" })).toEqual({
      readOnly: true,
    });
  });
});

describe("the connected-apps setting in access checks", () => {
  /** The setting lookup's row (see appsModeOf). */
  const apps = (mode: string | null) => [{ mode }];

  it("hides a workspace whose owners turned connected apps off, as if the user weren't in it", async () => {
    await runAsConnectedApp({ userId: "u1" }, async () => {
      results.push(member, apps("off"));
      const error = await getMembership("u1", "ws1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessError);
      expect(error).not.toBeInstanceOf(ConnectedAppReadOnlyError);
      results.push(visiblePage);
      await expect(resolvePageAccess("u1", "p1")).rejects.toBeInstanceOf(AccessError);
      expect(queries).toBe(3); // two lookups, the setting asked once per request
    });
  });

  it("refuses writes where apps may only read, and lets reads through", async () => {
    await runAsConnectedApp({ userId: "u1" }, async () => {
      results.push(visiblePage, apps("read"));
      expect((await resolvePageAccess("u1", "p1")).level).toBe("view");
      results.push(visiblePage);
      const error = await asWrite(() => resolvePageAccess("u1", "p1")).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "ConnectedAppReadOnlyError", workspaceId: "ws1" });
      // Writes that only ask for membership (a top-level page, say) are refused the same way.
      results.push(member);
      await expect(asWrite(() => requireMembership("u1", "ws1"))).rejects.toBeInstanceOf(ConnectedAppReadOnlyError);
    });
    await runAsConnectedApp({ userId: "u1", writing: true }, async () => {
      results.push(member, apps("read"));
      await expect(getMembership("u1", "ws1")).rejects.toBeInstanceOf(ConnectedAppReadOnlyError);
    });
  });

  it("lets everything through with full access, the default", async () => {
    await runAsConnectedApp({ userId: "u1", writing: true }, async () => {
      results.push(member, apps(null));
      expect(await getMembership("u1", "ws1")).toEqual({ role: "member" });
      results.push(member, apps("full"));
      expect(await getMembership("u1", "ws2")).toEqual({ role: "member" });
    });
  });

  it("doesn't apply outside connected-app requests, nor to checks on other people", async () => {
    results.push(member);
    expect(await asWrite(() => getMembership("u1", "ws1"))).toEqual({ role: "member" });
    await runAsConnectedApp({ userId: "u1", writing: true }, async () => {
      results.push(member);
      expect(await getMembership("u2", "ws1")).toEqual({ role: "member" });
    });
    expect(queries).toBe(2);
  });

  it("names the workspaces a list across workspaces has to leave out", async () => {
    await runAsConnectedApp({ userId: "u1" }, async () => {
      results.push(apps("off"), apps("read"), apps(null));
      expect([...(await workspacesHeldBack("u1", ["ws1", "ws2", "ws3"]))]).toEqual(["ws1"]);
    });
  });
});
