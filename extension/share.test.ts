import { describe, expect, it } from "vitest";
import { MAX_TEXT, normalizeAddress, shareUrl } from "./share.js";

describe("normalizeAddress", () => {
  it("takes the address as typed, https unless http is written out", () => {
    expect(normalizeAddress("leafdesk.example.com")).toBe("https://leafdesk.example.com");
    expect(normalizeAddress(" https://leafdesk.example.com/ ")).toBe("https://leafdesk.example.com");
    expect(normalizeAddress("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
    expect(normalizeAddress("https://example.com/leafdesk/")).toBe("https://example.com/leafdesk");
    expect(normalizeAddress("https://leafdesk.example.com/share")).toBe("https://leafdesk.example.com");
    expect(normalizeAddress("https://leafdesk.example.com/w/abc?x=1#y")).toBe("https://leafdesk.example.com/w/abc");
  });

  it("refuses what isn't a web address", () => {
    for (const value of ["", "  ", "javascript:alert(1)", "ftp://example.com", "https://user:pw@example.com", null]) {
      expect(normalizeAddress(value)).toBeNull();
    }
  });
});

describe("shareUrl", () => {
  it("opens the quick note with the page, its title and the selection", () => {
    const url = new URL(shareUrl("https://leafdesk.example.com", { url: "https://news.example/a?b=1&c=2", title: " A story ", text: " a quote " }));
    expect(url.origin + url.pathname).toBe("https://leafdesk.example.com/share");
    expect(url.searchParams.get("url")).toBe("https://news.example/a?b=1&c=2");
    expect(url.searchParams.get("title")).toBe("A story");
    expect(url.searchParams.get("text")).toBe("a quote");
  });

  it("leaves out what is empty and cuts a long selection", () => {
    const url = new URL(shareUrl("https://example.com/leafdesk", { url: "https://a.example/", text: "x".repeat(MAX_TEXT + 50) }));
    expect(url.pathname).toBe("/leafdesk/share");
    expect(url.searchParams.has("title")).toBe(false);
    expect(url.searchParams.get("text")).toHaveLength(MAX_TEXT);
  });
});
