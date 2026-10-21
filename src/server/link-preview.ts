import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { parseWebUrl } from "@/lib/web-blocks";
import { declaredCharset, headOf, parseLinkMeta, type LinkMeta } from "./link-meta";
import { ALLOWED_PORTS, isBlockedAddress } from "./ssrf";

/**
 * Fetches a web page for a bookmark's details, guarded against server-side request forgery: the
 * URL is typed by a user, and the server must not become their way into the internal network.
 *
 * - Only http and https, on the usual web ports, without credentials in the URL.
 * - The host name is resolved here and every address it resolves to must be public (server/ssrf);
 *   the connection then goes to the address that was checked (a custom `lookup`), so a DNS answer
 *   that changes between the check and the connection (rebinding) can't slip through.
 * - Redirects are followed by hand, at most three, and each hop is checked the same way.
 * - Five seconds in total, at most 1 MB read, and only up to the end of `<head>`.
 * - No cookies or credentials are sent, and nothing about the user.
 */

export const PREVIEW_TIMEOUT_MS = 5_000;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
export const PREVIEW_MAX_REDIRECTS = 3;

const USER_AGENT = "Mozilla/5.0 (compatible; LeafdeskBot/1.0; link preview)";

export class LinkPreviewError extends Error {
  constructor(
    readonly code: "invalidUrl" | "blocked" | "unreachable" | "timeout" | "tooManyRedirects" | "httpError",
    message: string,
  ) {
    super(message);
  }
}

export type LinkPreview = LinkMeta & { url: string };

type Lookup = (hostname: string) => Promise<LookupAddress[]>;

const systemLookup: Lookup = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));

/** What the guard allows. Only tests pass anything but the defaults (to reach a local server). */
export type PreviewGuard = { lookup: Lookup; isBlocked: (ip: string) => boolean; ports: ReadonlySet<string> };

const DEFAULT_GUARD: PreviewGuard = { lookup: systemLookup, isBlocked: isBlockedAddress, ports: ALLOWED_PORTS };

/** Checks a URL before connecting: scheme, port, credentials and every address of its host. */
export async function checkTarget(url: URL, guard: Partial<PreviewGuard> = {}): Promise<LookupAddress> {
  const { lookup, isBlocked, ports } = { ...DEFAULT_GUARD, ...guard };
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkPreviewError("invalidUrl", "Only http and https links");
  if (url.username || url.password) throw new LinkPreviewError("invalidUrl", "Credentials in the URL");
  if (!ports.has(url.port)) throw new LinkPreviewError("blocked", `Port ${url.port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlocked(host)) throw new LinkPreviewError("blocked", "Private address");
    return { address: host, family: isIP(host) };
  }
  if (!host.includes(".") || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(host) || /^localhost\.?$/i.test(host)) {
    throw new LinkPreviewError("blocked", "Local host name");
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new LinkPreviewError("unreachable", "The host name doesn't resolve");
  }
  if (!addresses.length) throw new LinkPreviewError("unreachable", "The host name doesn't resolve");
  // One private address is enough to refuse: which one a connection would use isn't ours to pick.
  if (addresses.some((a) => isBlocked(a.address))) throw new LinkPreviewError("blocked", "Private address");
  return addresses[0];
}

/** Charset of a response: the Content-Type header, else the page's own `<meta>`, else UTF-8. */
export function decodePage(bytes: Buffer, contentType: string): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  const label = fromHeader ?? declaredCharset(headOf(bytes.toString("latin1"))) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

type Response = { status: number; headers: IncomingMessage["headers"]; body: Buffer };

/** One request to the checked address, reading at most PREVIEW_MAX_BYTES and stopping after `</head>`. */
function request(url: URL, address: LookupAddress, signal: AbortSignal): Promise<Response> {
  // Every connection this request makes goes to the address checked above.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [address]);
    else callback(null, address.address, address.family);
  };
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: pinned,
        agent: false,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
          "accept-language": "en,*;q=0.5",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          req.destroy();
          return;
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (!type.includes("html")) {
          // Not a web page (an image, a PDF…): the URL is all there is to show.
          res.destroy();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let tail = "";
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).subarray(0, PREVIEW_MAX_BYTES) });
          res.destroy();
        };
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          // The head is all that's read; the body of a page can be as large as it likes. The end of
          // the previous chunk counts too, in case the tag is split between two.
          const text = tail + chunk.toString("latin1");
          tail = text.slice(-16);
          if (size >= PREVIEW_MAX_BYTES || /<\/head\s*>|<body[\s>]/i.test(text)) finish();
        });
        res.on("end", finish);
        res.on("error", (error) => (done ? undefined : reject(error)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** `promise`, or a timeout error once `signal` aborts (DNS lookups can't be cancelled themselves). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new LinkPreviewError("timeout", "Timed out"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The details of the page at `input`, following up to three redirects. Throws LinkPreviewError.
 * `guard` is for tests only; the app always uses the defaults.
 */
export async function fetchLinkPreview(input: string, guard: Partial<PreviewGuard> = {}): Promise<LinkPreview> {
  let url = parseWebUrl(input);
  if (!url) throw new LinkPreviewError("invalidUrl", "Not a web address");
  const original = url.href;
  const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const address = await untilAborted(checkTarget(url, guard), signal);
      const res = await request(url, address, signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= PREVIEW_MAX_REDIRECTS) throw new LinkPreviewError("tooManyRedirects", "Too many redirects");
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new LinkPreviewError("unreachable", "Bad redirect");
        }
        url = next;
        continue;
      }
      if (res.status >= 400) throw new LinkPreviewError("httpError", `HTTP ${res.status}`);
      const type = String(res.headers["content-type"] ?? "");
      const meta = res.body.length
        ? parseLinkMeta(decodePage(res.body, type), url.href)
        : { title: "", description: "", image: "", favicon: new URL("/favicon.ico", url).href, siteName: "" };
      // The bookmark keeps the address that was pasted; the details are the final page's.
      return { url: original, ...meta };
    }
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    if (signal.aborted) throw new LinkPreviewError("timeout", "Timed out");
    throw new LinkPreviewError("unreachable", error instanceof Error ? error.message : "Unreachable");
  }
}
