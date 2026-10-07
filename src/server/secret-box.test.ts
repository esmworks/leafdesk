import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open, openJson, seal, SecretBoxError, sealedWithOldKey, sealJson } from "./secret-box";

const saved = { ...process.env };

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-auth-secret-that-is-long-enough-for-tests";
  delete process.env.LEAFDESK_ENCRYPTION_KEY;
  delete process.env.LEAFDESK_ENCRYPTION_OLD_KEYS;
});

afterEach(() => {
  process.env = { ...saved };
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecretBoxError ? error.code : "other";
  }
  return null;
};

describe("secret box", () => {
  it("opens what it sealed, and seals the same text differently each time", () => {
    const a = seal("xoxb-token");
    const b = seal("xoxb-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("xoxb");
    expect(open(a)).toBe("xoxb-token");
    expect(openJson<{ n: number }>(sealJson({ n: 1 }))).toEqual({ n: 1 });
  });

  it("refuses a changed value", () => {
    const parts = seal("secret").split(".");
    const body = Buffer.from(parts[3], "base64url");
    body[0] ^= 1;
    parts[3] = body.toString("base64url");
    expect(codeOf(() => open(parts.join(".")))).toBe("tampered");
    expect(codeOf(() => open("not sealed"))).toBe("malformed");
  });

  it("keeps the key id out of reach of a swap", () => {
    const parts = seal("secret").split(".");
    parts[1] = "aaaaaaaaaa";
    expect(codeOf(() => open(parts.join(".")))).toBe("unknownKey");
  });

  it("can't be opened with another server's secret", () => {
    const sealed = seal("secret");
    process.env.BETTER_AUTH_SECRET = "another-servers-secret-that-is-long-enough";
    expect(codeOf(() => open(sealed))).toBe("unknownKey");
  });

  it("opens values of the derived key once an explicit key is set, and seals with the new one", () => {
    const before = seal("secret");
    process.env.LEAFDESK_ENCRYPTION_KEY = "k".repeat(40);
    expect(open(before)).toBe("secret");
    expect(sealedWithOldKey(before)).toBe(true);
    const after = seal("secret");
    expect(sealedWithOldKey(after)).toBe(false);
    expect(after.split(".")[1]).not.toBe(before.split(".")[1]);
  });

  it("rotates: an old key in LEAFDESK_ENCRYPTION_OLD_KEYS still opens", () => {
    process.env.LEAFDESK_ENCRYPTION_KEY = "a".repeat(40);
    const sealed = seal("secret");
    process.env.LEAFDESK_ENCRYPTION_KEY = "b".repeat(40);
    expect(codeOf(() => open(sealed))).toBe("unknownKey");
    process.env.LEAFDESK_ENCRYPTION_OLD_KEYS = "a".repeat(40);
    expect(open(sealed)).toBe("secret");
  });

  it("refuses a short explicit key", () => {
    process.env.LEAFDESK_ENCRYPTION_KEY = "short";
    expect(codeOf(() => seal("secret"))).toBe("badKey");
  });
});
