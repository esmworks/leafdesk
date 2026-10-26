import { describe, expect, it, vi } from "vitest";

/** One site with a domain and an analytics ID, as the snapshot query returns it. */
const sites = [{ slug: "acme", domain: "docs.acme.example", analyticsId: "G-ACME12345" }];

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => sites }) }) },
}));
vi.mock("@/lib/env", () => ({ env: { appUrl: "https://app.leafdesk.example", localMode: false } }));

const { siteGate, upgradeAllowed } = await import("./site-hosts");
const { env } = await import("@/lib/env");

describe("siteGate", () => {
  it("serves a site's pages on its own domain, with its analytics ID", async () => {
    expect(await siteGate("GET", "/", "docs.acme.example")).toEqual({ kind: "site", slug: "acme", analyticsId: "G-ACME12345" });
    expect(await siteGate("GET", "/road-map-0123456789abcdef0123456789abcdef", "DOCS.acme.example:443")).toMatchObject({
      kind: "site",
      analyticsId: "G-ACME12345",
    });
  });

  it("never hands the analytics ID to the app's own address, where session cookies live", async () => {
    for (const path of ["/s/acme", "/s/acme/road-map-0123456789abcdef0123456789abcdef", "/w/acme"]) {
      expect(await siteGate("GET", path, "app.leafdesk.example"), path).toEqual({ kind: "app" });
    }
    expect(await siteGate("GET", "/s/acme", "elsewhere.example")).toEqual({ kind: "app" });
  });

  it("keeps everything but the site off its domain", async () => {
    expect(await siteGate("GET", "/w/acme", "docs.acme.example")).toEqual({ kind: "notFound" });
    expect(await siteGate("POST", "/", "docs.acme.example")).toEqual({ kind: "notFound" });
    expect(await upgradeAllowed("/collab", "docs.acme.example")).toBe(false);
    expect(await upgradeAllowed("/collab", "app.leafdesk.example")).toBe(true);
  });
});

describe("the desktop app's server (local mode)", () => {
  it("answers only to its own address, not to another name pointing at this computer", async () => {
    vi.mocked(env).localMode = true;
    try {
      for (const host of ["127.0.0.1:51234", "localhost:51234", "LOCALHOST"]) {
        expect(await siteGate("GET", "/w/abc", host), host).toEqual({ kind: "app" });
        expect(await upgradeAllowed("/collab", host), host).toBe(true);
      }
      for (const host of ["rebind.attacker.example:51234", "docs.acme.example", "127.0.0.1.nip.io:51234", undefined]) {
        expect(await siteGate("GET", "/api/health", host), String(host)).toEqual({ kind: "notFound" });
        expect(await upgradeAllowed("/collab", host), String(host)).toBe(false);
      }
    } finally {
      vi.mocked(env).localMode = false;
    }
  });
});
