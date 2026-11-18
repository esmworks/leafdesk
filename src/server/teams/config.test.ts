import { afterEach, describe, expect, it, vi } from "vitest";

const hosts = vi.hoisted(() => ({ extra: [] as string[] }));
vi.mock("@/lib/env", () => ({ env: { teamsAppId: "app", teamsAppPassword: "secret", teamsTenantId: "tenant", get teamsServiceUrlHosts() { return hosts.extra; } } }));

const { trustedServiceUrl, teamsOn } = await import("./config");

afterEach(() => {
  hosts.extra = [];
});

describe("trustedServiceUrl", () => {
  it("takes Microsoft's bot service, whatever region or tenant path follows, with a closing slash", () => {
    expect(trustedServiceUrl("https://smba.trafficmanager.net/emea/")).toBe("https://smba.trafficmanager.net/emea/");
    expect(trustedServiceUrl("https://smba.trafficmanager.net/amer/0b3c7e2a-1111-2222-3333-444455556666")).toBe("https://smba.trafficmanager.net/amer/0b3c7e2a-1111-2222-3333-444455556666/");
  });

  it("refuses other hosts, lookalikes, plain http, credentials, ports and queries", () => {
    for (const url of [
      "https://evil.example/",
      "https://smba.trafficmanager.net.evil.example/",
      "https://evil.example/smba.trafficmanager.net/",
      "http://smba.trafficmanager.net/emea/",
      "https://user:pw@smba.trafficmanager.net/",
      "https://smba.trafficmanager.net:8443/",
      "https://smba.trafficmanager.net/?x=1",
      "not a url",
      "",
    ]) expect(trustedServiceUrl(url), url).toBeNull();
    expect(trustedServiceUrl(undefined)).toBeNull();
    expect(trustedServiceUrl(42)).toBeNull();
  });

  it("takes a host the server's owner named, and plain http only on a loopback one", () => {
    hosts.extra = ["gov.bot.example", "127.0.0.1:4010"];
    expect(trustedServiceUrl("https://gov.bot.example/x/")).toBe("https://gov.bot.example/x/");
    expect(trustedServiceUrl("http://gov.bot.example/x/")).toBeNull();
    expect(trustedServiceUrl("http://127.0.0.1:4010/")).toBe("http://127.0.0.1:4010/");
    expect(trustedServiceUrl("http://127.0.0.1:4011/")).toBeNull();
  });
});

describe("teamsOn", () => {
  it("needs the app, its secret and the tenant", () => {
    expect(teamsOn()).toBe(true);
  });
});
