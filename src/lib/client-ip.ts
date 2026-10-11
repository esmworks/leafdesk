import { BlockList, isIP } from "node:net";

/** Set by server.ts on every request from the socket and trusted proxies; never taken from the client. */
export const CLIENT_IP_HEADER = "x-leafdesk-client-ip";

/** Without TRUSTED_PROXIES: one proxy, but only when the request came from a private address. */
export const PRIVATE_PROXY = "private";
export type TrustedProxies = number | typeof PRIVATE_PROXY;

/** TRUSTED_PROXIES: how many reverse proxies stand in front of the app (unset: PRIVATE_PROXY). */
export function trustedProxyCount(value = process.env.TRUSTED_PROXIES): TrustedProxies {
  const raw = (value ?? "").trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : PRIVATE_PROXY;
}

// Loopback, private networks, shared address space (carrier and overlay networks) and link-local:
// where a proxy on the same machine or network connects from. Visitors from the internet don't.
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");

export function isPrivateAddress(address: string | undefined) {
  const plain = (address ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const family = isIP(plain);
  return family !== 0 && privateRanges.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The visitor's address. Each proxy appends the address it was reached from to X-Forwarded-For,
 * and the app sees the last proxy as the socket, so the visitor is the entry `trusted` places left
 * of the socket. Anything further left was written by the visitor and can say anything. With
 * PRIVATE_PROXY, a request straight from the internet is its own visitor, whatever it wrote.
 */
export function clientIpFrom(forwardedFor: string | string[] | undefined, socketAddress: string | undefined, trusted: TrustedProxies) {
  const hops = trusted === PRIVATE_PROXY ? (isPrivateAddress(socketAddress) ? 1 : 0) : trusted;
  const forwarded = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const chain = [...forwarded, socketAddress ?? "unknown"];
  return chain[Math.max(0, chain.length - 1 - hops)].slice(0, 100);
}

/** One line for the server log at start: whose X-Forwarded-For the visitor's address comes from. */
export function describeTrustedProxies(trusted: TrustedProxies) {
  if (trusted === PRIVATE_PROXY) {
    return "Visitor addresses: X-Forwarded-For is read only from a proxy on a private network (TRUSTED_PROXIES unset; set it to the number of proxies, or 0 for none)";
  }
  if (trusted === 0) return "Visitor addresses: the connection's own address; X-Forwarded-For is ignored (TRUSTED_PROXIES=0)";
  return `Visitor addresses: X-Forwarded-For as written by the last ${trusted === 1 ? "proxy" : `${trusted} proxies`} (TRUSTED_PROXIES=${trusted}); clients must not reach the app past ${trusted === 1 ? "it" : "them"}`;
}
