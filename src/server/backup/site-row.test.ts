import { describe, expect, it } from "vitest";
import { restoredSite } from "./site-row";

const context = { appHost: "app.example.com", pageIds: new Set(["page-1"]) };
const row = {
  workspace_id: "ws-1",
  slug: "acme-docs",
  title: "Docs",
  home_page_id: "page-1",
  domain: "docs.example.org",
  theme: "dark",
  description: "Our docs",
  header_links: [
    { label: "Home", pageId: "page-1" },
    { label: "Blog", url: "https://blog.example.org" },
  ],
  analytics_id: "G-ABC123",
};

describe("restoredSite", () => {
  it("keeps a site that passes the checks saving it does", () => {
    expect(restoredSite(row, context)).toEqual(row);
  });

  it("drops an analytics ID that isn't one, so nothing but an ID reaches the site's script", () => {
    expect(restoredSite({ ...row, analytics_id: 'G-1");alert(1);//' }, context)?.analytics_id).toBeNull();
    expect(restoredSite({ ...row, analytics_id: "</script><script>alert(1)</script>" }, context)?.analytics_id).toBeNull();
    expect(restoredSite({ ...row, analytics_id: " g-abc123 " }, context)?.analytics_id).toBe("G-ABC123");
  });

  it("drops a domain that can't be a site's: the app's own, localhost, an IP address, not a host name", () => {
    for (const domain of ["app.example.com", "localhost", "10.0.0.1", "docs example", "a/b"]) {
      expect(restoredSite({ ...row, domain }, context)?.domain, domain).toBeNull();
    }
    expect(restoredSite({ ...row, domain: "Docs.Example.org" }, context)?.domain).toBe("docs.example.org");
  });

  it("drops header links that don't pass, and links to pages the backup doesn't hold", () => {
    expect(restoredSite({ ...row, header_links: [{ label: "x", url: "javascript:alert(1)" }] }, context)?.header_links).toEqual([]);
    expect(restoredSite({ ...row, header_links: [{ label: "Elsewhere", pageId: "page-9" }, { label: "Home", pageId: "page-1" }] }, context)?.header_links).toEqual([
      { label: "Home", pageId: "page-1" },
    ]);
  });

  it("falls back to the system theme and cuts the title and description", () => {
    const site = restoredSite({ ...row, theme: "neon", title: "t".repeat(200), description: "d ".repeat(400) }, context)!;
    expect(site.theme).toBe("system");
    expect((site.title as string).length).toBe(80);
    expect((site.description as string).length).toBeLessThanOrEqual(300);
  });

  it("leaves out a site whose address can't be a site's", () => {
    expect(restoredSite({ ...row, slug: "../admin" }, context)).toBeNull();
    expect(restoredSite({ ...row, slug: null }, context)).toBeNull();
  });
});
