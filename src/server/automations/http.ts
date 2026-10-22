import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { MAX_HTTP_RESPONSE_BYTES, MAX_WEBHOOK_URL, type HttpMethod } from "@/lib/automations";
import { LinkPreviewError, type PreviewGuard } from "../link-preview";
import { allowedHost, webhookTarget } from "./webhook";

/**
 * An automation's HTTP request step: one request to an address the step's text resolved to,
 * guarded like webhooks (server/automations/webhook.ts) and more strictly: HTTPS only, except to a
 * host in AUTOMATION_WEBHOOK_ALLOWED_HOSTS (a service on the server's own network, where plain
 * HTTP is allowed too), no credentials in the address, the usual web ports, every address of the
 * host public and the connection pinned to the checked one. Redirects aren't followed. At most
 * MAX_HTTP_RESPONSE_BYTES of the answer are read; a JSON answer is parsed when it all fits.
 */

export const HTTP_TIMEOUT_MS = 15_000;
const USER_AGENT = "Leafdesk-Automation/1.0";
/** Headers a step can't set: the request's framing is the server's. */
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "expect", "te", "trailer"]);

export type HttpResponseOutput = {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON, or the text of the answer. */
  body: unknown;
  /** The answer was longer than MAX_HTTP_RESPONSE_BYTES: `body` is its start, as text. */
  truncated?: boolean;
};

export class HttpStepError extends Error {
  constructor(
    readonly code: "invalidUrl" | "blocked" | "unreachable" | "timeout" | "redirect" | "http" | "invalidHeader",
    message: string,
    readonly httpStatus: number | null = null,
    readonly response: HttpResponseOutput | null = null,
  ) {
    super(message);
  }
}

/** Parses and checks a request's address (after its templates are written in). */
export function parseRequestUrl(value: string) {
  const text = value.trim();
  if (!text) throw new HttpStepError("invalidUrl", "The address is empty");
  if (text.length > MAX_WEBHOOK_URL) throw new HttpStepError("invalidUrl", `The address is longer than ${MAX_WEBHOOK_URL} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpStepError("invalidUrl", `"${text.slice(0, 200)}" is not a valid address`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowedHost(url))) {
    throw new HttpStepError("invalidUrl", "Only https addresses (plain http only to hosts the server's administrator allows)");
  }
  if (url.username || url.password) throw new HttpStepError("invalidUrl", "Credentials in the address: send them in a header");
  return url;
}

/** Checks a header a step sets; throws for one it can't. */
export function checkHeader(name: string, value: string) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new HttpStepError("invalidHeader", `"${name}" is not a valid header name`);
  if (RESERVED_HEADERS.has(name.toLowerCase())) throw new HttpStepError("invalidHeader", `The "${name}" header is set by the server`);
  if (/[\r\n\0]/.test(value)) throw new HttpStepError("invalidHeader", `The "${name}" header's value has a line break`);
}

function readAnswer(contentType: string, bytes: Buffer, truncated: boolean): unknown {
  const text = bytes.toString("utf8");
  if (!truncated && /\bjson\b/i.test(contentType) && text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export type HttpRequest = { method: HttpMethod; url: string; headers: { name: string; value: string }[]; body?: unknown };

/** Sends the request; resolves with the answer when it is 2xx, throws an HttpStepError otherwise. */
export async function sendRequest(request: HttpRequest, guard: Partial<PreviewGuard> = {}): Promise<HttpResponseOutput> {
  const url = parseRequestUrl(request.url);
  let address: LookupAddress | null;
  try {
    address = await webhookTarget(url, guard);
  } catch (error) {
    if (error instanceof LinkPreviewError) {
      const code = error.code === "blocked" ? "blocked" : error.code === "invalidUrl" ? "invalidUrl" : "unreachable";
      throw new HttpStepError(code, code === "blocked" ? `Requests can't go to private or local addresses (${error.message})` : error.message);
    }
    throw error;
  }
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json, */*;q=0.5" };
  for (const { name, value } of request.headers) {
    checkHeader(name, value);
    headers[name.toLowerCase()] = value;
  }
  const sendsBody = request.body !== undefined && request.body !== null && request.method !== "GET" && request.method !== "DELETE";
  const payload = sendsBody ? JSON.stringify(request.body) : null;
  if (payload !== null) {
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  const pinned: LookupFunction | undefined = address
    ? (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [address]);
        else callback(null, address.address, address.family);
      }
    : undefined;
  const client = url.protocol === "https:" ? https : http;
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const answer = await new Promise<HttpResponseOutput>((resolve, reject) => {
    const req = client.request(url, { method: request.method, ...(pinned ? { lookup: pinned } : {}), agent: false, signal, headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = MAX_HTTP_RESPONSE_BYTES - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = MAX_HTTP_RESPONSE_BYTES;
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        const bytes = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: out,
          body: readAnswer(String(res.headers["content-type"] ?? ""), bytes, truncated),
          ...(truncated ? { truncated: true } : {}),
        });
      };
      res.on("end", finish);
      res.on("error", (error) => (done ? undefined : reject(new HttpStepError("unreachable", error.message))));
    });
    req.on("error", (error) =>
      reject(
        signal.aborted || (error as { name?: string }).name === "AbortError"
          ? new HttpStepError("timeout", `No answer within ${HTTP_TIMEOUT_MS / 1000} seconds`)
          : new HttpStepError("unreachable", error.message),
      ),
    );
    req.end(payload ?? undefined);
  });
  if (answer.status >= 300 && answer.status < 400) throw new HttpStepError("redirect", `Answered with a redirect (${answer.status})`, answer.status, answer);
  if (answer.status < 200 || answer.status >= 300) throw new HttpStepError("http", `Answered ${answer.status}`, answer.status, answer);
  return answer;
}
