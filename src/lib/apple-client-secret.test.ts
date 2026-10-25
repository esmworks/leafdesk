import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appleClientSecret, appleCredentialsFromKey } from "./apple-client-secret";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("Sign in with Apple's client secret", () => {
  it("is an ES256 JWT for Apple that Apple's check of the key accepts", () => {
    const jwt = appleClientSecret({ clientId: "com.example.web", teamId: "TEAM123456", keyId: "KEY1234567", key: privateKey }, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(decode(claims)).toEqual({ iss: "TEAM123456", iat: 1_800_000_000, exp: 1_800_000_000 + 180 * 86400, aud: "https://appleid.apple.com", sub: "com.example.web" });
    const ok = verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("is made from the key in the environment and renewed before it runs out", () => {
    let now = 1_800_000_000_000;
    const env = { APPLE_CLIENT_ID: "com.example.web", APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n") };
    const credentials = appleCredentialsFromKey(env, () => now)!;
    expect(credentials.clientId).toBe("com.example.web");
    const first = credentials.clientSecret;
    now += 10 * 86400_000;
    expect(credentials.clientSecret).toBe(first);
    now += 150 * 86400_000;
    const renewed = credentials.clientSecret;
    expect(renewed).not.toBe(first);
    expect(decode(renewed.split(".")[1]).iat).toBe(Math.floor(now / 1000));
  });

  it("stays off without every part, and refuses a key it can't read", () => {
    expect(appleCredentialsFromKey({ APPLE_CLIENT_ID: "x", APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k" })).toBeNull();
    expect(() => appleCredentialsFromKey({ APPLE_CLIENT_ID: "x", APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k", APPLE_PRIVATE_KEY: "nope" })).toThrow();
  });
});
