import type { LookupAddress } from "node:dns";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { AwsClient, AwsV4Signer } from "aws4fetch";
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";
import { guardedLookup } from "../connections/fetch";
import { isBlockedAddress } from "../ssrf";
import { assertKey, keyOf, StorageError, type StorageDriver } from "./driver";

export type S3Config = {
  bucket: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com or http://minio:9000; AWS when missing. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `<endpoint>/<bucket>/<key>` instead of `<bucket>.<endpoint>/<key>`; MinIO needs it. */
  forcePathStyle: boolean;
  /** Put keys under this folder of the bucket (no slashes at either end). */
  prefix?: string;
  /**
   * For an endpoint someone typed (a workspace's own storage) rather than the instance's: reach it
   * only over https, on public addresses (see S3Guard).
   */
  guard?: S3Guard;
};

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

/**
 * The rules for a typed endpoint, as for connections (server/connections/fetch.ts): https only, no
 * private address or local name, the connection pinned to the address checked as it is made (so a
 * host can't pass the check with a public address and connect to a private one), and no redirects.
 * Hosts in `allowedHosts` (STORAGE_ALLOWED_HOSTS: name, or name:port) skip these checks, http
 * included, for storage on the same machine or network.
 */
export type S3Guard = { allowedHosts: string[]; resolve?: Resolve };

/** Whether `url` is on the guard's allowed hosts (by host name, or host and port). */
function allowedHost(url: URL, allowed: string[]) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.includes(host) || allowed.includes(`${host}:${port}`);
}

/**
 * Checks an address a guarded driver is about to reach (the DNS answer is checked on connecting);
 * returns whether the host is an allowed one. Throws a StorageError otherwise.
 */
export function checkStorageUrl(url: URL, guard: S3Guard): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new StorageError("Only https endpoints");
  if (url.username || url.password) throw new StorageError("Credentials in the endpoint");
  if (allowedHost(url, guard.allowedHosts)) return true;
  if (url.protocol !== "https:") throw new StorageError("Only https endpoints");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new StorageError(`${host} is a private address`);
  } else if (!host.includes(".") || /^localhost\.?$/i.test(host) || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(host)) {
    throw new StorageError(`${host} is a local host name`);
  }
  return false;
}

/** Undici dispatchers for guarded drivers, by resolver (one for the system's). */
const guardedAgents = new WeakMap<Resolve | typeof guardedLookup, Agent>();
function guardedAgent(resolve?: Resolve): Agent {
  const key = resolve ?? guardedLookup;
  let agent = guardedAgents.get(key);
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(resolve) as never }, connections: 16 });
    guardedAgents.set(key, agent);
  }
  return agent;
}

const RETRIES = 2;

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …), signed with AWS
 * Signature V4 by aws4fetch. Uploads stream with a known length and an unsigned payload hash, so
 * large files are never held in memory.
 */
export function s3Driver(config: S3Config): StorageDriver {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });
  const prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, "")}/` : "";

  const urlOf = (key: string) => {
    assertKey(key);
    const objectKey = prefix + key;
    if (!config.endpoint) {
      return config.forcePathStyle
        ? `https://s3.${config.region}.amazonaws.com/${config.bucket}/${objectKey}`
        : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${objectKey}`;
    }
    const endpoint = new URL(config.endpoint);
    const base = endpoint.origin + endpoint.pathname.replace(/\/+$/, "");
    return config.forcePathStyle
      ? `${base}/${config.bucket}/${objectKey}`
      : `${endpoint.protocol}//${config.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}/${objectKey}`;
  };

  /** The dispatcher for `url`: the guarded one, unless the guard is off or allows the host. */
  const dispatcherFor = (url: URL): Dispatcher | undefined => {
    if (!config.guard) return undefined;
    return checkStorageUrl(url, config.guard) ? undefined : guardedAgent(config.guard.resolve);
  };

  /** A signed request, tried again on a server error or "slow down"; never follows a redirect. */
  const send = async (url: string, init: { method: string; headers?: Record<string, string> }): Promise<Response> => {
    const dispatcher = dispatcherFor(new URL(url));
    for (let attempt = 0; ; attempt++) {
      const signed = await client.sign(url, init);
      let res: Response;
      try {
        res = (await undiciFetch(signed.url, {
          method: signed.method,
          headers: signed.headers,
          redirect: "manual",
          ...(dispatcher ? { dispatcher } : {}),
        } as UndiciRequestInit)) as unknown as Response;
      } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        throw new StorageError(`S3 ${init.method} failed: ${cause?.message ?? (error as Error).message}`, null, { cause: error });
      }
      if ((res.status < 500 && res.status !== 429) || attempt >= RETRIES) return res;
      await res.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 50 * 2 ** attempt));
    }
  };

  const failure = async (what: string, res: Response) =>
    new StorageError(`S3 ${what} failed: ${res.status} ${describeError(await snippet(res, 2000))}`, res.status);

  return {
    kind: "s3",

    async put(key, body, { size, contentType }) {
      const url = urlOf(key);
      const parsed = new URL(url);
      const guarded = config.guard ? !checkStorageUrl(parsed, config.guard) : false;
      const signer = new AwsV4Signer({
        url,
        method: "PUT",
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: "s3",
        region: config.region,
      });
      const signed = await signer.sign();
      // A fresh connection through the guarded lookup: never a pooled one made without the check.
      await sendStream(signed.url, signed.headers, body, guarded ? { agent: false, lookup: guardedLookup(config.guard!.resolve) as never } : {});
    },

    async get(ref, range) {
      const res = await send(urlOf(keyOf(ref)), {
        method: "GET",
        headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
      });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw await failure("GET", res);
      return res.body;
    },

    async delete(ref) {
      const res = await send(urlOf(keyOf(ref)), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw await failure("DELETE", res);
      await res.body?.cancel();
    },
  };
}

/** An S3 error answer as text: its code and message, when it is the usual XML. */
export function describeError(body: string): string {
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]{1,300})<\/Message>/.exec(body)?.[1];
  if (code) return message ? `${code}: ${message}` : code;
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The start of an error answer, without reading more of it than that. */
async function snippet(res: Response, limit = 300): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch {
    // What arrived is enough.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, limit);
}

/**
 * PUTs a stream with the signed headers. Node's http client, not fetch: S3 wants a Content-Length
 * on uploads (it refuses chunked bodies), which fetch won't set for a stream.
 */
function sendStream(url: URL, headers: Headers, body: Readable, options: Pick<RequestOptions, "agent" | "lookup">): Promise<void> {
  return new Promise((resolvePut, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: "PUT", headers: Object.fromEntries(headers.entries()), ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        if (Buffer.concat(chunks).length < 2000) chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolvePut();
        else {
          const status = res.statusCode ?? 0;
          reject(new StorageError(`S3 PUT failed: ${status} ${describeError(Buffer.concat(chunks).toString("utf8").slice(0, 2000))}`, status));
        }
      });
      res.on("error", reject);
    });
    // The body's own failure (a file that couldn't be read) is no fault of the storage's.
    let bodyError: Error | null = null;
    req.setTimeout(5 * 60 * 1000, () => req.destroy(new StorageError("S3 PUT timed out")));
    req.on("error", (error) => {
      if (bodyError || error instanceof StorageError) reject(bodyError ?? error);
      else reject(new StorageError(`S3 PUT failed: ${error.message}`, null, { cause: error }));
    });
    body.on("error", (error) => {
      bodyError = error;
      req.destroy(error);
    });
    body.pipe(req);
  });
}
