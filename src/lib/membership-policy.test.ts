import { describe, expect, it } from "vitest";
import type { WorkspaceSettings } from "@/db/schema/app";
import {
  assignableRoles,
  automaticAccess,
  domainAccess,
  invitationApplies,
  linkAccess,
  memberInviteMode,
  onAllowedDomain,
  type Candidate,
} from "./membership-policy";

type Policy = Pick<WorkspaceSettings, "memberInvites" | "allowedDomains" | "domainJoin" | "joinRequests">;

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  memberInvites: "owners",
  allowedDomains: ["acme.com"],
  domainJoin: "join",
  joinRequests: "nobody",
  ...overrides,
});

const person = (overrides: Partial<Candidate> = {}): Candidate => ({
  email: "ada@acme.com",
  emailVerified: true,
  record: null,
  ...overrides,
});

describe("memberInviteMode", () => {
  it("lets owners add people whatever the setting", () => {
    for (const memberInvites of ["owners", "members_with_approval", "any_member"] as const) {
      expect(memberInviteMode("owner", { memberInvites })).toBe("direct");
    }
  });

  it("follows the setting for members", () => {
    expect(memberInviteMode("member", { memberInvites: "owners" })).toBe("denied");
    expect(memberInviteMode("member", { memberInvites: "members_with_approval" })).toBe("request");
    expect(memberInviteMode("member", { memberInvites: "any_member" })).toBe("direct");
  });

  it("never lets guests or outsiders add anyone", () => {
    for (const memberInvites of ["owners", "members_with_approval", "any_member"] as const) {
      expect(memberInviteMode("guest", { memberInvites })).toBe("denied");
      expect(memberInviteMode(null, { memberInvites })).toBe("denied");
    }
  });
});

describe("assignableRoles", () => {
  it("gives owners every role and members only the member role", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "member", "guest"]);
    expect(assignableRoles("member")).toEqual(["member"]);
    expect(assignableRoles("guest")).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });
});

describe("onAllowedDomain", () => {
  it("matches the domain and its subdomains, not look-alikes", () => {
    expect(onAllowedDomain("a@acme.com", policy())).toBe(true);
    expect(onAllowedDomain("a@eu.acme.com", policy())).toBe(true);
    expect(onAllowedDomain("a@ACME.COM", policy())).toBe(true);
    expect(onAllowedDomain("a@notacme.com", policy())).toBe(false);
    expect(onAllowedDomain("a@acme.com.evil.io", policy())).toBe(false);
  });

  it("matches nothing while no domain is set", () => {
    expect(onAllowedDomain("a@acme.com", policy({ allowedDomains: [] }))).toBe(false);
  });
});

describe("domainAccess", () => {
  it("lets a verified address join or ask, as the domain rule says", () => {
    expect(domainAccess(policy(), person())).toBe("join");
    expect(domainAccess(policy({ domainJoin: "request" }), person())).toBe("request");
  });

  it("offers nothing to other domains", () => {
    expect(domainAccess(policy({ joinRequests: "anyone_with_link" }), person({ email: "ada@other.org" }))).toBeNull();
  });

  it("never lets an unverified address join; it may only ask while requests are taken", () => {
    expect(domainAccess(policy(), person({ emailVerified: false }))).toBeNull();
    expect(domainAccess(policy({ joinRequests: "allowed_domains" }), person({ emailVerified: false }))).toBe("request");
  });

  it("sends someone an owner declined or removed back to asking", () => {
    expect(domainAccess(policy(), person({ record: "declined" }))).toBeNull();
    expect(domainAccess(policy({ joinRequests: "allowed_domains" }), person({ record: "declined" }))).toBe("request");
  });

  it("lets someone who left on their own come back", () => {
    expect(domainAccess(policy(), person({ record: "accepted" }))).toBe("join");
  });

  it("reports a request that waits", () => {
    expect(domainAccess(policy(), person({ record: "pending" }))).toBe("pending");
    expect(domainAccess(policy(), person({ record: "pending", emailVerified: false }))).toBe("pending");
  });
});

describe("automaticAccess", () => {
  it("acts once, for a verified address on an allowed domain", () => {
    expect(automaticAccess(policy(), person())).toBe("join");
    expect(automaticAccess(policy({ domainJoin: "request" }), person())).toBe("request");
  });

  it("does nothing for unverified addresses, other domains, or people with a record", () => {
    expect(automaticAccess(policy(), person({ emailVerified: false }))).toBeNull();
    expect(automaticAccess(policy(), person({ email: "ada@other.org" }))).toBeNull();
    for (const record of ["pending", "accepted", "declined"] as const) {
      expect(automaticAccess(policy(), person({ record }))).toBeNull();
    }
  });
});

describe("linkAccess", () => {
  const outsider = { ...person({ email: "bob@other.org" }), invited: false };

  it("admits anyone while the workspace doesn't ask for approval", () => {
    expect(linkAccess(policy(), outsider)).toBe("join");
    expect(linkAccess(policy({ joinRequests: "allowed_domains" }), outsider)).toBe("join");
    // Even someone declined before: the link is an owner's own open door.
    expect(linkAccess(policy(), { ...outsider, record: "declined" })).toBe("join");
  });

  it("files a request for outsiders when the link asks", () => {
    const asks = policy({ joinRequests: "anyone_with_link" });
    expect(linkAccess(asks, outsider)).toBe("request");
    expect(linkAccess(asks, { ...outsider, record: "declined" })).toBe("request");
    expect(linkAccess(asks, { ...outsider, record: "pending" })).toBe("pending");
  });

  it("still admits people with an invitation or a verified allowed domain", () => {
    const asks = policy({ joinRequests: "anyone_with_link" });
    expect(linkAccess(asks, { ...outsider, invited: true })).toBe("join");
    expect(linkAccess(asks, { ...person(), invited: false })).toBe("join");
    expect(linkAccess(asks, { ...person({ emailVerified: false }), invited: false })).toBe("request");
    expect(linkAccess({ ...asks, domainJoin: "request" }, { ...person(), invited: false })).toBe("request");
  });

  it("ignores an invitation for an address nobody proved, so it can't be taken by signing up with it", () => {
    const asks = policy({ joinRequests: "anyone_with_link" });
    const squatter = { ...outsider, emailVerified: false, invited: true };
    expect(invitationApplies(squatter)).toBe(false);
    expect(invitationApplies({ ...squatter, emailVerified: true })).toBe(true);
    expect(linkAccess(asks, squatter)).toBe("request");
    expect(linkAccess(asks, { ...squatter, record: "pending" })).toBe("pending");
    // Without approval the link still lets them in, as a plain member (see joinWithLink).
    expect(linkAccess(policy(), squatter)).toBe("join");
  });
});
