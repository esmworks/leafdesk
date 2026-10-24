import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, newNonce, policyNonce } from "./content-security-policy";
import { EMBED_FRAME_ORIGINS } from "./web-blocks";

const directives = (policy: string) =>
  new Map(policy.split("; ").map((d) => { const [name, ...values] = d.split(" "); return [name, values]; }));

describe("content security policy", () => {
  it("allows only scripts with the response's nonce, and eval only in development", () => {
    const prod = directives(contentSecurityPolicy({ nonce: "abc", host: "app.example.com", dev: false }));
    expect(prod.get("script-src")).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(prod.get("script-src")).not.toContain("'unsafe-inline'");
    const dev = directives(contentSecurityPolicy({ nonce: "abc", host: "localhost:3000", dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
  });

  it("keeps other sites from framing pages and limits frames to the embed providers", () => {
    const policy = directives(contentSecurityPolicy({ nonce: "n", host: "app.example.com", dev: false }));
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual(["'self'", ...EMBED_FRAME_ORIGINS]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("lets the page open websockets to its own host only", () => {
    const policy = directives(contentSecurityPolicy({ nonce: "n", host: "app.example.com:8443", dev: false }));
    expect(policy.get("connect-src")).toEqual(["'self'", "ws://app.example.com:8443", "wss://app.example.com:8443"]);
    const v6 = directives(contentSecurityPolicy({ nonce: "n", host: "[::1]:3000", dev: false }));
    expect(v6.get("connect-src")).toContain("wss://[::1]:3000");
  });

  it("leaves a Host header that isn't a host name out of the policy", () => {
    for (const host of ["evil.example; script-src *", "a b", "", "x/y"]) {
      const policy = contentSecurityPolicy({ nonce: "n", host, dev: false });
      expect(directives(policy).get("connect-src")).toEqual(["'self'"]);
      expect(policy.split("; ").filter((d) => d.startsWith("script-src"))).toHaveLength(1);
    }
  });

  it("lets Google's tag in only for a site with analytics, and changes nothing else", () => {
    const base = { nonce: "n", host: "docs.example.com", dev: false };
    const plain = contentSecurityPolicy(base);
    expect(contentSecurityPolicy({ ...base, analytics: false })).toBe(plain);
    expect(plain).not.toMatch(/googletagmanager|analytics/);
    const withTag = directives(contentSecurityPolicy({ ...base, analytics: true }));
    expect(withTag.get("script-src")).toEqual(["'self'", "'nonce-n'", "'strict-dynamic'", "https://www.googletagmanager.com"]);
    expect(withTag.get("connect-src")).toEqual([
      "'self'",
      "ws://docs.example.com",
      "wss://docs.example.com",
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://www.googletagmanager.com",
    ]);
    const others = (policy: Map<string, string[]>) => [...policy].filter(([name]) => name !== "script-src" && name !== "connect-src");
    expect(others(withTag)).toEqual(others(directives(plain)));
  });

  it("reads the nonce back from a policy", () => {
    const nonce = newNonce();
    expect(policyNonce(contentSecurityPolicy({ nonce, host: "a.example", dev: false }))).toBe(nonce);
    expect(policyNonce(null)).toBeUndefined();
    expect(policyNonce("default-src 'self'")).toBeUndefined();
  });

  it("makes a new random nonce each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});
