import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env.authSecret", () => {
  const random = "a-random-value-of-at-least-thirty-two-characters";

  it("refuses the example secret and short ones in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "change-me-to-a-long-random-string");
    expect(() => env.authSecret).toThrow(/at least 32 characters, not the example/);
    vi.stubEnv("BETTER_AUTH_SECRET", "too-short-a-secret");
    expect(() => env.authSecret).toThrow(/at least 32 characters/);
    vi.stubEnv("BETTER_AUTH_SECRET", random);
    expect(env.authSecret).toBe(random);
  });

  it("takes any secret in development, and still needs one", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_SECRET", "change-me-to-a-long-random-string");
    expect(env.authSecret).toBe("change-me-to-a-long-random-string");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => env.authSecret).toThrow(/Missing required environment variable BETTER_AUTH_SECRET/);
  });

  it("takes the placeholder the Docker build passes to next build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "build-only-placeholder-not-used-at-runtime-000000");
    expect(env.authSecret).toBe("build-only-placeholder-not-used-at-runtime-000000");
  });
});
