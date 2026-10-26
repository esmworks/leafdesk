import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { MAX_CONNECTION_URL } from "@/lib/connections";
import { env } from "@/lib/env";
import { ALLOWED_PORTS, isBlockedAddress, onHostList } from "../ssrf";

/**
 * The fetch a connection's MCP client, and its sign-in to the service, go through. A connection's
 * server is reached only over https, on a public address, with the connection pinned to an address
 * checked when it is made (so a host can't answer a check with a public address and the connection
 * with a private one). Redirects are followed by hand, each checked the same way, at most five; one
 * to another origin drops the request's credentials (Authorization, Cookie).
 * Hosts in CONNECTOR_ALLOWED_HOSTS skip these checks, http included, for servers on the same
 * machine or network: a `host:port` entry on that port, a bare host on the web's usual ports only
 * (ssrf.ts onHostList). The list is for what owners set up: connections, their sign-in, syncs.
 *
 * `web` is for fetching a web page someone asked to save (server/web-clip.ts): http is allowed too,
 * on the usual web ports only (the ones link previews allow), with every other check the same.
 * `untrusted` is for an address anyone in a workspace gives (saving a web page, downloading a file
 * a page shows, checking its links): CONNECTOR_ALLOWED_HOSTS never applies to it, only
 * WEB_FETCH_ALLOWED_HOSTS, which an administrator sets for exactly that.
 */

/** What a fetch may reach beyond a connection's https servers. */
export type FetchReach = { web?: boolean; untrusted?: boolean };

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

/** Whether `url` is on CONNECTOR_ALLOWED_HOSTS (see onHostList for how entries match). */
export function allowedConnectorHost(url: URL, allowed = env.connectorAllowedHosts) {
  return onHostList(url, allowed);
}

/** The hosts a fetch of `reach` may reach on a private network or over plain http. */
const allowedHostsFor = ({ untrusted = false }: FetchReach) => (untrusted ? env.webFetchAllowedHosts : env.connectorAllowedHosts);

/**
 * Checks the shape of an address a connection reaches (no DNS: that is checked on connecting):
 * https, no credentials, and no private address or local name, unless the host is allowed (above).
 */
export function checkConnectionUrl(value: string | URL, reach: FetchReach = {}): URL {
  const { web = false } = reach;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionFetchError("invalidUrl", "Not a valid address");
  }
  if (url.href.length > MAX_CONNECTION_URL) throw new ConnectionFetchError("invalidUrl", "The address is too long");
  if (url.username || url.password) throw new ConnectionFetchError("invalidUrl", "Credentials in the address");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectionFetchError("invalidUrl", "Only https addresses");
  if (allowedConnectorHost(url, allowedHostsFor(reach))) return url;
  if (url.protocol !== "https:" && !web) throw new ConnectionFetchError("invalidUrl", "Only https addresses");
  if (web && !ALLOWED_PORTS.has(url.port)) throw new ConnectionFetchError("blocked", `Port ${url.port} is not allowed`);
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

/** Fetch for connections (see above): same arguments as fetch, and what else it may reach. */
export async function connectionFetch(input: string | URL | Request, init: RequestInit = {}, reach: FetchReach = {}): Promise<Response> {
  let request = new Request(input, init);
  for (let hop = 0; ; hop++) {
    const url = checkConnectionUrl(request.url, reach);
    const dispatcher = allowedConnectorHost(url, allowedHostsFor(reach)) ? agents().plain : agents().guarded;
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

/** Bytes a connection's server may send in one answer (a tool's result, its list of tools...). */
export const MAX_CONNECTION_RESPONSE_BYTES = 20 * 1024 * 1024;

/** An answer over MAX_CONNECTION_RESPONSE_BYTES (see capResponse). */
export class AnswerTooLargeError extends Error {
  constructor() {
    super("The server's answer is too large");
    this.name = "AnswerTooLargeError";
  }
}

/** Statuses whose answer has no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * `response` with a body that fails once more than `maxBytes` have come (or at once, when the
 * server says it sends more), so a server that answers without end can't fill this server's memory.
 */
export function capResponse(response: Response, maxBytes = MAX_CONNECTION_RESPONSE_BYTES): Response {
  if (!response.body || NULL_BODY.has(response.status)) return response;
  const tooLarge = () => new AnswerTooLargeError();
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (declared > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  let seen = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
