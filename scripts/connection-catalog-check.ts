/**
 * Checks every entry of the connection catalog (src/lib/connection-catalog.ts) against the live
 * service, without credentials, the way Leafdesk meets it when someone adds the connection:
 *
 *   - `none`: an `initialize` request is answered with a serverInfo.
 *   - `oauth`: it is answered with 401; the protected-resource metadata (named by the
 *     WWW-Authenticate header, else under /.well-known/oauth-protected-resource for the path, then
 *     the origin) names a `resource` that is the entry's address or a parent of it; and the first
 *     authorization server's metadata (oauth-authorization-server or openid-configuration, for its
 *     path, then its origin) has a `registration_endpoint`, so Leafdesk can register itself. A
 *     server with no such metadata is taken as its own authorization server, as the MCP client does.
 *   - `token`: it is answered with 401 or 403.
 *
 *   pnpm catalog:check             every entry
 *   pnpm catalog:check linear sentry   only these (by id)
 *
 * Needs the network, so it isn't part of the tests or CI: run it before a release, since vendors
 * move their MCP addresses. Entries are checked in parallel, each within 15 seconds. Exits with 1
 * when an entry fails.
 */
import { CONNECTION_CATALOG, type CatalogEntry } from "../src/lib/connection-catalog";

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 24;

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "leafdesk-catalog-check", version: "1.0.0" },
  },
});

class CheckFailed extends Error {}
const fail = (message: string): never => {
  throw new CheckFailed(message);
};

const trimSlashes = (value: string) => value.replace(/\/+$/, "");

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    // A timeout ends the whole entry; anything else just means this address has no metadata.
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}

/** The result of an `initialize` request, as JSON or as the first event of an event stream. */
function parseRpc(contentType: string, text: string): { result?: { serverInfo?: unknown } } | undefined {
  const candidates = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as { result?: { serverInfo?: unknown } };
    } catch {
      // not JSON: try the next event
    }
  }
  return undefined;
}

/** `/.well-known/<name>` for a URL, with its path inserted after it when it has one. */
function wellKnown(base: URL, name: string, withPath: boolean) {
  const path = trimSlashes(base.pathname);
  return `${base.origin}/.well-known/${name}${withPath ? path : ""}`;
}

function resourceMetadataUrls(entryUrl: URL, wwwAuthenticate: string | null) {
  const urls: string[] = [];
  const named = wwwAuthenticate?.match(/resource_metadata\s*=\s*"?([^",\s]+)"?/i)?.[1];
  if (named) {
    try {
      urls.push(new URL(named, entryUrl).href);
    } catch {
      // not an address: the well-known ones below still apply
    }
  }
  urls.push(wellKnown(entryUrl, "oauth-protected-resource", true));
  urls.push(wellKnown(entryUrl, "oauth-protected-resource", false));
  return [...new Set(urls)];
}

function authServerMetadataUrls(issuer: URL) {
  const urls: string[] = [];
  for (const name of ["oauth-authorization-server", "openid-configuration"]) {
    if (trimSlashes(issuer.pathname)) urls.push(wellKnown(issuer, name, true));
    urls.push(wellKnown(issuer, name, false));
  }
  // OpenID Connect Discovery puts the document after the issuer rather than the host.
  if (trimSlashes(issuer.pathname)) urls.push(`${issuer.origin}${trimSlashes(issuer.pathname)}/.well-known/openid-configuration`);
  return [...new Set(urls)];
}

async function firstJson(urls: string[], signal: AbortSignal, accept: (body: Record<string, unknown>) => boolean) {
  for (const url of urls) {
    const body = await getJson(url, signal);
    if (body && accept(body)) return body;
  }
  return undefined;
}

async function checkOAuth(entry: CatalogEntry, entryUrl: URL, wwwAuthenticate: string | null, signal: AbortSignal) {
  const metadata = await firstJson(resourceMetadataUrls(entryUrl, wwwAuthenticate), signal, (body) => typeof body.resource === "string");

  // Like the MCP client: a server with no resource metadata, or none naming an authorization
  // server, is its own authorization server.
  let first = `${entryUrl.origin}/`;
  if (metadata) {
    const resource = metadata.resource as string;
    const a = trimSlashes(resource);
    const b = trimSlashes(entryUrl.href);
    if (a !== b && !b.startsWith(`${a}/`)) return fail(`resource ${resource} is not ${entry.url} or a parent of it`);
    const servers = metadata.authorization_servers;
    if (Array.isArray(servers) && servers.length) {
      if (typeof servers[0] !== "string") return fail("the first authorization server is not an address");
      first = servers[0];
    }
  }

  let issuer: URL;
  try {
    issuer = new URL(first);
  } catch {
    return fail(`authorization server ${first} is not an address`);
  }
  const server = await firstJson(authServerMetadataUrls(issuer), signal, () => true);
  if (!server) return fail(`no authorization server metadata for ${first}`);
  if (typeof server.registration_endpoint !== "string") return fail(`${first} has no registration_endpoint`);
}

async function check(entry: CatalogEntry) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const entryUrl = new URL(entry.url);
  const res = await fetch(entryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: INITIALIZE,
    signal,
  });

  if (entry.authType === "none") {
    if (!res.ok) return fail(`initialize answered ${res.status}`);
    const rpc = parseRpc(res.headers.get("content-type") ?? "", await res.text());
    if (!rpc?.result?.serverInfo) return fail("initialize answered without a serverInfo");
    return;
  }

  await res.body?.cancel();
  if (entry.authType === "token") {
    if (res.status !== 401 && res.status !== 403) return fail(`expected 401 or 403 without a token, got ${res.status}`);
    return;
  }
  if (res.status !== 401) return fail(`expected 401 without a sign-in, got ${res.status}`);
  await checkOAuth(entry, entryUrl, res.headers.get("www-authenticate"), signal);
}

function describe(error: unknown) {
  if (error instanceof CheckFailed) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return `no answer within ${TIMEOUT_MS / 1000} s`;
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const unknown = only.filter((id) => !CONNECTION_CATALOG.some((entry) => entry.id === id));
if (unknown.length) {
  console.error(`Not an id in src/lib/connection-catalog.ts: ${unknown.join(", ")}`);
  process.exit(1);
}
const entries = only.length ? CONNECTION_CATALOG.filter((entry) => only.includes(entry.id)) : CONNECTION_CATALOG;

const failures: { entry: CatalogEntry; reason: string }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      try {
        await check(entry);
      } catch (error) {
        failures.push({ entry, reason: describe(error) });
      }
    }
  }),
);

if (failures.length === 0) {
  console.log(`All ${entries.length} catalog entries check out.`);
} else {
  const order = new Map(CONNECTION_CATALOG.map((entry, index) => [entry.id, index]));
  failures.sort((a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0));
  const rows = failures.map(({ entry, reason }) => [entry.id, entry.authType, entry.url, reason]);
  const header = ["id", "auth", "url", "problem"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  console.log([line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n"));
  console.log(`\n${failures.length} of ${entries.length} catalog entries fail.`);
  process.exitCode = 1;
}
