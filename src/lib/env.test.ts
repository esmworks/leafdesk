import { afterEach, describe, expect, it, vi } from "vitest";
import { mcp } from "@better-auth/mcp";
import { env, mcpResource, storageOAuthAppsFrom } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mcpResource", () => {
  it("keeps APP_URL on HTTPS and on loopback", () => {
    for (const [appUrl, resource] of [
      ["https://notes.example.com", "https://notes.example.com/mcp"],
      ["https://example.com/leafdesk/", "https://example.com/leafdesk/mcp"],
      ["http://localhost:3000", "http://localhost:3000/mcp"],
      ["http://127.0.0.1:3000", "http://127.0.0.1:3000/mcp"],
      ["http://[::1]:3000", "http://[::1]:3000/mcp"],
    ]) {
      vi.stubEnv("APP_URL", appUrl);
      expect(mcpResource()).toBe(resource);
    }
  });

  it("names the HTTPS twin of a plain-HTTP APP_URL elsewhere, which mcp() takes", () => {
    for (const [appUrl, resource] of [
      ["http://app-942e39-167-235-165-52.sslip.io", "https://app-942e39-167-235-165-52.sslip.io/mcp"],
      ["http://192.168.1.10:3000", "https://192.168.1.10:3000/mcp"],
    ]) {
      vi.stubEnv("APP_URL", appUrl);
      expect(mcpResource()).toBe(resource);
      expect(() => mcp({ loginPage: "/sign-in", consentPage: "/oauth/consent", resource: mcpResource() })).not.toThrow();
    }
    vi.stubEnv("APP_URL", "http://192.168.1.10:3000");
    expect(() => mcp({ loginPage: "/sign-in", consentPage: "/oauth/consent", resource: "http://192.168.1.10:3000/mcp" })).toThrow(/HTTPS/);
  });
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

describe("storageOAuthAppsFrom", () => {
  it("has an app for each kind with both its id and secret", () => {
    expect(storageOAuthAppsFrom({})).toEqual({});
    expect(
      storageOAuthAppsFrom({
        STORAGE_GDRIVE_CLIENT_ID: " id.apps.googleusercontent.com ",
        STORAGE_GDRIVE_CLIENT_SECRET: "gsecret",
        STORAGE_DROPBOX_CLIENT_ID: "dkey",
        STORAGE_DROPBOX_CLIENT_SECRET: "",
      }),
    ).toEqual({ gdrive: { clientId: "id.apps.googleusercontent.com", clientSecret: "gsecret" } });
  });

  it("is read from the environment", () => {
    vi.stubEnv("STORAGE_DROPBOX_CLIENT_ID", "dkey");
    vi.stubEnv("STORAGE_DROPBOX_CLIENT_SECRET", "dsecret");
    expect(env.storageOAuthApps.dropbox).toEqual({ clientId: "dkey", clientSecret: "dsecret" });
  });
});

describe("ownStorageEnabled", () => {
  it("is off unless turned on", () => {
    vi.stubEnv("OWN_STORAGE_ENABLED", "");
    expect(env.ownStorageEnabled).toBe(false);
    vi.stubEnv("OWN_STORAGE_ENABLED", "false");
    expect(env.ownStorageEnabled).toBe(false);
    vi.stubEnv("OWN_STORAGE_ENABLED", "0");
    expect(env.ownStorageEnabled).toBe(false);
    for (const on of ["1", "true", " TRUE ", "yes"]) {
      vi.stubEnv("OWN_STORAGE_ENABLED", on);
      expect(env.ownStorageEnabled).toBe(true);
    }
  });
});

