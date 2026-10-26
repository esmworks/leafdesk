import { isIP } from "node:net";

/**
 * Which addresses the server may connect to when it fetches a URL someone typed (link previews):
 * only public unicast ones. Everything private, loopback, link-local, shared (CGNAT), multicast,
 * reserved or documentation-only is refused, in IPv4 and IPv6, including IPv4 addresses wrapped in
 * IPv6 (mapped, compatible, NAT64, 6to4, Teredo), so none of them reaches the internal network.
 */

type Range = [base: number, bits: number];

/** IPv4 ranges that are not public unicast (IANA special-purpose registry, plus multicast and reserved). */
const BLOCKED_V4: Range[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["168.63.129.16", 32], // Azure's platform endpoint (WireServer), reachable from every Azure VM
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255 broadcast
].map(([ip, bits]) => [v4ToNumber(ip as string)!, bits as number]);

function v4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function v4InRange(value: number, [base, bits]: Range) {
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

export function isBlockedIPv4(ip: string): boolean {
  const value = v4ToNumber(ip);
  if (value === null) return true;
  return BLOCKED_V4.some((range) => v4InRange(value, range));
}

/** The eight 16-bit groups of an IPv6 address, or null. A trailing dotted IPv4 part is allowed. */
export function parseIPv6(ip: string): number[] | null {
  let value = ip.toLowerCase();
  // A zone ("fe80::1%eth0") only exists on link-local addresses; keep the address.
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (isIP(value) !== 6) return null;
  const lastColon = value.lastIndexOf(":");
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    // "::ffff:1.2.3.4": the dotted part is the last two groups.
    const v4 = v4ToNumber(last);
    if (v4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return true;
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  // :: (unspecified), ::1 (loopback) and ::a.b.c.d (deprecated IPv4-compatible): all of ::/96.
  if (zeroUntil(6)) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated): judged as the IPv4 address.
  if (zeroUntil(5) && g[5] === 0xffff) return isBlockedIPv4(v4FromGroups(g[6], g[7]));
  if (zeroUntil(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(v4FromGroups(g[6], g[7]));
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local NAT64): the IPv4 address inside, or local.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true;
    if (g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(v4FromGroups(g[6], g[7]));
    return true;
  }
  // 100::/64 discard-only.
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 2001::/23 IETF protocol assignments (Teredo 2001::/32 among them), 2001:db8::/32 documentation.
  if (g[0] === 0x2001 && g[1] < 0x200) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  // 2002::/16 6to4: the IPv4 address in groups 1 and 2.
  if (g[0] === 0x2002) return isBlockedIPv4(v4FromGroups(g[1], g[2]));
  // 3fff::/20 documentation.
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local (deprecated), ff00::/8 multicast.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  // Only global unicast (2000::/3) is left as public.
  return (g[0] & 0xe000) !== 0x2000;
}

/** Whether the server must not connect to `ip`. Anything that isn't an IP address is refused too. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

/** Ports a link preview may fetch from: the web's usual ones, not every service on a host. */
export const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/**
 * Whether `url` is on an allowed-hosts list an administrator set (CONNECTOR_ALLOWED_HOSTS and the
 * like): an entry `host:port` lets that port through, a bare `host` only the web's usual ports
 * (ALLOWED_PORTS), never every service on the host.
 */
export function onHostList(url: URL, allowed: readonly string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.includes(`${host}:${port}`) || (ALLOWED_PORTS.has(url.port) && allowed.includes(host));
}
