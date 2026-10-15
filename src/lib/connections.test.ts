import { describe, expect, it } from "vitest";
import { connectionOAuthClientsFrom, connectionSlug, namespacedTool } from "./connections";

describe("connectionSlug", () => {
  it("keeps lower-case letters and digits of the name, at most 10", () => {
    expect(connectionSlug("Peer desk", new Set())).toBe("peerdesk");
    expect(connectionSlug("GitHub (work)", new Set())).toBe("githubwork");
    expect(connectionSlug("Çalışma Takvimi", new Set())).toBe("calismatak");
    expect(connectionSlug("Salesforce CRM 2026", new Set())).toBe("salesforce");
  });

  it("is never empty", () => {
    expect(connectionSlug("🙂", new Set())).toBe("conn");
    expect(connectionSlug("", new Set())).toBe("conn");
  });

  it("numbers a slug the workspace already has", () => {
    expect(connectionSlug("Slack", new Set(["slack"]))).toBe("slack2");
    expect(connectionSlug("Slack", new Set(["slack", "slack2"]))).toBe("slack3");
  });
});

describe("namespacedTool", () => {
  it("names a tool by its connection, in the characters model providers take", () => {
    expect(namespacedTool("slack", "post_message")).toBe("slack__post_message");
    expect(namespacedTool("github", "issues.create")).toBe("github__issues_create");
    expect(namespacedTool("x", "a".repeat(100))).toHaveLength(64);
  });
});

describe("connectionOAuthClientsFrom", () => {
  it("reads each service's app by catalog id, its secret after the first colon", () => {
    expect(connectionOAuthClientsFrom(" Slack=1234.5678:abc:def , discord=998877,hubspot = 0a1b-2c : s3cret ")).toEqual({
      slack: { client_id: "1234.5678", client_secret: "abc:def" },
      discord: { client_id: "998877" },
      hubspot: { client_id: "0a1b-2c", client_secret: "s3cret" },
    });
  });

  it("skips what it can't read", () => {
    expect(connectionOAuthClientsFrom(undefined)).toEqual({});
    expect(connectionOAuthClientsFrom("slack,=id:secret,slack=,slack=:secret,bad id=x,box=a b:c")).toEqual({});
    expect(connectionOAuthClientsFrom(`box=${"x".repeat(501)}`)).toEqual({});
  });
});
