/**
 * A workspace's approved networks (`workspace.allowed_networks`): IPv4 and IPv6 addresses and CIDR
 * ranges, each with an optional label. While the list has entries, browser sessions from other
 * addresses are held back from the workspace (see policyHold in server/access.ts).
 *
 * Pure, for the server and the settings form alike: no `node:net`. Addresses are read into 128-bit
 * numbers; an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, what a dual-stack socket reports for an
 * IPv4 visitor) counts as the IPv4 address it carries, in an entry and in a visitor's address alike.
 */

export type AllowedNetwork = {
  /** A canonical address (`192.0.2.7`, `2001:db8::1`) or range (`192.0.2.0/24`, `2001:db8::/32`). */
  range: string;
  /** What it is, as an owner wrote it ("Office", "VPN"); empty when they gave none. */
  label: string;
};

/** At most this many entries per workspace. */
export const MAX_ALLOWED_NETWORKS = 100;
/** At most this many characters of a label. */
export const MAX_NETWORK_LABEL = 100;

type Family = 4 | 6;
type Address = { family: Family; value: bigint };
type Network = { family: Family; base: bigint; prefix: number };

const BITS: Record<Family, number> = { 4: 32, 6: 128 };
const MAPPED_HIGH = 0xffffn; // ::ffff:0:0/96, shifted right by 32

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // No leading zeros: "010" reads as octal in some tools and as ten in others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string, last: boolean): bigint[] | null => {
    if (half === "") return [];
    const out: bigint[] = [];
    const pieces = half.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes(".")) {
        // An embedded IPv4 address may only end the address.
        if (!last || i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        out.push(v4 >> 16n, v4 & 0xffffn);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
        out.push(BigInt(parseInt(piece, 16)));
      }
    }
    return out;
  };
  const compressed = halves.length === 2;
  const head = groupsOf(halves[0], !compressed);
  const tail = compressed ? groupsOf(halves[1], true) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<bigint>(compressed ? missing : 0).fill(0n), ...tail];
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

/**
 * An address as written by a person or a proxy: IPv4, IPv6 (brackets allowed), an IPv4 address
 * with a port (`192.0.2.1:8080`, which some proxies append) or a bracketed IPv6 one with a port. An
 * IPv4-mapped IPv6 address reads as its IPv4 address. Null for anything else, zone ids included.
 */
export function parseIpAddress(input: string): Address | null {
  let text = input.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  if (!text) return null;
  if (!text.includes(":")) {
    const v4 = parseIpv4(text);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  const v6 = parseIpv6(text);
  if (v6 === null) return null;
  if (v6 >> 32n === MAPPED_HIGH) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

const mask = (family: Family, prefix: number) => {
  const bits = BigInt(BITS[family]);
  const all = (1n << bits) - 1n;
  return prefix === 0 ? 0n : (all >> (bits - BigInt(prefix))) << (bits - BigInt(prefix));
};

/** Why an entry can't be read: not an address, or a prefix out of range for its family. */
export type NetworkProblem = "address" | "prefix";

/**
 * An address or CIDR range, with the host bits of a range cleared (`192.0.2.9/24` is
 * `192.0.2.0/24`). An IPv4-mapped IPv6 range of /96 or more reads as the IPv4 range it maps.
 */
export function parseNetwork(input: string): { ok: true; network: Network } | { ok: false; problem: NetworkProblem } {
  const text = input.trim();
  const slash = text.indexOf("/");
  const addressText = slash === -1 ? text : text.slice(0, slash);
  // Ports and brackets belong to visitors' addresses, not to the ranges people type.
  if (!/^[0-9a-f:.]+$/i.test(addressText)) return { ok: false, problem: "address" };
  const written: Family = addressText.includes(":") ? 6 : 4;
  const raw = written === 6 ? parseIpv6(addressText) : parseIpv4(addressText);
  if (raw === null) return { ok: false, problem: "address" };
  let prefix = BITS[written];
  if (slash !== -1) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return { ok: false, problem: "prefix" };
    prefix = Number(prefixText);
    if (prefix > BITS[written]) return { ok: false, problem: "prefix" };
  }
  if (written === 6 && raw >> 32n === MAPPED_HIGH && prefix >= 96) {
    // Written as IPv4-mapped IPv6: from /96 on, it is the IPv4 range it maps.
    const v4Prefix = prefix - 96;
    return { ok: true, network: { family: 4, base: (raw & 0xffffffffn) & mask(4, v4Prefix), prefix: v4Prefix } };
  }
  return { ok: true, network: { family: written, base: raw & mask(written, prefix), prefix } };
}

function formatIpv4(value: bigint) {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** RFC 5952: lowercase, leading zeros dropped, the longest run of two or more zero groups as `::`. */
function formatIpv6(value: bigint) {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** The canonical text of a network: no prefix for a single address. */
export function formatNetwork(network: Network) {
  const text = network.family === 4 ? formatIpv4(network.base) : formatIpv6(network.base);
  return network.prefix === BITS[network.family] ? text : `${text}/${network.prefix}`;
}

/** The canonical text of an address (`::ffff:192.0.2.1` reads `192.0.2.1`), or null when it isn't one. */
export function formatIpAddress(input: string | null | undefined): string | null {
  const address = input ? parseIpAddress(input) : null;
  if (!address) return null;
  return address.family === 4 ? formatIpv4(address.value) : formatIpv6(address.value);
}

function contains(network: Network, address: Address) {
  return network.family === address.family && (address.value & mask(network.family, network.prefix)) === network.base;
}

/**
 * Whether a visitor's address may open a workspace with these approved networks: always with an
 * empty list; never when the address is unknown or isn't one (a proxy's "unknown", say). Entries
 * that don't read as networks match nothing.
 */
export function ipAllowed(ip: string | null | undefined, networks: readonly Pick<AllowedNetwork, "range">[]): boolean {
  if (networks.length === 0) return true;
  const address = ip ? parseIpAddress(ip) : null;
  if (!address) return false;
  return networks.some((entry) => {
    const parsed = parseNetwork(entry.range);
    return parsed.ok && contains(parsed.network, address);
  });
}

export type AllowedNetworksProblem = NetworkProblem | "label" | "tooMany";

/**
 * The list an owner saves, checked and made canonical: each range read with parseNetwork (blank
 * rows dropped), labels trimmed, the same range listed twice kept once (with its first label), at
 * most MAX_ALLOWED_NETWORKS entries. `index` is the failing row of the input; `entry` its text.
 */
export function parseAllowedNetworks(
  input: unknown,
): { ok: true; networks: AllowedNetwork[] } | { ok: false; problem: AllowedNetworksProblem; index: number; entry: string } {
  if (!Array.isArray(input)) return { ok: false, problem: "address", index: 0, entry: "" };
  const networks: AllowedNetwork[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const item = input[index] as unknown;
    const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    if ((raw.range !== undefined && typeof raw.range !== "string") || (raw.label !== undefined && typeof raw.label !== "string")) {
      return { ok: false, problem: "address", index, entry: "" };
    }
    const rangeText = typeof raw.range === "string" ? raw.range.trim() : "";
    const label = typeof raw.label === "string" ? raw.label.trim().replace(/\s+/g, " ") : "";
    if (!rangeText && !label) continue;
    const parsed = parseNetwork(rangeText);
    if (!parsed.ok) return { ok: false, problem: parsed.problem, index, entry: rangeText };
    if (label.length > MAX_NETWORK_LABEL) return { ok: false, problem: "label", index, entry: rangeText };
    const range = formatNetwork(parsed.network);
    if (seen.has(range)) continue;
    seen.add(range);
    networks.push({ range, label });
    if (networks.length > MAX_ALLOWED_NETWORKS) return { ok: false, problem: "tooMany", index, entry: rangeText };
  }
  return { ok: true, networks };
}

/** A stored list as the server reads it back: anything that isn't an entry is left out. */
export function storedAllowedNetworks(value: unknown): AllowedNetwork[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { range, label } = item as Record<string, unknown>;
    return typeof range === "string" ? [{ range, label: typeof label === "string" ? label : "" }] : [];
  });
}
