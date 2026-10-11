import { describe, expect, it } from "vitest";
import { isCredentialKey, REDACTED, redactError, redactText, redactValue } from "./redact";

// Made-up tokens, put together here so the file itself holds nothing a secret scanner flags.
const body = (n: number) => "A1b2C3d4E5f6G7h8".repeat(Math.ceil(n / 16)).slice(0, n);
const fake = {
  esi: "esi" + "_" + body(40),
  scim: "scim" + "_" + body(40),
  ldcal: "ldcal" + "_" + body(36),
  whsec: "whsec" + "_" + body(32),
  ghp: "ghp" + "_" + body(36),
  gho: "gho" + "_" + body(36),
  ghs: "ghs" + "_" + body(36),
  githubPat: "github" + "_pat_" + body(60),
  xoxb: "xoxb" + "-1234567890-" + body(24),
  xoxp: "xoxp" + "-1234567890-" + body(24),
  xapp: "xapp" + "-1-" + body(30),
  skAnt: "sk-" + "ant-api03-" + body(48),
  sk: "sk-" + "proj-" + body(48),
  stripe: "sk" + "_live_" + body(24),
  stripeRestricted: "rk" + "_live_" + body(24),
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  google: "AIza" + body(35),
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
};
const uuid = "550e8400-e29b-41d4-a716-446655440000";

describe("redactText: token shapes", () => {
  it("masks well-known tokens, keeping their prefix", () => {
    expect(redactText(`key ${fake.esi} end`)).toBe(`key esi_${REDACTED} end`);
    expect(redactText(fake.scim)).toBe(`scim_${REDACTED}`);
    expect(redactText(fake.ldcal)).toBe(`ldcal_${REDACTED}`);
    expect(redactText(fake.whsec)).toBe(`whsec_${REDACTED}`);
    expect(redactText(`${fake.ghp} ${fake.gho} ${fake.ghs}`)).toBe(`ghp_${REDACTED} gho_${REDACTED} ghs_${REDACTED}`);
    expect(redactText(fake.githubPat)).toBe(`github_pat_${REDACTED}`);
    expect(redactText(`${fake.xoxb}, ${fake.xoxp}, ${fake.xapp}`)).toBe(`xoxb-${REDACTED}, xoxp-${REDACTED}, xapp-${REDACTED}`);
    expect(redactText(fake.skAnt)).toBe(`sk-ant-${REDACTED}`);
    expect(redactText(fake.sk)).toBe(`sk-proj-${REDACTED}`);
    expect(redactText(`${fake.stripe} ${fake.stripeRestricted}`)).toBe(`sk_live_${REDACTED} rk_live_${REDACTED}`);
    expect(redactText(`id ${fake.aws}.`)).toBe(`id AKIA${REDACTED}.`);
    expect(redactText(fake.google)).toBe(`AIza${REDACTED}`);
    expect(redactText(`jwt=${fake.jwt}`)).toBe(`jwt=${REDACTED}`);
  });

  it("masks a private key block, and one cut off before its end", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${body(64)}\n${body(64)}\n-----END RSA PRIVATE KEY-----`;
    expect(redactText(`key:\n${pem}\nafter`)).toBe(`key:\n-----BEGIN RSA PRIVATE KEY-----${REDACTED}-----END RSA PRIVATE KEY-----\nafter`);
    expect(redactText(`-----BEGIN PRIVATE KEY-----\n${body(80)}`)).toBe(`-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`);
    // A public key or a certificate is no secret.
    const cert = `-----BEGIN CERTIFICATE-----\n${body(64)}\n-----END CERTIFICATE-----`;
    expect(redactText(cert)).toBe(cert);
  });
});

describe("redactText: where credentials sit", () => {
  it("masks a URL's password, keeping the user and host", () => {
    expect(redactText("fetch https://deploy:hunter2@example.com/mcp failed")).toBe(`fetch https://deploy:${REDACTED}@example.com/mcp failed`);
    expect(redactText("postgres://leafdesk:pw@db:5432/leafdesk")).toBe(`postgres://leafdesk:${REDACTED}@db:5432/leafdesk`);
    // A port is no password.
    expect(redactText("https://example.com:8443/path")).toBe("https://example.com:8443/path");
  });

  it("masks credential-named query and fragment parameters, and only them", () => {
    expect(redactText("GET https://api.example.com/v1/items?limit=5&api_key=abc123&page=2")).toBe(`GET https://api.example.com/v1/items?limit=5&api_key=${REDACTED}&page=2`);
    expect(redactText("https://x.test/cb?code=AbC-123&state=xyz")).toBe(`https://x.test/cb?code=${REDACTED}&state=xyz`);
    expect(redactText("https://x.test/cb#access_token=abc.def&token_type=bearer")).toBe(`https://x.test/cb#access_token=${REDACTED}&token_type=bearer`);
    expect(redactText("https://s3.test/o?X-Amz-Signature=abcdef&X-Amz-Credential=AK%2F2024")).toBe(`https://s3.test/o?X-Amz-Signature=${REDACTED}&X-Amz-Credential=${REDACTED}`);
    for (const name of ["token", "refresh_token", "id_token", "apikey", "key", "secret", "client_secret", "password", "passwd", "pwd", "auth", "signature", "sig"]) {
      expect(redactText(`https://x.test/?${name}=s3cr3t&q=1`)).toBe(`https://x.test/?${name}=${REDACTED}&q=1`);
    }
  });

  it("masks credential-named pairs on their own, but not ordinary words", () => {
    expect(redactText("set password=hunter2 and GITHUB_TOKEN=abc then")).toBe(`set password=${REDACTED} and GITHUB_TOKEN=${REDACTED} then`);
    // `code`, `key`, `sig`, `auth` are credentials only in a query.
    const prose = "error code=E42 at key=title, auth=required, sig=none; the token was refused and the secret is safe";
    expect(redactText(prose)).toBe(prose);
    expect(redactText("max_tokens=1000 inputTokens=5")).toBe("max_tokens=1000 inputTokens=5");
  });

  it("masks Authorization headers, as headers, JSON or echoed text", () => {
    expect(redactText("Authorization: Bearer abc.def-ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactText("authorization: Basic dXNlcjpwYXNz\r\nhost: x")).toBe(`authorization: Basic ${REDACTED}\r\nhost: x`);
    expect(redactText("Proxy-Authorization: Digest-less-token")).toBe(`Proxy-Authorization: ${REDACTED}`);
    // As a JSON pair, its whole value goes.
    expect(redactText('{"Authorization":"token abc123"}')).toBe(`{"Authorization":"${REDACTED}"}`);
    expect(redactText("authorization='Bearer abc123'")).toBe(`authorization='Bearer ${REDACTED}'`);
    expect(redactText("grant_type=authorization_code")).toBe("grant_type=authorization_code");
  });

  it("masks a bearer or basic token in prose, but not the words", () => {
    expect(redactText("the server said: invalid Bearer abcdEFGH1234 given")).toBe(`the server said: invalid Bearer ${REDACTED} given`);
    expect(redactText("send it with Basic dXNlcjpwYXNz")).toBe(`send it with Basic ${REDACTED}`);
    const prose = "Bearer instruments are a basic understanding of finance; bearer bonds too.";
    expect(redactText(prose)).toBe(prose);
  });

  it("masks credential-named JSON string pairs in text", () => {
    expect(redactText('{"user":"ada","password":"hunter2","apiKey":"k-1","tokenChanged":"yes"}')).toBe(
      `{"user":"ada","password":"${REDACTED}","apiKey":"${REDACTED}","tokenChanged":"yes"}`,
    );
    expect(redactText('{"access_token": "a\\"b", "expires_in": 3600}')).toBe(`{"access_token": "${REDACTED}", "expires_in": 3600}`);
  });
});

describe("redactText: what goes through", () => {
  it("leaves ids, links to pages and plain text alone", () => {
    const text = `Row ${uuid} at http://localhost:3000/w/${uuid}/p/${uuid}?view=${uuid}#block-${uuid} was changed by Ada (sb1.AbCd).`;
    expect(redactText(text)).toBe(text);
    const prose = "Use the task-skill to ask; risk-assessment, desk-lamp. The key is to keep secrets secret. Basic.";
    expect(redactText(prose)).toBe(prose);
    expect(redactText("")).toBe("");
  });

  it("gives the same when masking what is already masked", () => {
    const samples = [
      `Authorization: Bearer ${fake.ghp}`,
      `curl -H "Authorization: Bearer ${fake.jwt}" https://u:p@x.test/?token=t&code=c`,
      `{"password":"x","nested":"${fake.skAnt}"}`,
      `-----BEGIN EC PRIVATE KEY-----\n${body(40)}`,
      `xoxb ${fake.xoxb} AKIA ${fake.aws} ${fake.esi} Basic dXNlcjpwYXNz`,
    ];
    for (const sample of samples) {
      const once = redactText(sample);
      expect(once).not.toBe(sample);
      expect(redactText(once)).toBe(once);
    }
  });
});

describe("isCredentialKey", () => {
  it("knows credential names whatever their case or separators, and nothing that only contains one", () => {
    for (const key of ["token", "access_token", "refreshToken", "id-token", "api_key", "apiKey", "X-Api-Key", "client_secret", "password", "pwd", "Authorization", "githubToken", "db_password", "privateKey"]) {
      expect(isCredentialKey(key), key).toBe(true);
    }
    for (const key of ["tokenChanged", "secretRotated", "eventSecretChanged", "inputTokens", "maxTokens", "authType", "tokenType", "code", "key", "kind", "input", "keyboard", ""]) {
      expect(isCredentialKey(key), key).toBe(false);
    }
  });
});

describe("redactValue", () => {
  it("masks credential-named values and credentials inside strings, at any depth, without changing the original", () => {
    const value = {
      tool: "create_issue",
      args: { title: `Rotate ${fake.ghp}`, headers: { Authorization: "Bearer abc", accept: "json" }, list: [{ api_key: "k" }, "plain"] },
      password: 1234,
      secret: { inner: "x", flag: true },
      empty: { token: "" },
      tokenChanged: true,
      code: "noAccess",
      at: uuid,
    };
    const copy = structuredClone(value);
    expect(redactValue(value)).toEqual({
      tool: "create_issue",
      args: { title: `Rotate ghp_${REDACTED}`, headers: { Authorization: REDACTED, accept: "json" }, list: [{ api_key: REDACTED }, "plain"] },
      password: REDACTED,
      secret: { inner: REDACTED, flag: true },
      empty: { token: "" },
      tokenChanged: true,
      code: "noAccess",
      at: uuid,
    });
    expect(value).toEqual(copy);
  });

  it("takes plain values, dates and cycles", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(7)).toBe(7);
    expect(redactValue(`x ${fake.xoxp}`)).toBe(`x xoxp-${REDACTED}`);
    const at = new Date(0);
    expect(redactValue({ at }).at).toBe(at);
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    expect(redactValue(loop)).toEqual({ name: "a", self: "[circular]" });
    // The same object twice is no cycle.
    const shared = { password: "x" };
    expect(redactValue([shared, shared])).toEqual([{ password: REDACTED }, { password: REDACTED }]);
  });

  it("masks whole what lies too deep", () => {
    let deep: Record<string, unknown> = { leaf: "visible" };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const out = JSON.stringify(redactValue(deep));
    expect(out).not.toContain("visible");
    expect(out).toContain(REDACTED);
  });
});

describe("redactError", () => {
  it("masks an error's message, stack, code and causes", () => {
    const cause = Object.assign(new Error(`connect to https://u:pw@x.test/?api_key=k failed`), { code: "ECONNREFUSED" });
    const error = new Error(`The server answered 401: Bearer ${fake.jwt} is invalid`, { cause });
    const out = redactError(error);
    expect(out).toContain(`Bearer ${REDACTED} is invalid`);
    expect(out).toContain(`https://u:${REDACTED}@x.test/?api_key=${REDACTED} failed`);
    expect(out).toContain("(code ECONNREFUSED)");
    expect(out).toContain("[cause]");
    expect(out).not.toContain("pw@");
    expect(out).not.toContain(fake.jwt);
  });

  it("takes things thrown that aren't errors", () => {
    expect(redactError(`token=${fake.esi}`)).toBe(`token=${REDACTED}`);
    expect(redactError({ status: 401, authorization: "Bearer x" })).toBe(`{"status":401,"authorization":"${REDACTED}"}`);
    expect(redactError(undefined)).toBe("undefined");
  });
});
