import { describe, expect, it } from "vitest";
import { clientIpFrom, isPrivateAddress, PRIVATE_PROXY, trustedProxyCount } from "./client-ip";

describe("clientIpFrom", () => {
  it("takes the address the trusted proxy saw, not what the visitor wrote", () => {
    // Visitor sent a made-up header; the proxy appended the real address.
    expect(clientIpFrom("6.6.6.6, 203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7");
    expect(clientIpFrom("203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7");
    expect(clientIpFrom(["6.6.6.6", "203.0.113.7, 10.0.0.9"], "10.0.0.2", 2)).toBe("203.0.113.7");
  });

  it("uses the socket without a proxy, whatever the header says", () => {
    expect(clientIpFrom("6.6.6.6", "203.0.113.7", 0)).toBe("203.0.113.7");
    expect(clientIpFrom(undefined, "203.0.113.7", 0)).toBe("203.0.113.7");
  });

  it("falls back to the left-most address when there are fewer hops than proxies", () => {
    expect(clientIpFrom(undefined, "203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFrom("", undefined, 1)).toBe("unknown");
  });

  it("trusts one proxy by default only when it connects from a private address", () => {
    // A proxy on the same machine or network.
    expect(clientIpFrom("6.6.6.6, 203.0.113.7", "172.18.0.5", PRIVATE_PROXY)).toBe("203.0.113.7");
    expect(clientIpFrom("203.0.113.7", "::ffff:127.0.0.1", PRIVATE_PROXY)).toBe("203.0.113.7");
    // A visitor reaching the published port directly can't pose as anyone.
    expect(clientIpFrom("6.6.6.6", "198.51.100.4", PRIVATE_PROXY)).toBe("198.51.100.4");
    expect(clientIpFrom("6.6.6.6", "::ffff:198.51.100.4", PRIVATE_PROXY)).toBe("::ffff:198.51.100.4");
    expect(clientIpFrom("6.6.6.6", "2001:db8::1", PRIVATE_PROXY)).toBe("2001:db8::1");
    expect(clientIpFrom("6.6.6.6", undefined, PRIVATE_PROXY)).toBe("unknown");
  });
});

describe("isPrivateAddress", () => {
  it("knows loopback, private, shared and link-local ranges", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.31.255.1", "192.168.0.10", "100.100.1.1", "169.254.1.1", "::1", "fd00::5", "fe80::1", "fe80::1%en0", "::FFFF:10.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["203.0.113.7", "172.32.0.1", "100.128.0.1", "2001:db8::1", "::ffff:8.8.8.8", "", undefined, "unknown"]) {
      expect(isPrivateAddress(address), String(address)).toBe(false);
    }
  });
});

describe("trustedProxyCount", () => {
  it("takes a count when one is set and falls back to private proxies otherwise", () => {
    expect(trustedProxyCount("0")).toBe(0);
    expect(trustedProxyCount("1")).toBe(1);
    expect(trustedProxyCount(" 2 ")).toBe(2);
    expect(trustedProxyCount(undefined)).toBe(PRIVATE_PROXY);
    expect(trustedProxyCount("")).toBe(PRIVATE_PROXY);
    expect(trustedProxyCount("-1")).toBe(PRIVATE_PROXY);
    expect(trustedProxyCount("abc")).toBe(PRIVATE_PROXY);
  });
});
