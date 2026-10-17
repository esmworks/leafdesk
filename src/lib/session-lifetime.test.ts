import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_DAYS, MAX_SESSION_DAYS, sessionDaysFrom, sessionLifetime } from "./session-lifetime";

describe("SESSION_MAX_AGE_DAYS", () => {
  it("reads whole days", () => {
    expect(sessionDaysFrom("30")).toBe(30);
    expect(sessionDaysFrom(" 1 ")).toBe(1);
    expect(sessionDaysFrom("400")).toBe(400);
  });

  it("caps sessions at the 400 days a browser keeps the cookie", () => {
    expect(MAX_SESSION_DAYS).toBe(400);
    for (const value of ["401", "3650", "100000"]) expect(sessionDaysFrom(value)).toBe(400);
    // Better Auth throws on a cookie Max-Age over 400 days (34 560 000 seconds).
    expect(sessionLifetime(sessionDaysFrom("3650")).expiresIn).toBeLessThanOrEqual(34_560_000);
  });

  it("falls back to Better Auth's seven days when unset or invalid", () => {
    for (const value of [undefined, "", "0", "-3", "1.5", "abc", "1e400"]) expect(sessionDaysFrom(value)).toBe(DEFAULT_SESSION_DAYS);
    expect(DEFAULT_SESSION_DAYS).toBe(7);
  });

  it("gives Better Auth the lifetime in seconds, extended before it runs out", () => {
    expect(sessionLifetime(7)).toEqual({ expiresIn: 7 * 86_400, updateAge: 86_400 });
    expect(sessionLifetime(1)).toEqual({ expiresIn: 86_400, updateAge: 43_200 });
  });
});

describe("signing up with the longest sessions", () => {
  /** Status and session cookie of an email sign-up on an auth instance whose sessions last `days`. */
  async function signUp(days: number) {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      session: sessionLifetime(days),
      onAPIError: { throw: true },
    });
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ name: "Ayşe", email: "ayse@example.com", password: "a-long-password" }),
      }),
    );
    return { status: res.status, cookie: res.headers.get("set-cookie") ?? "" };
  }

  it("works with SESSION_MAX_AGE_DAYS=3650, read as 400 days", async () => {
    const { status, cookie } = await signUp(sessionDaysFrom("3650"));
    expect(status).toBe(200);
    expect(cookie).toContain(`Max-Age=${400 * 86_400}`);
  });

  it("fails with a cookie meant to outlive 400 days, as 3650 did", async () => {
    await expect(signUp(401)).rejects.toThrow(/Max-Age SHOULD NOT be greater than 400 days/);
  });
});
