import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySecretFiles, bundledDatabaseUrl, secretReaderFor, type SecretReader } from "./secret-files";

const files = (contents: Record<string, string>): SecretReader => (name) => contents[name]?.trim() || null;
const GENERATED = { "auth-secret": "a".repeat(64), "postgres-password": "Gen3rated" };

describe("applySecretFiles", () => {
  it("fills the auth secret and the bundled database's URL when the environment sets neither", () => {
    const env: Record<string, string | undefined> = { LEAFDESK_SECRETS_DIR: "/secrets" };
    expect(applySecretFiles(env, files(GENERATED))).toEqual(["BETTER_AUTH_SECRET", "DATABASE_URL"]);
    expect(env.BETTER_AUTH_SECRET).toBe("a".repeat(64));
    expect(env.DATABASE_URL).toBe("postgres://leafdesk:Gen3rated@db:5432/leafdesk");
  });

  it("treats empty values as unset (compose passes unset variables as empty strings)", () => {
    const env = { LEAFDESK_SECRETS_DIR: "/secrets", BETTER_AUTH_SECRET: "", DATABASE_URL: " ", POSTGRES_PASSWORD: "" };
    applySecretFiles(env, files(GENERATED));
    expect(env.BETTER_AUTH_SECRET).toBe("a".repeat(64));
    expect(env.DATABASE_URL).toBe("postgres://leafdesk:Gen3rated@db:5432/leafdesk");
  });

  it("keeps what the environment sets: an older .env works unchanged", () => {
    const env = { LEAFDESK_SECRETS_DIR: "/secrets", BETTER_AUTH_SECRET: "from-dot-env", DATABASE_URL: "postgres://u:p@external:5432/x" };
    expect(applySecretFiles(env, files(GENERATED))).toEqual([]);
    expect(env).toEqual({ LEAFDESK_SECRETS_DIR: "/secrets", BETTER_AUTH_SECRET: "from-dot-env", DATABASE_URL: "postgres://u:p@external:5432/x" });
  });

  it("builds the URL from POSTGRES_PASSWORD before the file, as the bundled database was made with it", () => {
    const env: Record<string, string | undefined> = { LEAFDESK_SECRETS_DIR: "/secrets", POSTGRES_PASSWORD: "fromDotEnv1" };
    applySecretFiles(env, files(GENERATED));
    expect(env.DATABASE_URL).toBe("postgres://leafdesk:fromDotEnv1@db:5432/leafdesk");
  });

  it("leaves a value unset when its file is missing too, so env.ts reports it", () => {
    const env: Record<string, string | undefined> = { LEAFDESK_SECRETS_DIR: "/secrets" };
    expect(applySecretFiles(env, files({}))).toEqual([]);
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("does nothing without LEAFDESK_SECRETS_DIR (pnpm dev and other ways of running)", () => {
    const env: Record<string, string | undefined> = {};
    expect(applySecretFiles(env)).toEqual([]);
    expect(env).toEqual({});
  });
});

describe("bundledDatabaseUrl", () => {
  it("encodes a password with characters that mean something in a URL", () => {
    const url = new URL(bundledDatabaseUrl("p@ss:w/rd%#?"));
    expect(decodeURIComponent(url.password)).toBe("p@ss:w/rd%#?");
    expect(url.hostname).toBe("db");
    expect(url.pathname).toBe("/leafdesk");
  });
});

describe("secretReaderFor", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads trimmed files, and null for missing or empty ones", () => {
    dir = mkdtempSync(join(tmpdir(), "leafdesk-secrets-"));
    writeFileSync(join(dir, "auth-secret"), "  secret-value\n");
    writeFileSync(join(dir, "postgres-password"), "\n");
    const read = secretReaderFor(dir);
    expect(read("auth-secret")).toBe("secret-value");
    expect(read("postgres-password")).toBeNull();
    expect(read("nothing-here")).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("fails on a file it can't read, without showing its content", () => {
    dir = mkdtempSync(join(tmpdir(), "leafdesk-secrets-"));
    writeFileSync(join(dir, "auth-secret"), "do-not-print-me");
    chmodSync(join(dir, "auth-secret"), 0o000);
    expect(() => secretReaderFor(dir!)("auth-secret")).toThrow(/Could not read the secret auth-secret .*EACCES/);
    try {
      secretReaderFor(dir!)("auth-secret");
    } catch (error) {
      expect(String(error)).not.toContain("do-not-print-me");
    }
  });
});
