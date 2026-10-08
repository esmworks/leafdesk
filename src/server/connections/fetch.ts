import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { MAX_CONNECTION_URL } from "@/lib/connections";
import { env } from "@/lib/env";
import { isBlockedAddress } from "../ssrf";

/**
 * The fetch a connection's MCP client, and its sign-in to the service, go through. A connection's
 * server is reached only over https, on a public address, with the connection pinned to an address
 * checked when it is made (so a host can't answer a check with a public address and the connection
 * with a private one). Redirects are followed by hand, each checked the same way, at most five; one
 * to another origin drops the request's credentials (Authorization, Cookie).
 * Hosts in CONNECTOR_ALLOWED_HOSTS (by name, or name and port) skip these checks, http included,
 * for servers on the same machine or network.
 */

export class ConnectionFetchError extends Error {
  constructor(
    readonly code: "invalidUrl" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 5;

/** Headers that carry credentials, left out when a redirect leads to another origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** Whether `url` is on CONNECTOR_ALLOWED_HOSTS (by host name, or host and port). */
export function allowedConnectorHost(url: URL, allowed = env.connectorAllowedHosts) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.includes(host) || allowed.includes(`${host}:${port}`);
}

/**
 * Checks the shape of an address a connection reaches (no DNS: that is checked on connecting):
 * https, no credentials, and no private address or local name, unless the host is allowed.
 */
export function checkConnectionUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionFetchError("invalidUrl", "Not a valid address");
  }
  if (url.href.length > MAX_CONNECTION_URL) throw new ConnectionFetchError("invalidUrl", "The address is too long");
  if (url.username || url.password) throw new ConnectionFetchError("invalidUrl", "Credentials in the address");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectionFetchError("invalidUrl", "Only https addresses");
  if (allowedConnectorHost(url)) return url;
  if (url.protocol !== "https:") throw new ConnectionFetchError("invalidUrl", "Only https addresses");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new ConnectionFetchError("blocked", "A private address");
  } else if (!host.includes(".") || /^localhost\.?$/i.test(host) || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(host)) {
    throw new ConnectionFetchError("blocked", "A local host name");
  }
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));

/** A DNS lookup that refuses a host with any private address, for the guarded connections. */
export function guardedLookup(resolve: Resolve = systemResolve) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    resolve(hostname)
      .then((addresses) => {
        if (!addresses.length) throw Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" });
        if (addresses.some((a) => isBlockedAddress(a.address))) {
          throw Object.assign(new Error(`${hostname} has a private address`), { code: "EBLOCKED" });
        }
        if (typeof options === "object" && options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };
}

const g = globalThis as typeof globalThis & { __leafdeskConnectorAgents?: { guarded: Agent; plain: Agent } };
function agents() {
  return (g.__leafdeskConnectorAgents ??= {
    guarded: new Agent({ connect: { lookup: guardedLookup() as never }, connections: 16 }),
    plain: new Agent({ connections: 16 }),
  });
}

/** Fetch for connections (see above): same arguments as fetch. */
export async function connectionFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let request = new Request(input, init);
  for (let hop = 0; ; hop++) {
    const url = checkConnectionUrl(request.url);
    const dispatcher = allowedConnectorHost(url) ? agents().plain : agents().guarded;
    const response = (await undiciFetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: "manual",
      dispatcher,
      ...(request.body ? { duplex: "half" } : {}),
    } as UndiciRequestInit)) as unknown as Response;
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= MAX_REDIRECTS) throw new ConnectionFetchError("blocked", "Too many redirects");
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    const keepBody = response.status === 307 || response.status === 308;
    if (keepBody && request.body) throw new ConnectionFetchError("blocked", "A redirect of a request with a body");
    // A connection's credentials are for its own server: a redirect elsewhere goes without them.
    const headers = new Headers(request.headers);
    if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    request = new Request(next, { method: keepBody ? request.method : "GET", headers, signal: request.signal });
  }
}
