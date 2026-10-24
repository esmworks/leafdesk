import { describe, expect, it } from "vitest";
import {
  cleanDescription,
  cleanHeaderLinks,
  emojiFaviconSvg,
  emojiIcon,
  isAnalyticsId,
  isSiteKey,
  normalizeSiteDomain,
  pageIdFromSegment,
  pageSegment,
  publishedHref,
  requestHost,
  routeOnSiteHost,
  siteDomainProblem,
  sitePathSlug,
  siteSlugProblem,
  slugify,
} from "./site";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("siteSlugProblem", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(siteSlugProblem("acme")).toBeNull();
    expect(siteSlugProblem("acme-docs-2")).toBeNull();
    expect(siteSlugProblem("a".repeat(40))).toBeNull();
  });

  it("names what is wrong", () => {
    expect(siteSlugProblem("ab")).toBe("tooShort");
    expect(siteSlugProblem("a".repeat(41))).toBe("tooLong");
    expect(siteSlugProblem("Acme")).toBe("invalid");
    expect(siteSlugProblem("-acme")).toBe("invalid");
    expect(siteSlugProblem("acme-")).toBe("invalid");
    expect(siteSlugProblem("ac--me")).toBe("invalid");
    expect(siteSlugProblem("acme docs")).toBe("invalid");
    expect(siteSlugProblem("açme")).toBe("invalid");
  });

  it("keeps back names that would pass for the app", () => {
    for (const slug of ["api", "admin", "sign-in", "settings", "leafdesk", "www"]) expect(siteSlugProblem(slug)).toBe("reserved");
  });
});

describe("isSiteKey", () => {
  it("tells slugs from publication tokens", () => {
    expect(isSiteKey("acme")).toBe(true);
    // Tokens are 32 random bytes in base64url: 43 characters, longer than any slug.
    expect(isSiteKey("k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8o9p0lkjhgfd")).toBe(false);
    expect(isSiteKey("ABC_def")).toBe(false);
  });
});

describe("slugify", () => {
  it("turns titles into address words", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
    expect(slugify("  Q3 plan: what's next?  ")).toBe("q3-plan-whats-next");
    expect(slugify("Ayşe'nin Çalışma Notları")).toBe("aysenin-calisma-notlari");
    expect(slugify("IĞDIR ılık")).toBe("igdir-ilik");
    expect(slugify("🚀")).toBe("");
  });

  it("cuts long titles without a trailing hyphen", () => {
    const out = slugify("word ".repeat(30), 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("-")).toBe(false);
  });
});

describe("page segments", () => {
  it("puts the title before the id and reads the id back", () => {
    expect(pageSegment(ID, "Road map")).toBe(`road-map-${ID}`);
    expect(pageSegment(ID, "")).toBe(ID);
    expect(pageIdFromSegment(`road-map-${ID}`)).toBe(ID);
    expect(pageIdFromSegment(`old-title-${ID}`)).toBe(ID);
    expect(pageIdFromSegment(ID.toUpperCase())).toBe(ID);
  });

  it("takes bare ids and refuses anything else", () => {
    expect(pageIdFromSegment("abc_123")).toBe("abc_123");
    expect(pageIdFromSegment("../etc")).toBeNull();
    expect(pageIdFromSegment("%E0%A4%A")).toBeNull();
    expect(pageIdFromSegment("x".repeat(65))).toBeNull();
  });
});

describe("publishedHref", () => {
  it("links publication pages by id and site pages by title and id", () => {
    const publication = { base: "/s/token", homeId: "root", site: false };
    expect(publishedHref(publication, "root", "Home")).toBe("/s/token");
    expect(publishedHref(publication, ID, "Road map")).toBe(`/s/token/${ID}`);
    const site = { base: "/s/acme", homeId: "root", site: true };
    expect(publishedHref(site, "root", "Home")).toBe("/s/acme");
    expect(publishedHref(site, ID, "Road map")).toBe(`/s/acme/road-map-${ID}`);
  });

  it("links a site on its own domain at the root", () => {
    const onDomain = { base: "", homeId: "root", site: true };
    expect(publishedHref(onDomain, "root", "Home")).toBe("/");
    expect(publishedHref(onDomain, ID, "Road map")).toBe(`/road-map-${ID}`);
  });
});

describe("site domains", () => {
  it("takes the host name out of what was typed", () => {
    expect(normalizeSiteDomain("docs.example.com")).toBe("docs.example.com");
    expect(normalizeSiteDomain("  https://Docs.Example.COM/ ")).toBe("docs.example.com");
    expect(normalizeSiteDomain("docs.example.com.")).toBe("docs.example.com");
    expect(normalizeSiteDomain("bücher.example")).toBe("xn--bcher-kva.example");
    for (const typed of ["", "docs.example.com/path", "user@docs.example.com", "docs example.com", "https://", "a?b"]) {
      expect(normalizeSiteDomain(typed), typed).toBeNull();
    }
  });

  it("accepts host names and refuses addresses, single labels and the app's own host", () => {
    expect(siteDomainProblem("docs.example.com", "app.example.com")).toBeNull();
    expect(siteDomainProblem("docs.localhost", "localhost")).toBeNull();
    expect(siteDomainProblem("app.example.com", "app.example.com")).toBe("domainReserved");
    expect(siteDomainProblem("localhost", "app.example.com")).toBe("domainInvalid");
    for (const domain of ["example", "127.0.0.1", "10.0.0.1", "-a.example.com", "a_b.example.com", `${"a".repeat(64)}.com`, "[::1]"]) {
      expect(siteDomainProblem(domain, "app.example.com"), domain).toBe("domainInvalid");
    }
  });

  it("reads a request's host without its port", () => {
    expect(requestHost("Docs.Example.com:8443")).toBe("docs.example.com");
    expect(requestHost("docs.example.com.")).toBe("docs.example.com");
    expect(requestHost("docs.example.com")).toBe("docs.example.com");
    expect(requestHost("[::1]:3000")).toBe("[::1]");
    expect(requestHost(undefined)).toBe("");
  });
});

describe("routeOnSiteHost", () => {
  const route = (path: string, method = "GET") => routeOnSiteHost(method, path, "acme", "https://app.example.com");

  it("serves the site's pages at the root", () => {
    expect(route("/")).toEqual({ kind: "site" });
    expect(route(`/road-map-${ID}`)).toEqual({ kind: "site" });
    expect(route(`/road-map-${ID}?view=v1`)).toEqual({ kind: "site" });
    expect(route("/favicon.svg")).toEqual({ kind: "site" });
    expect(route("/", "HEAD")).toEqual({ kind: "site" });
  });

  it("lets through Next's files, the files pages show and the app's icons", () => {
    expect(route("/_next/static/chunks/a.js")).toEqual({ kind: "pass" });
    expect(route("/api/files/abc_123")).toEqual({ kind: "pass" });
    expect(route("/api/files/abc_123/preview")).toEqual({ kind: "pass" });
    expect(route("/icon.svg")).toEqual({ kind: "pass" });
  });

  it("sends Duplicate to the app and the app's site address to the root", () => {
    expect(route("/duplicate?page=x")).toEqual({ kind: "redirect", location: "https://app.example.com/s/acme/duplicate?page=x" });
    expect(route("/s/acme")).toEqual({ kind: "redirect", location: "/" });
    expect(route(`/s/acme/road-map-${ID}?view=v`)).toEqual({ kind: "redirect", location: `/road-map-${ID}?view=v` });
  });

  it("serves nothing else: no app, sign-in, API, MCP, uploads or writes", () => {
    for (const path of [
      "/w/abc",
      "/sign-in/x",
      "/api/auth/get-session",
      "/api/files",
      "/api/v1/pages",
      "/mcp",
      "/s/other-site",
      "/s/acme/duplicate",
      "/s/acme/a/b",
      "/sw.js",
      "/manifest.webmanifest",
      "/.well-known/oauth-authorization-server",
      "/f/token",
    ]) {
      expect(route(path), path).toEqual({ kind: "notFound" });
    }
    expect(route("/", "POST")).toEqual({ kind: "notFound" });
    expect(route(`/road-map-${ID}`, "POST")).toEqual({ kind: "notFound" });
  });

  it("knows which paths are a site's pages", () => {
    expect(sitePathSlug("/s/acme")).toBe("acme");
    expect(sitePathSlug(`/s/acme/road-map-${ID}`)).toBe("acme");
    expect(sitePathSlug("/s/acme/duplicate")).toBeNull();
    expect(sitePathSlug("/s/k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8o9p0lkjhgfd")).toBeNull();
    expect(sitePathSlug("/w/acme")).toBeNull();
  });
});

describe("site header, search and analytics settings", () => {
  it("keeps header links with a label and a page or an http(s) address", () => {
    expect(cleanHeaderLinks([{ label: " Docs  home ", pageId: ID }, { label: "Blog", url: " https://blog.example.com/ " }])).toEqual([
      { label: "Docs home", pageId: ID },
      { label: "Blog", url: "https://blog.example.com/" },
    ]);
    expect(cleanHeaderLinks([])).toEqual([]);
    for (const bad of [
      [{ label: "", pageId: ID }],
      [{ label: "x", url: "javascript:alert(1)" }],
      [{ label: "x", url: "ftp://example.com" }],
      [{ label: "x", url: "/relative" }],
      [{ label: "x", pageId: ID, url: "https://a.example" }],
      [{ label: "x".repeat(41), pageId: ID }],
      Array.from({ length: 7 }, () => ({ label: "x", pageId: ID })),
      "not a list",
    ]) {
      expect(cleanHeaderLinks(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keeps descriptions to one short paragraph", () => {
    expect(cleanDescription("  Two\n lines ")).toBe("Two lines");
    expect(cleanDescription("x".repeat(400))).toHaveLength(300);
    expect(cleanDescription(5)).toBe("");
  });

  it("takes Google Analytics 4 measurement IDs only", () => {
    expect(isAnalyticsId("G-ABC123XYZ9")).toBe(true);
    for (const bad of ["UA-1234-1", "GTM-ABCD", "g-abc123", "G-", "G-ABC\"><script>", "G-ABC 123"]) expect(isAnalyticsId(bad), bad).toBe(false);
  });

  it("makes a favicon of emoji icons only", () => {
    for (const emoji of ["🚀", "📘", "👩🏽‍💻", "🇹🇷", "❤️", "1️⃣"]) expect(emojiIcon(emoji), emoji).toBe(emoji);
    for (const other of [null, "", "AB", "1", "#", "→", "<svg>"]) expect(emojiIcon(other), String(other)).toBeNull();
    const svg = emojiFaviconSvg("🚀");
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg).toContain(">🚀</text>");
  });
});
