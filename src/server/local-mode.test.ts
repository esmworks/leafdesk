import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In local mode every function here answers before reading anything: any use of the database fails.
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_, key) {
        throw new Error(`The database was used (db.${String(key)})`);
      },
    },
  ),
}));

const { env } = await import("@/lib/env");
const { visibleSettingsTabs } = await import("@/lib/settings-tabs");
const { AccessError } = await import("./access");
const accessRequests = await import("./access-requests");
const allowedDomains = await import("./allowed-domains");
const forms = await import("./forms");
const groups = await import("./groups");
const joinRequests = await import("./join-requests");
const { LocalModeError, refuseInLocalMode } = await import("./local-mode");
const { mailStatus } = await import("./mail");
const publication = await import("./publication");
const push = await import("./push");
const scim = await import("./scim");
const site = await import("./site");
const sso = await import("./sso");
const teamspaces = await import("./teamspaces");
const workspaces = await import("./workspaces");

const VAPID = {
  VAPID_PUBLIC_KEY: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  VAPID_PRIVATE_KEY: "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls",
  VAPID_SUBJECT: "mailto:admin@example.com",
};

beforeEach(() => {
  vi.stubEnv("LEAFDESK_LOCAL_MODE", "1");
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env.localMode", () => {
  it("is on for 1, true and yes, and off otherwise", () => {
    for (const on of ["1", "true", "yes", " TRUE "]) {
      vi.stubEnv("LEAFDESK_LOCAL_MODE", on);
      expect(env.localMode).toBe(true);
    }
    for (const off of ["", "0", "false", "no", "local"]) {
      vi.stubEnv("LEAFDESK_LOCAL_MODE", off);
      expect(env.localMode).toBe(false);
    }
  });

  it("turns push off even with VAPID keys", () => {
    for (const [name, value] of Object.entries(VAPID)) vi.stubEnv(name, value);
    expect(env.vapid).toBeNull();
    expect(push.vapidPublicKey()).toBeNull();
    expect(push.pushStatus()).toBe("off");
    vi.stubEnv("LEAFDESK_LOCAL_MODE", "");
    expect(env.vapid?.publicKey).toBe(VAPID.VAPID_PUBLIC_KEY);
  });

  it("turns email off, also where a development server would print it", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(mailStatus()).toBe("disabled");
  });
});

describe("refuseInLocalMode", () => {
  it("throws an AccessError in local mode only", () => {
    expect(() => refuseInLocalMode()).toThrow(LocalModeError);
    expect(new LocalModeError()).toBeInstanceOf(AccessError);
    vi.stubEnv("LEAFDESK_LOCAL_MODE", "");
    expect(() => refuseInLocalMode()).not.toThrow();
  });
});

describe("in local mode the server refuses", () => {
  const refusals: [string, () => Promise<unknown>][] = [
    ["setting up SSO", () => sso.saveSsoConnection("u", "w", { protocol: "oidc", issuer: "https://id.example.com", clientId: "c", clientSecret: "s", domains: "example.com" } as never)],
    ["verifying SSO domains", () => sso.verifySsoDomains("u", "w")],
    ["removing SSO", () => sso.removeSsoConnection("u", "w")],
    ["making SCIM tokens", () => scim.createScimToken("u", "w", "IdP")],
    ["adding members", () => workspaces.addMembers("u", "w", ["someone@example.com"], "member")],
    ["adding a member through an approval", () => workspaces.addMemberAs("u", "w", "someone@example.com", "member")],
    ["turning the join link on", () => workspaces.setJoinLink("u", "w", "enable")],
    ["accepting invitations", () => workspaces.acceptInvitation("token", "u", "me@example.com")],
    ["joining with a link", () => workspaces.joinWithLink("token", "u", "me@example.com")],
    ["asking to invite", () => joinRequests.requestInvitation("u", "w", "someone@example.com", "member")],
    ["asking to join", () => joinRequests.requestToJoinFrom("w", "u", "me@example.com", "switcher")],
    ["joining from the switcher", () => joinRequests.joinFromSwitcher("u", "w")],
    ["approving join requests", () => joinRequests.approveJoinRequest("u", "w", "r")],
    ["declining join requests", () => joinRequests.declineJoinRequest("u", "w", "r")],
    ["verifying allowed domains", () => allowedDomains.verifyAllowedDomain("u", "w", "example.com")],
    ["asking for page access", () => accessRequests.requestPageAccess("u", "p", "please")],
    ["saving a site", () => site.saveSite("u", "w", { slug: "notes", title: "Notes", homePageId: null })],
    ["listing pages in the site", () => site.setSiteListing("u", "w", "p", true)],
    ["making teamspaces", () => teamspaces.createTeamspace("u", "w", { name: "Team" })],
    ["making groups", () => groups.createGroup("u", "w", "Team")],
  ];
  it.each(refusals)("%s", async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(LocalModeError);
  });

  it("bringing in guests: nobody may (canInviteGuests)", async () => {
    await expect(workspaces.inviteGuest("u", "w", "someone@example.com")).rejects.toBeInstanceOf(AccessError);
    await expect(workspaces.addGuest("u", "w", "v", "someone@example.com")).rejects.toBeInstanceOf(AccessError);
  });
});

describe("in local mode nothing is public or open to others", () => {
  it("serves no published page, site or public form", async () => {
    expect(await publication.getPublishedPage("a-token")).toBeNull();
    expect(await publication.anyPagePublished(["p"])).toBe(false);
    expect(await site.loadSite("notes")).toBeNull();
    expect(await site.servedPublication("a-token", "p")).toBeNull();
    expect(await forms.getPublicForm("a-token")).toBeNull();
    await expect(forms.submitPublicForm("a-token", { answers: {}, ticket: null } as never, { userId: null, ip: "127.0.0.1" })).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("finds no invitation, join link or workspace to join, and lets nobody invite", async () => {
    expect(await workspaces.findInvitation("a-token")).toBeNull();
    expect(await workspaces.findJoinLink("a-token")).toBeNull();
    expect(await workspaces.joinLinkAccess("a-token", "u", "me@example.com")).toBeNull();
    expect(await workspaces.canInviteGuests("u", "w")).toBe(false);
    expect(await workspaces.memberInviteAccess("u", "w")).toBeNull();
    expect(await teamspaces.canCreateTeamspace("u", "w")).toBe(false);
    expect(await joinRequests.joinableWorkspaces("u")).toEqual([]);
    expect(await joinRequests.applyDomainPolicies("u")).toEqual([]);
    expect(await accessRequests.accessRequestsOffered("w")).toBe(false);
  });

  it("offers no single sign-on", async () => {
    expect(await sso.ssoSignInAvailable()).toBe(false);
    expect(await sso.resolveSsoProvider("me@example.com")).toBeNull();
    expect(await sso.workspaceSignInProvider("w")).toBeNull();
    expect(await workspaces.ssoAvailable("w")).toBe(false);
  });

  it("answers SCIM with 404", async () => {
    const response = await scim.handleScimRequest(
      new Request("http://127.0.0.1:3000/scim/v2/Users", { headers: { authorization: "Bearer scim_whatever" } }),
    );
    expect(response.status).toBe(404);
  });

  it("leaves the guests, groups and site tabs out of Settings", () => {
    const tabs = visibleSettingsTabs({ guest: false, managesGuests: true, owner: true, localMode: true });
    expect(tabs).not.toContain("guests");
    expect(tabs).not.toContain("groups");
    expect(tabs).not.toContain("site");
    expect(tabs).toContain("members");
    expect(tabs).toContain("teamspaces");
    expect(tabs).toContain("security");
    expect(visibleSettingsTabs({ guest: false, managesGuests: true, owner: true })).toEqual(
      expect.arrayContaining(["guests", "groups", "site"]),
    );
  });
});
