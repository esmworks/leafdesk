import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { agentEmail } from "./agents";
import { CLIENT_IP_HEADER } from "./client-ip";
import {
  agentSignInGuard,
  baseAuthOptions,
  closedSignUpAdmits,
  guardUpdateUser,
  inviteTokenOf,
  joinTokenOf,
  refuseAgentAddress,
  routeSsoSignIn,
  socialTokenOf,
  SSO_DISABLED_ENDPOINTS,
  SSO_DISABLED_PATHS,
} from "./auth-options";

describe("agents' users can't sign in", () => {
  it("refuses creating an account with, or moving one to, an agent's address", () => {
    expect(() => refuseAgentAddress({ email: agentEmail("a1") })).toThrow(/agent/);
    expect(() => refuseAgentAddress({ email: "Someone@AGENTS.leafdesk.invalid" })).toThrow(/agent/);
    expect(() => refuseAgentAddress({ email: "ayse@example.com" })).not.toThrow();
    // An update that leaves the address alone.
    expect(() => refuseAgentAddress({ name: "Ayşe" } as { email?: unknown })).not.toThrow();
  });

  it("gives an agent's user no session and no account to sign in with", async () => {
    const guard = agentSignInGuard(async (userId) => userId === "agent-user");
    await expect(guard({ userId: "agent-user" })).rejects.toThrow(/Agents can't sign in/);
    await expect(guard({ userId: "person" })).resolves.toBeUndefined();
  });
});

describe("guardUpdateUser", () => {
  it("lets a valid name through, and removing the picture", () => {
    expect(() => guardUpdateUser({ name: "Ayşe" })).not.toThrow();
    expect(() => guardUpdateUser({ image: null })).not.toThrow();
  });

  it("refuses picture URLs and other fields: pictures are uploaded", () => {
    expect(() => guardUpdateUser({ image: "https://tracker.example.com/p.gif" })).toThrow(/Only the name/);
    expect(() => guardUpdateUser({ image: "/api/avatars/someone-else/0123456789abcdef0123456789abcdef-png" })).toThrow();
    expect(() => guardUpdateUser({ name: "Ok", twoFactorEnabled: false })).toThrow(/Only the name/);
  });

  it("refuses empty and overlong names", () => {
    expect(() => guardUpdateUser({ name: "  " })).toThrow(/name/);
    expect(() => guardUpdateUser({ name: "x".repeat(81) })).toThrow(/name/);
  });
});

describe("inviteTokenOf", () => {
  it("reads the parsed query first", () => {
    expect(inviteTokenOf({ query: { invite: "abc" } })).toBe("abc");
  });

  it("falls back to the request URL", () => {
    const request = new Request("https://notes.example.com/api/auth/sign-up/email?invite=xyz", { method: "POST" });
    expect(inviteTokenOf({ request })).toBe("xyz");
  });

  it("returns null without a token or context", () => {
    expect(inviteTokenOf({ request: new Request("https://notes.example.com/api/auth/sign-up/email") })).toBeNull();
    expect(inviteTokenOf(null)).toBeNull();
    expect(inviteTokenOf({ query: { invite: ["a", "b"] } })).toBeNull();
  });
});

describe("joinTokenOf", () => {
  it("reads the join token from the query or the request URL", () => {
    expect(joinTokenOf({ query: { join: "abc" } })).toBe("abc");
    const request = new Request("https://notes.example.com/api/auth/sign-up/email?join=xyz", { method: "POST" });
    expect(joinTokenOf({ request })).toBe("xyz");
  });

  it("does not confuse invitation and join tokens", () => {
    expect(joinTokenOf({ query: { invite: "abc" } })).toBeNull();
    expect(inviteTokenOf({ query: { join: "abc" } })).toBeNull();
  });
});

describe("socialTokenOf", () => {
  it("reads a string token from the OAuth state's server context", () => {
    expect(socialTokenOf({ invite: "abc", join: "xyz" }, "invite")).toBe("abc");
    expect(socialTokenOf({ invite: "abc", join: "xyz" }, "join")).toBe("xyz");
  });

  it("returns null for a missing, empty or non-string token", () => {
    expect(socialTokenOf(undefined, "invite")).toBeNull();
    expect(socialTokenOf({ invite: "" }, "invite")).toBeNull();
    expect(socialTokenOf({ invite: 1 }, "invite")).toBeNull();
  });
});

describe("closedSignUpAdmits", () => {
  const check = async (token: string, email: string) => token === "t" && email === "a@example.com";

  it("admits only an invitation for the same email", async () => {
    expect(await closedSignUpAdmits("t", "a@example.com", check)).toBe(true);
    expect(await closedSignUpAdmits("t", "b@example.com", check)).toBe(false);
    expect(await closedSignUpAdmits("other", "a@example.com", check)).toBe(false);
  });

  it("admits nobody without a token, an email or a way to check", async () => {
    expect(await closedSignUpAdmits(null, "a@example.com", check)).toBe(false);
    expect(await closedSignUpAdmits("t", undefined, check)).toBe(false);
    expect(await closedSignUpAdmits("t", "a@example.com")).toBe(false);
  });
});

describe("routeSsoSignIn", () => {
  const resolve = async (email: string) => (email.endsWith("@example.com") ? "ws-w1" : null);
  const codeOf = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as { body?: { code?: string } }).body?.code;

  it("picks the provider from the email typed on the sign-in page", async () => {
    expect(await routeSsoSignIn({ email: " ada@example.com ", callbackURL: "/w" }, resolve)).toEqual({
      email: "ada@example.com",
      callbackURL: "/w",
      providerId: "ws-w1",
    });
  });

  it("leaves a sign-in with a provider id to the plugin (the gate page and the instance button)", async () => {
    expect(await routeSsoSignIn({ providerId: "oidc" }, resolve)).toBeNull();
  });

  it("answers SSO_NOT_FOUND when nothing matches, and refuses the plugin's own routing", async () => {
    expect(await codeOf(routeSsoSignIn({ email: "ada@other.com" }, resolve))).toBe("SSO_NOT_FOUND");
    expect(await codeOf(routeSsoSignIn({}, resolve))).toBe("SSO_NOT_FOUND");
    expect(await codeOf(routeSsoSignIn({ email: "ada@example.com" }, undefined))).toBe("SSO_NOT_FOUND");
    expect(await codeOf(routeSsoSignIn({ domain: "example.com" }, resolve))).toBe("SSO_NOT_FOUND");
    expect(await codeOf(routeSsoSignIn({ organizationSlug: "acme" }, resolve))).toBe("SSO_NOT_FOUND");
  });
});

describe("SSO endpoints that are off", () => {
  it("covers provider management, the shared callback and single logout", () => {
    for (const path of ["/sso/register", "/sso/verify-domain", "/sso/callback", "/sso/saml2/sp/slo/:providerId"]) {
      expect(SSO_DISABLED_ENDPOINTS.has(path)).toBe(true);
    }
    expect(SSO_DISABLED_ENDPOINTS.has("/sso/callback/:providerId")).toBe(false);
    expect(SSO_DISABLED_ENDPOINTS.has("/sso/saml2/sp/acs/:providerId")).toBe(false);
    expect(SSO_DISABLED_PATHS.every((path) => !path.includes(":"))).toBe(true);
  });
});

describe("the address rate limits count by", () => {
  /** Status codes of `/ok` called with these headers, three allowed per minute. */
  async function statuses(requests: Record<string, string>[]) {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      advanced: baseAuthOptions().advanced,
      rateLimit: { enabled: true, customRules: { "/ok": { window: 60, max: 3 } } },
    });
    const out: number[] = [];
    for (const headers of requests) out.push((await auth.handler(new Request("http://localhost:3000/api/auth/ok", { headers }))).status);
    return out;
  }

  it("is the one server.ts works out, not X-Forwarded-For as the visitor writes it", async () => {
    const rotating = [1, 2, 3, 4, 5].map((n) => ({ "x-forwarded-for": `203.0.113.${n}`, [CLIENT_IP_HEADER]: "198.51.100.7" }));
    expect(await statuses(rotating)).toEqual([200, 200, 200, 429, 429]);
    const visitors = [1, 2, 3, 4, 5].map((n) => ({ "x-forwarded-for": "203.0.113.1", [CLIENT_IP_HEADER]: `198.51.100.${n}` }));
    expect(await statuses(visitors)).toEqual([200, 200, 200, 200, 200]);
  });
});
