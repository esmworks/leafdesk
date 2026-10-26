import { describe, expect, it } from "vitest";
import { isBlockedAddress, isBlockedIPv4, isBlockedIPv6, onHostList, parseIPv6 } from "./ssrf";

describe("SSRF address checks", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "168.63.129.16",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks the IPv4 address %s", (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true);
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "168.63.129.15", "168.63.129.17", "172.15.255.255", "172.32.0.1", "192.169.0.1", "223.255.255.255"])(
    "allows the public IPv4 address %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each([
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:168.63.129.16",
    "::ffff:a83f:8110",
    "64:ff9b::a83f:8110",
    "2002:a83f:8110::1",
    "::ffff:0:192.168.0.1",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456:789a:1::1",
    "fe80::1",
    "fe80::1%en0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "ff05::1:3",
  ])("blocks the IPv6 address %s", (ip) => {
    expect(isBlockedIPv6(ip)).toBe(true);
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])(
    "allows the public IPv6 address %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it("refuses anything that isn't an IP address", () => {
    for (const value of ["", "localhost", "example.com", "1.2.3", "1.2.3.256", "01.2.3.4x", "::g", "1::2::3"]) {
      expect(isBlockedAddress(value)).toBe(true);
    }
  });

  it("lets a bare host on an allowed-hosts list through on the web's ports only, a host:port on that port", () => {
    expect(onHostList(new URL("https://mcp.lan/x"), ["mcp.lan"])).toBe(true);
    expect(onHostList(new URL("http://MCP.lan:8080/x"), ["mcp.lan"])).toBe(true);
    expect(onHostList(new URL("http://mcp.lan:6379/x"), ["mcp.lan"])).toBe(false);
    expect(onHostList(new URL("https://mcp.lan:5432/x"), ["mcp.lan"])).toBe(false);
    expect(onHostList(new URL("http://mcp.lan:6379/x"), ["mcp.lan:6379"])).toBe(true);
    expect(onHostList(new URL("http://mcp.lan:6380/x"), ["mcp.lan:6379"])).toBe(false);
    expect(onHostList(new URL("https://mcp.lan/x"), ["mcp.lan:443"])).toBe(true);
    expect(onHostList(new URL("http://mcp.lan/x"), ["mcp.lan:443"])).toBe(false);
    expect(onHostList(new URL("http://[::1]:3000/x"), ["::1:3000"])).toBe(true);
    expect(onHostList(new URL("http://[::1]:3000/x"), ["::1"])).toBe(false);
    expect(onHostList(new URL("https://other.lan/x"), ["mcp.lan"])).toBe(false);
  });

  it("parses IPv6 addresses into eight groups", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::ffff:192.168.1.2")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x102]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("nope")).toBeNull();
  });
});
