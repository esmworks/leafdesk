import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isBlockedAddress as isBlockedIp } from "@/server/ssrf";

/**
 * Fetches a file from a URL someone gave us (MCP's attach_file) without letting that URL reach
 * inside our network (SSRF): only http(s), and only hosts whose every address is public. The check
 * runs inside the connection's own DNS lookup, so the address that was checked is the one connected
 * to (no DNS rebinding between check and connect), and again on every redirect. A size limit and a
 * deadline bound the whole transfer.
 */

export class RemoteFetchError extends Error {
  constructor(
    message: string,
    readonly code: "badUrl" | "blocked" | "tooLarge" | "timeout" | "httpError" | "tooManyRedirects" | "network",
  ) {
    super(message);
    this.name = "RemoteFetchError";
  }
}

/**
 * True for loopback, private, link-local and other addresses a fetch must never reach: the same
 * rules as link previews (server/ssrf.ts), with a bracketed IPv6 literal ("[::1]") read as its address.
 */
export function isBlockedAddress(address: string): boolean {
  return isBlockedIp(address.replace(/^\[|\]$/g, ""));
}

/**
 * Reads a fetched file's body as text, at most `maxBytes` of it: a server that sends no
 * Content-Length (or a wrong one) is cut off there instead of filling memory.
 */
export async function readRemoteText(file: RemoteFile, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of file.body) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new RemoteFetchError("The file is too large", "tooLarge");
      chunks.push(chunk as Buffer);
    }
  } finally {
    file.body.destroy();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type RemoteFetchOptions = {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Ports the URL (and every redirect) may name ("" for the scheme's own); unset: any. */
  ports?: ReadonlySet<string>;
  userAgent?: string;
  accept?: string;
  /** Tests only: which addresses count as off limits. */
  isBlocked?: (address: string) => boolean;
};

export type RemoteFile = {
  /** The URL the file came from, after redirects. */
  url: string;
  /** The response body; read it to the end or destroy it. Destroyed on the deadline. */
  body: IncomingMessage;
  contentType: string | null;
  /** From Content-Disposition, else the last part of the final URL's path. */
  name: string | null;
  /** Content-Length, when the server sent one. */
  size: number | null;
};

/** A DNS lookup that refuses hosts with any blocked address, for http.request's `lookup`. */
function guardedLookup(isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, found) => {
      if (error) return callback(error, "", 0);
      const addresses = found as unknown as LookupAddress[];
      if (!addresses.length || addresses.some((a) => isBlocked(a.address))) {
        const blocked = Object.assign(new Error(`${hostname} resolves to an address that isn't public`), { code: "EBLOCKED" });
        return callback(blocked, "", 0);
      }
      if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function nameFrom(disposition: string | undefined, url: URL): string | null {
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {}
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
    if (plain) return plain[1].trim();
  }
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Fetches `input` (GET), following up to `maxRedirects` redirects, each checked like the first. */
export async function fetchRemoteFile(input: string, options: RemoteFetchOptions): Promise<RemoteFile> {
  const { maxBytes, timeoutMs = 30_000, maxRedirects = 5, ports, isBlocked = isBlockedAddress } = options;
  const headers = { "user-agent": options.userAgent ?? "Leafdesk (+file attachment)", accept: options.accept ?? "*/*" };
  const deadline = Date.now() + timeoutMs;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RemoteFetchError("That isn't a valid URL", "badUrl");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new RemoteFetchError("Only http and https URLs can be fetched", "badUrl");
    if (url.username || url.password) throw new RemoteFetchError("URLs with credentials can't be fetched", "badUrl");
    if (ports && !ports.has(url.port)) throw new RemoteFetchError(`Port ${url.port} isn't one of the web's usual ports`, "blocked");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Literal addresses skip DNS, so the lookup guard never sees them.
    if (isIP(host) && isBlocked(host)) throw new RemoteFetchError("That address isn't public", "blocked");
    const res = await get(url, { isBlocked, deadline, headers });
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new RemoteFetchError("Too many redirects", "tooManyRedirects");
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new RemoteFetchError(`The server answered ${status}`, "httpError");
    }
    const length = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
    if (length !== null && length > maxBytes) {
      res.destroy();
      throw new RemoteFetchError("The file is too large", "tooLarge");
    }
    // The deadline covers reading the body too.
    const timer = setTimeout(() => res.destroy(new RemoteFetchError("The download took too long", "timeout")), Math.max(0, deadline - Date.now()));
    res.once("close", () => clearTimeout(timer));
    return {
      url: url.href,
      body: res,
      contentType: res.headers["content-type"] ?? null,
      name: nameFrom(res.headers["content-disposition"], url),
      size: length,
    };
  }
}

function get(
  url: URL,
  { isBlocked, deadline, headers }: { isBlocked: (address: string) => boolean; deadline: number; headers: { "user-agent": string; accept: string } },
): Promise<IncomingMessage> {
  return new Promise((resolveGet, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      method: "GET",
      lookup: guardedLookup(isBlocked),
      headers: { ...headers, "accept-encoding": "identity" },
      // A fresh connection per request: pooled sockets would skip the lookup.
      agent: false,
    };
    const req = send(url, options, resolveGet);
    const timer = setTimeout(() => req.destroy(new RemoteFetchError("The download took too long", "timeout")), Math.max(0, deadline - Date.now()));
    req.once("response", () => clearTimeout(timer));
    req.once("error", (error: Error & { code?: string }) => {
      clearTimeout(timer);
      if (error instanceof RemoteFetchError) reject(error);
      else if (error.code === "EBLOCKED") reject(new RemoteFetchError(error.message, "blocked"));
      else reject(new RemoteFetchError(`Couldn't reach ${url.host}`, "network"));
    });
    req.end();
  });
}
