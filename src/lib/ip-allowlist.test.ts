import { describe, expect, it } from "vitest";
import {
  formatIpAddress,
  ipAllowed,
  MAX_ALLOWED_NETWORKS,
  MAX_NETWORK_LABEL,
  parseAllowedNetworks,
  parseIpAddress,
  parseNetwork,
  formatNetwork,
  storedAllowedNetworks,
} from "./ip-allowlist";

const canonical = (text: string) => {
  const parsed = parseNetwork(text);
  return parsed.ok ? formatNetwork(parsed.network) : parsed.problem;
};
const list = (...ranges: string[]) => ranges.map((range) => ({ range, label: "" }));

describe("parseIpAddress", () => {
  it("reads IPv4 and IPv6 addresses", () => {
    expect(parseIpAddress("192.0.2.1")).toEqual({ family: 4, value: 0xc0000201n });
    expect(parseIpAddress("::1")).toEqual({ family: 6, value: 1n });
    expect(parseIpAddress("2001:db8::")?.family).toBe(6);
    expect(parseIpAddress("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual(parseIpAddress("2001:db8::1"));
    expect(parseIpAddress("::")).toEqual({ family: 6, value: 0n });
  });

  it("reads an IPv4-mapped IPv6 address as IPv4, in either spelling", () => {
    expect(parseIpAddress("::ffff:192.0.2.1")).toEqual({ family: 4, value: 0xc0000201n });
    expect(parseIpAddress("::FFFF:c000:0201")).toEqual({ family: 4, value: 0xc0000201n });
    expect(parseIpAddress("0:0:0:0:0:ffff:192.0.2.1")).toEqual({ family: 4, value: 0xc0000201n });
    // IPv4-compatible (deprecated) and other embedded forms stay IPv6.
    expect(parseIpAddress("::192.0.2.1")?.family).toBe(6);
    expect(parseIpAddress("64:ff9b::192.0.2.1")?.family).toBe(6);
  });

  it("takes the port and brackets a proxy may add", () => {
    expect(parseIpAddress("192.0.2.1:8080")).toEqual({ family: 4, value: 0xc0000201n });
    expect(parseIpAddress("[2001:db8::1]:443")).toEqual(parseIpAddress("2001:db8::1"));
    expect(parseIpAddress("[::1]")).toEqual({ family: 6, value: 1n });
  });

  it("refuses what isn't an address", () => {
    for (const bad of ["", "unknown", "256.0.0.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.-4", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::", "fe80::1%en0", ":1", "1:", "::ffff:1.2.3", "1.2.3.4::", "g::1", " "]) {
      expect(parseIpAddress(bad), bad).toBeNull();
    }
  });
});

describe("parseNetwork", () => {
  it("makes ranges canonical, clearing host bits", () => {
    expect(canonical("192.0.2.9/24")).toBe("192.0.2.0/24");
    expect(canonical("192.0.2.9")).toBe("192.0.2.9");
    expect(canonical("192.0.2.9/32")).toBe("192.0.2.9");
    expect(canonical("0.0.0.0/0")).toBe("0.0.0.0/0");
    expect(canonical("10.255.0.1/8")).toBe("10.0.0.0/8");
    expect(canonical("2001:DB8:0:0:1::/32")).toBe("2001:db8::/32");
    expect(canonical("2001:db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonical("2001:db8:0:1:0:0:0:1/128")).toBe("2001:db8:0:1::1");
    expect(canonical("::/0")).toBe("::/0");
    expect(canonical("fe80::1/10")).toBe("fe80::/10");
  });

  it("compresses the longest run of zero groups, not a single one", () => {
    expect(canonical("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
    expect(canonical("2001:0:0:1:0:0:0:1")).toBe("2001:0:0:1::1");
  });

  it("reads an IPv4-mapped range from /96 on as the IPv4 range", () => {
    expect(canonical("::ffff:192.0.2.0/120")).toBe("192.0.2.0/24");
    expect(canonical("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonical("::ffff:0:0/96")).toBe("0.0.0.0/0");
    expect(canonical("::ffff:0:0/80")).toBe("::/80");
  });

  it("refuses bad addresses and prefixes", () => {
    expect(canonical("192.0.2.0/33")).toBe("prefix");
    expect(canonical("2001:db8::/129")).toBe("prefix");
    expect(canonical("192.0.2.0/")).toBe("prefix");
    expect(canonical("192.0.2.0/-1")).toBe("prefix");
    expect(canonical("192.0.2.0/24/8")).toBe("prefix");
    expect(canonical("192.0.2.0/ 24")).toBe("prefix");
    expect(canonical("example.com")).toBe("address");
    expect(canonical("192.0.2.1:80")).toBe("address");
    expect(canonical("[::1]")).toBe("address");
    expect(canonical("192.0.2.*")).toBe("address");
    expect(canonical("")).toBe("address");
  });
});

describe("ipAllowed", () => {
  it("lets everyone in while the list is empty, even an unknown address", () => {
    expect(ipAllowed("203.0.113.5", [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
  });

  it("holds back an unknown or unreadable address once the list has entries", () => {
    expect(ipAllowed(null, list("0.0.0.0/0"))).toBe(false);
    expect(ipAllowed(undefined, list("0.0.0.0/0"))).toBe(false);
    expect(ipAllowed("unknown", list("0.0.0.0/0", "::/0"))).toBe(false);
    expect(ipAllowed("", list("0.0.0.0/0"))).toBe(false);
  });

  it("matches IPv4 addresses and ranges", () => {
    const networks = list("192.0.2.0/24", "198.51.100.7");
    expect(ipAllowed("192.0.2.0", networks)).toBe(true);
    expect(ipAllowed("192.0.2.255", networks)).toBe(true);
    expect(ipAllowed("192.0.3.0", networks)).toBe(false);
    expect(ipAllowed("198.51.100.7", networks)).toBe(true);
    expect(ipAllowed("198.51.100.8", networks)).toBe(false);
    expect(ipAllowed("192.0.2.10:51234", networks)).toBe(true);
  });

  it("matches IPv6 addresses and ranges", () => {
    const networks = list("2001:db8::/32", "::1");
    expect(ipAllowed("2001:db8:ffff::1", networks)).toBe(true);
    expect(ipAllowed("2001:db9::1", networks)).toBe(false);
    expect(ipAllowed("::1", networks)).toBe(true);
    expect(ipAllowed("[::1]:3000", networks)).toBe(true);
    expect(ipAllowed("::2", networks)).toBe(false);
  });

  it("matches an IPv4-mapped visitor against IPv4 entries, and mapped entries against IPv4 visitors", () => {
    expect(ipAllowed("::ffff:192.0.2.44", list("192.0.2.0/24"))).toBe(true);
    expect(ipAllowed("::ffff:127.0.0.1", list("127.0.0.1"))).toBe(true);
    expect(ipAllowed("192.0.2.44", list("::ffff:192.0.2.0/120"))).toBe(true);
    expect(ipAllowed("192.0.3.44", list("::ffff:192.0.2.0/120"))).toBe(false);
  });

  it("keeps the families apart", () => {
    expect(ipAllowed("::1", list("0.0.0.0/0"))).toBe(false);
    expect(ipAllowed("127.0.0.1", list("::/0"))).toBe(false);
    // An IPv4 address is never in an IPv6 range, even one written over the mapped block.
    expect(ipAllowed("192.0.2.1", list("::/0"))).toBe(false);
    expect(ipAllowed("0.0.0.1", list("::1"))).toBe(false);
  });

  it("lets a /0 take everyone of its family", () => {
    expect(ipAllowed("8.8.8.8", list("0.0.0.0/0"))).toBe(true);
    expect(ipAllowed("2606:4700::1111", list("::/0"))).toBe(true);
  });

  it("ignores stored entries that don't read as networks", () => {
    expect(ipAllowed("192.0.2.1", list("garbage"))).toBe(false);
    expect(ipAllowed("192.0.2.1", list("garbage", "192.0.2.1"))).toBe(true);
  });
});

describe("parseAllowedNetworks", () => {
  it("makes the list canonical, drops blank rows and repeats, trims labels", () => {
    expect(
      parseAllowedNetworks([
        { range: " 192.0.2.9/24 ", label: "  Head   office " },
        { range: "", label: "" },
        { range: "192.0.2.0/24", label: "Again" },
        { range: "2001:DB8::/32" },
      ]),
    ).toEqual({
      ok: true,
      networks: [
        { range: "192.0.2.0/24", label: "Head office" },
        { range: "2001:db8::/32", label: "" },
      ],
    });
    expect(parseAllowedNetworks([])).toEqual({ ok: true, networks: [] });
  });

  it("names the row that can't be read", () => {
    expect(parseAllowedNetworks([{ range: "192.0.2.1" }, { range: "10.0.0.0/40", label: "VPN" }])).toEqual({
      ok: false,
      problem: "prefix",
      index: 1,
      entry: "10.0.0.0/40",
    });
    expect(parseAllowedNetworks([{ range: "", label: "No range" }])).toMatchObject({ ok: false, problem: "address", index: 0 });
    expect(parseAllowedNetworks([{ range: "192.0.2.1", label: "x".repeat(MAX_NETWORK_LABEL + 1) }])).toMatchObject({ ok: false, problem: "label" });
    expect(parseAllowedNetworks("192.0.2.1")).toMatchObject({ ok: false });
    expect(parseAllowedNetworks([{ range: 7 }])).toMatchObject({ ok: false, problem: "address" });
  });

  it(`takes at most ${MAX_ALLOWED_NETWORKS} entries`, () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ range: `10.0.${Math.floor(i / 256)}.${i % 256}` }));
    expect(parseAllowedNetworks(entries(MAX_ALLOWED_NETWORKS))).toMatchObject({ ok: true });
    expect(parseAllowedNetworks(entries(MAX_ALLOWED_NETWORKS + 1))).toMatchObject({ ok: false, problem: "tooMany", index: MAX_ALLOWED_NETWORKS });
  });
});

describe("formatIpAddress", () => {
  it("shows an address canonically, a mapped one as IPv4", () => {
    expect(formatIpAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(formatIpAddress("2001:0DB8::0001")).toBe("2001:db8::1");
    expect(formatIpAddress("unknown")).toBeNull();
    expect(formatIpAddress(null)).toBeNull();
  });
});

describe("storedAllowedNetworks", () => {
  it("keeps only entries", () => {
    expect(storedAllowedNetworks([{ range: "192.0.2.1", label: "A" }, { range: 1 }, null, "x", { range: "::1" }])).toEqual([
      { range: "192.0.2.1", label: "A" },
      { range: "::1", label: "" },
    ]);
    expect(storedAllowedNetworks(null)).toEqual([]);
  });
});
