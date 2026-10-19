import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { env } from "@/lib/env";
import { guardedLookup } from "../connections/fetch";
import { isBlockedAddress } from "../ssrf";
import { AiError } from "./errors";

/**
 * The fetch a person's own AI account (server/ai-accounts.ts) reaches a typed base URL through,
 * with the rules a connection's or a workspace's storage endpoint has: https only, no credentials
 * in the address, no private address or local name, the connection pinned to an address checked as
 * it is made (so a host can't pass the check with a public address and connect to a private one),
 * and no redirects. Hosts in AI_ALLOWED_HOSTS (name, or name:port) skip these checks, http
 * included, for a model server on the same machine or network.
 */

/** Whether `url` is on AI_ALLOWED_HOSTS (by host name, or host and port). */
function allowedHost(url: URL, allowed = env.aiAllowedHosts) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.includes(host) || allowed.includes(`${host}:${port}`);
}

/**
 * Checks a base URL someone typed (no DNS: that is checked on connecting) and returns it without
 * trailing slashes; returns whether its host is an allowed one too. Throws AiError("invalid").
 */
export function checkAiUrl(value: string): { url: string; allowed: boolean } {
  const url = URL.parse(value.trim());
  if (!url) throw new AiError("invalid", "Not a valid address");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AiError("invalid", "Only https addresses");
  if (url.username || url.password) throw new AiError("invalid", "Credentials in the address");
  if (url.search || url.hash) throw new AiError("invalid", "An address without a query");
  const clean = url.href.replace(/\/+$/, "");
  if (allowedHost(url)) return { url: clean, allowed: true };
  if (url.protocol !== "https:") throw new AiError("invalid", "Only https addresses");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new AiError("invalid", `${host} is a private address`);
  } else if (!host.includes(".") || /^localhost\.?$/i.test(host) || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(host)) {
    throw new AiError("invalid", `${host} is a local host name`);
  }
  return { url: clean, allowed: false };
}

const g = globalThis as typeof globalThis & { __leafdeskAiAgent?: Agent };
const guardedAgent = () => (g.__leafdeskAiAgent ??= new Agent({ connect: { lookup: guardedLookup() as never }, connections: 16 }));

/** Fetch for own AI accounts (see above): same arguments as fetch. A redirect is an error. */
export const guardedAiFetch: typeof fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const { allowed } = checkAiUrl(request.url);
  const response = (await undiciFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: "manual",
    ...(allowed ? {} : { dispatcher: guardedAgent() }),
    ...(request.body ? { duplex: "half" } : {}),
  } as UndiciRequestInit)) as unknown as Response;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiError("provider", "The AI server answered with a redirect, which is not followed");
  }
  return response;
};
