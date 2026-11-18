import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { teamsAppId: "11111111-2222-3333-4444-555555555555", teamsOpenIdUrl: "https://login.example/openid" } }));

const { BOT_ISSUER, checkActivity, TeamsAuthError, verifyToken } = await import("./auth");

const APP = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000;
const SERVICE = "https://smba.trafficmanager.net/emea/";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string, endorsements: string[] = ["msteams"]) => ({ ...key.export({ format: "jwk" }), kid, endorsements });
const keys = [jwk(pair.publicKey, "k1"), jwk(other.publicKey, "k2", ["webchat"])];

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, { kid = "k1", alg = "RS256", key = pair.privateKey }: { kid?: string; alg?: string; key?: KeyObject } = {}) {
  const signing = `${b64({ typ: "JWT", alg, kid })}.${b64(claims)}`;
  return `${signing}.${createSign("RSA-SHA256").update(signing).sign(key).toString("base64url")}`;
}
const claims = (extra: Record<string, unknown> = {}) => ({ iss: BOT_ISSUER, aud: APP, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 3_000, serviceurl: SERVICE, ...extra });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamsAuthError);
    return (error as Error).message;
  }
  throw new Error("accepted");
};

describe("verifyToken", () => {
  it("takes a token of the Connector made for this bot", () => {
    expect(verifyToken(sign(claims()), keys, { appId: APP, now: NOW }).claims.serviceurl).toBe(SERVICE);
  });

  it("refuses another issuer or audience", () => {
    expect(refusal(() => verifyToken(sign(claims({ iss: "https://sts.windows.net/x/" })), keys, { appId: APP, now: NOW }))).toMatch(/issuer/);
    expect(refusal(() => verifyToken(sign(claims({ aud: "someone-else" })), keys, { appId: APP, now: NOW }))).toMatch(/audience/);
  });

  it("refuses a token outside its validity, with five minutes of skew", () => {
    expect(refusal(() => verifyToken(sign(claims({ exp: NOW / 1000 - 301 })), keys, { appId: APP, now: NOW }))).toMatch(/expired/);
    expect(verifyToken(sign(claims({ exp: NOW / 1000 - 200 })), keys, { appId: APP, now: NOW })).toBeTruthy();
    expect(refusal(() => verifyToken(sign(claims({ nbf: NOW / 1000 + 301 })), keys, { appId: APP, now: NOW }))).toMatch(/not yet/);
    expect(refusal(() => verifyToken(sign(claims({ exp: undefined })), keys, { appId: APP, now: NOW }))).toMatch(/expired/);
  });

  it("refuses a signature that isn't the named key's, and a key it doesn't know", () => {
    expect(refusal(() => verifyToken(sign(claims(), { key: other.privateKey }), keys, { appId: APP, now: NOW }))).toMatch(/signature/);
    expect(refusal(() => verifyToken(sign(claims(), { kid: "nope" }), keys, { appId: APP, now: NOW }))).toMatch(/key/);
    const [head, body, signature] = sign(claims()).split(".");
    const forged = `${head}.${b64({ ...claims(), serviceurl: "https://evil.example/" })}.${signature}`;
    expect(refusal(() => verifyToken(forged, keys, { appId: APP, now: NOW }))).toMatch(/signature/);
    expect(body).toBeTruthy();
  });

  it("refuses any algorithm but RS256, and tokens that aren't whole", () => {
    expect(refusal(() => verifyToken(sign(claims(), { alg: "none" }), keys, { appId: APP, now: NOW }))).toMatch(/algorithm/);
    expect(refusal(() => verifyToken(sign(claims(), { alg: "HS256" }), keys, { appId: APP, now: NOW }))).toMatch(/algorithm/);
    expect(refusal(() => verifyToken("a.b", keys, { appId: APP, now: NOW }))).toMatch(/malformed/);
    expect(refusal(() => verifyToken(`${b64({ alg: "RS256" })}.${b64({})}.`, keys, { appId: APP, now: NOW }))).toMatch(/malformed/);
  });
});

describe("checkActivity", () => {
  const verified = () => verifyToken(sign(claims()), keys, { appId: APP, now: NOW });

  it("takes an activity of Teams at the address the token names", () => {
    expect(() => checkActivity(verified(), { serviceUrl: SERVICE, channelId: "msteams" })).not.toThrow();
  });

  it("refuses another service address: the token doesn't sign the body", () => {
    try {
      checkActivity(verified(), { serviceUrl: "https://evil.example/", channelId: "msteams" });
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(TeamsAuthError);
      expect((error as InstanceType<typeof TeamsAuthError>).status).toBe(403);
    }
    expect(() => checkActivity(verified(), { channelId: "msteams" })).toThrow(TeamsAuthError);
  });

  it("refuses another channel, and a key not endorsed for Teams", () => {
    expect(() => checkActivity(verified(), { serviceUrl: SERVICE, channelId: "webchat" })).toThrow(TeamsAuthError);
    const unendorsed = verifyToken(sign(claims(), { kid: "k2", key: other.privateKey }), keys, { appId: APP, now: NOW });
    expect(() => checkActivity(unendorsed, { serviceUrl: SERVICE, channelId: "msteams" })).toThrow(/endorsed/);
  });
});
