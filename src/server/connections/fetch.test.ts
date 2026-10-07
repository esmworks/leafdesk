import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import { allowedConnectorHost, checkConnectionUrl, ConnectionFetchError, guardedLookup } from "./fetch";

const saved = process.env.CONNECTOR_ALLOWED_HOSTS;
afterEach(() => {
  if (saved === undefined) delete process.env.CONNECTOR_ALLOWED_HOSTS;
  else process.env.CONNECTOR_ALLOWED_HOSTS = saved;
});

const codeOf = (url: string) => {
  try {
    checkConnectionUrl(url);
    return "ok";
  } catch (error) {
    return error instanceof ConnectionFetchError ? error.code : "other";
  }
};

describe("checkConnectionUrl", () => {
  it("takes public https addresses", () => {
    expect(codeOf("https://mcp.slack.com/mcp")).toBe("ok");
    expect(codeOf("https://api.githubcopilot.com/mcp/")).toBe("ok");
    expect(codeOf("https://8.8.8.8/mcp")).toBe("ok");
  });

  it("refuses what isn't an https address", () => {
    expect(codeOf("not a url")).toBe("invalidUrl");
    expect(codeOf("http://mcp.example.com/mcp")).toBe("invalidUrl");
    expect(codeOf("ftp://mcp.example.com/mcp")).toBe("invalidUrl");
    expect(codeOf("file:///etc/passwd")).toBe("invalidUrl");
    expect(codeOf("https://user:secret@mcp.example.com/mcp")).toBe("invalidUrl");
    expect(codeOf(`https://example.com/${"a".repeat(2_100)}`)).toBe("invalidUrl");
  });

  it("refuses private addresses and local names", () => {
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://192.168.0.10/mcp",
      "https://172.16.5.4/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://0.0.0.0/mcp",
      "https://localhost/mcp",
      "https://intranet/mcp",
      "https://printer.local/mcp",
      "https://db.internal/mcp",
      "https://app.localhost/mcp",
    ]) {
      expect(codeOf(url), url).toBe("blocked");
    }
  });

  it("lets allowed hosts through, http included", () => {
    process.env.CONNECTOR_ALLOWED_HOSTS = "localhost:3211, mcp.lan";
    expect(codeOf("http://localhost:3211/mcp")).toBe("ok");
    expect(codeOf("http://mcp.lan/mcp")).toBe("ok");
    // Another port of an allowed host:port isn't allowed.
    expect(codeOf("http://localhost:3000/mcp")).toBe("invalidUrl");
    expect(codeOf("https://localhost:3000/mcp")).toBe("blocked");
  });
});

describe("allowedConnectorHost", () => {
  it("matches by name, or by name and port (the scheme's port when none is given)", () => {
    expect(allowedConnectorHost(new URL("https://mcp.lan/x"), ["mcp.lan"])).toBe(true);
    expect(allowedConnectorHost(new URL("https://mcp.lan/x"), ["mcp.lan:443"])).toBe(true);
    expect(allowedConnectorHost(new URL("http://mcp.lan/x"), ["mcp.lan:443"])).toBe(false);
    expect(allowedConnectorHost(new URL("https://MCP.LAN:8443/x"), ["mcp.lan:8443"])).toBe(true);
    expect(allowedConnectorHost(new URL("https://[::1]:8443/x"), ["::1:8443"])).toBe(true);
    expect(allowedConnectorHost(new URL("https://other.lan/x"), ["mcp.lan"])).toBe(false);
  });
});

describe("guardedLookup", () => {
  const lookupWith = (addresses: LookupAddress[], all = false) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>((resolve) =>
      guardedLookup(async () => addresses)("mcp.example.com", { all }, (error, address) => resolve({ error, address })),
    );

  it("answers with public addresses", async () => {
    expect(await lookupWith([{ address: "93.184.216.34", family: 4 }])).toEqual({ error: null, address: "93.184.216.34" });
    const all = await lookupWith([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }], true);
    expect(all.error).toBeNull();
    expect(all.address).toHaveLength(2);
  });

  it("refuses a host with any private address (a public one beside it doesn't help)", async () => {
    const mixed = await lookupWith([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect(mixed.error?.code).toBe("EBLOCKED");
    const loopback = await lookupWith([{ address: "::1", family: 6 }]);
    expect(loopback.error?.code).toBe("EBLOCKED");
  });

  it("refuses a host without addresses", async () => {
    expect((await lookupWith([])).error?.code).toBe("ENOTFOUND");
  });
});
