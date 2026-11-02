import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-sender-logos";

const { logoKeyValid, logoUrl, pageIcons } = await import("./sender-logos");

describe("logoUrl", () => {
  it("signs a logo's address for one person and one domain", () => {
    const key = new URL(logoUrl("user-1", "vatan.com", 1000), "https://app.example").searchParams.get("k");
    expect(logoKeyValid("user-1", "vatan.com", key)).toBe(true);
    expect(logoKeyValid("user-2", "vatan.com", key)).toBe(false);
    expect(logoKeyValid("user-1", "bank.com", key)).toBe(false);
    expect(logoKeyValid("user-1", "vatan.com", null)).toBe(false);
    expect(logoKeyValid("user-1", "vatan.com", "x")).toBe(false);
  });
});

describe("pageIcons", () => {
  it("lists touch icons first, then icons by their stated size, as absolute addresses", () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" href="/favicon-192.png" sizes="192x192">
      <link rel="apple-touch-icon" href="/touch.png?a=1&amp;b=2">
      <link rel="stylesheet" href="/site.css">
      <link rel="icon" href="javascript:alert(1)">
    </head><body><link rel="apple-touch-icon" href="/late.png"></body></html>`;
    expect(pageIcons(html, "https://www.example.com/tr/")).toEqual([
      "https://www.example.com/touch.png?a=1&b=2",
      "https://www.example.com/favicon-192.png",
      "https://www.example.com/favicon-16.png",
    ]);
  });

  it("follows the page's base address", () => {
    expect(pageIcons('<head><base href="https://cdn.example.com/s/"><link rel="icon" href="i.svg"></head>', "https://example.com/")).toEqual(["https://cdn.example.com/s/i.svg"]);
  });
});
