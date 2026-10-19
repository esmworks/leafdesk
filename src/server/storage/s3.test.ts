import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "./driver";
import { driverFromEnv } from "./index";
import { checkStorageUrl, describeError, s3Driver } from "./s3";

/**
 * A stand-in for an S3 endpoint: keeps objects in memory and records what the driver sent. It
 * doesn't check signatures (that is aws4fetch's job); it checks the requests have one, and the
 * addressing, lengths and ranges.
 */
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };

let server: Server;
let endpoint: string;
const objects = new Map<string, Buffer>();
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const key = req.url!;
      if (!String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256 ") || key.startsWith("/denied/")) {
        res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
        return;
      }
      if (key.startsWith("/uploads/moved/")) {
        res.writeHead(301, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/uploads/elsewhere` }).end();
        return;
      }
      if (req.method === "PUT") {
        if (req.headers["transfer-encoding"] === "chunked") {
          res.writeHead(501).end("chunked uploads not supported");
          return;
        }
        objects.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
        if (range) res.writeHead(206).end(object.subarray(Number(range[1]), Number(range[2]) + 1));
        else res.writeHead(200).end(object);
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  objects.clear();
  seen.length = 0;
});

const text = (stream: ReadableStream<Uint8Array> | null) => (stream ? new Response(stream).text() : null);

describe("s3Driver", () => {
  const driver = () =>
    s3Driver({ bucket: "uploads", endpoint, region: "us-east-1", accessKeyId: "key", secretAccessKey: "secret", forcePathStyle: true, prefix: "leafdesk/" });

  it("uploads a stream with its length, signed, by path under the prefix", async () => {
    await driver().put("ws-1/abc", Readable.from([Buffer.from("hello "), Buffer.from("world")]), { size: 11, contentType: "text/plain" });
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.url).toBe("/uploads/leafdesk/ws-1/abc");
    expect(put.headers["content-length"]).toBe("11");
    expect(put.headers["content-type"]).toBe("text/plain");
    expect(put.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(put.body.toString()).toBe("hello world");
  });

  it("reads objects and byte ranges back, and null for missing ones", async () => {
    const d = driver();
    await d.put("ws-1/abc", Readable.from([Buffer.from("0123456789")]), { size: 10, contentType: "text/plain" });
    expect(await text(await d.get("ws-1/abc"))).toBe("0123456789");
    expect(await text(await d.get("ws-1/abc", { start: 3, end: 6 }))).toBe("3456");
    expect(seen.at(-1)!.headers.range).toBe("bytes=3-6");
    expect(await d.get("ws-1/missing")).toBeNull();
  });

  it("deletes objects, missing ones included", async () => {
    const d = driver();
    await d.put("ws-1/abc", Readable.from([Buffer.from("x")]), { size: 1, contentType: "text/plain" });
    await d.delete("ws-1/abc");
    await d.delete("ws-1/abc");
    expect(objects.size).toBe(0);
  });

  it("reports a refused upload, and refuses bad keys before sending", async () => {
    const denied = s3Driver({ bucket: "denied", endpoint, region: "us-east-1", accessKeyId: "key", secretAccessKey: "secret", forcePathStyle: true });
    await expect(denied.put("ws-1/abc", Readable.from([Buffer.from("x")]), { size: 1, contentType: "text/plain" })).rejects.toThrow(/403/);
    seen.length = 0;
    await expect(driver().put("../x", Readable.from([Buffer.from("x")]), { size: 1, contentType: "text/plain" })).rejects.toThrow(/Bad storage key/);
    expect(seen).toEqual([]);
  });
});

describe("s3Driver for an endpoint someone typed", () => {
  const guarded = (over: Partial<Parameters<typeof s3Driver>[0]> = {}, allowedHosts: string[] = []) =>
    s3Driver({
      bucket: "uploads",
      endpoint,
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
      guard: { allowedHosts },
      ...over,
    });
  const body = () => Readable.from([Buffer.from("x")]);

  it("refuses plain http, loopback and private addresses and local names before sending anything", async () => {
    for (const url of [endpoint, "https://127.0.0.1", "https://[::1]:9000", "https://10.1.2.3", "https://169.254.169.254", "https://minio", "https://minio.local", "https://s.localhost"]) {
      const d = guarded({ endpoint: url });
      await expect(d.get("ws-1/abc")).rejects.toBeInstanceOf(StorageError);
      await expect(d.put("ws-1/abc", body(), { size: 1, contentType: "text/plain" })).rejects.toBeInstanceOf(StorageError);
      await expect(d.delete("ws-1/abc")).rejects.toBeInstanceOf(StorageError);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a public name that resolves to a private address, when connecting", async () => {
    const resolve = async () => [{ address: "10.0.0.5", family: 4 }];
    const d = guarded({ endpoint: "https://storage.example.com", guard: { allowedHosts: [], resolve } });
    await expect(d.get("ws-1/abc")).rejects.toThrow(/private address/);
    await expect(d.put("ws-1/abc", body(), { size: 1, contentType: "text/plain" })).rejects.toThrow(/private address/);
    const mapped = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];
    const d6 = guarded({ endpoint: "https://storage.example.com", guard: { allowedHosts: [], resolve: mapped } });
    await expect(d6.delete("ws-1/abc")).rejects.toThrow(/private address/);
    expect(seen).toEqual([]);
  });

  it("reaches a host on the allowed list, plain http included", async () => {
    const host = new URL(endpoint).host;
    const d = guarded({}, [host]);
    await d.put("ws-1/abc", Readable.from([Buffer.from("0123456789")]), { size: 10, contentType: "text/plain" });
    expect(await text(await d.get("ws-1/abc", { start: 2, end: 4 }))).toBe("234");
    await d.delete("ws-1/abc");
    expect(objects.size).toBe(0);
  });

  it("doesn't follow redirects", async () => {
    const d = guarded({ bucket: "uploads" }, [new URL(endpoint).host]);
    await expect(d.get("moved/abc")).rejects.toThrow(/301/);
    expect(seen.map((s) => s.url)).toEqual(["/uploads/moved/abc"]);
  });

  it("says what the storage answered", async () => {
    const denied = guarded({ bucket: "denied" }, [new URL(endpoint).host]);
    const error = await denied.get("ws-1/abc").catch((e: StorageError) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).status).toBe(403);
    expect((error as StorageError).transient).toBe(false);
    expect((error as StorageError).message).toBe("S3 GET failed: 403 AccessDenied: Access Denied");
    await expect(denied.put("ws-1/abc", body(), { size: 1, contentType: "text/plain" })).rejects.toThrow("S3 PUT failed: 403 AccessDenied: Access Denied");
  });
});

describe("checkStorageUrl", () => {
  it("allows public https hosts, and the allowed ones however they are reached", () => {
    expect(checkStorageUrl(new URL("https://acc.r2.cloudflarestorage.com/b/k"), { allowedHosts: [] })).toBe(false);
    expect(checkStorageUrl(new URL("http://127.0.0.1:9000/b/k"), { allowedHosts: ["127.0.0.1:9000"] })).toBe(true);
    expect(checkStorageUrl(new URL("http://minio:9000/b/k"), { allowedHosts: ["minio"] })).toBe(true);
    expect(() => checkStorageUrl(new URL("http://127.0.0.1:9001/b/k"), { allowedHosts: ["127.0.0.1:9000"] })).toThrow(/https/);
    expect(() => checkStorageUrl(new URL("https://user:pw@storage.example.com/"), { allowedHosts: [] })).toThrow(/Credentials/);
  });
});

describe("describeError", () => {
  it("reads the code and message of an S3 error, or the start of anything else", () => {
    expect(describeError("<?xml?><Error><Code>NoSuchBucket</Code><Message>The bucket does not exist</Message></Error>")).toBe(
      "NoSuchBucket: The bucket does not exist",
    );
    expect(describeError("  Bad\n gateway ")).toBe("Bad gateway");
  });
});

describe("StorageError", () => {
  it("counts server errors and slow downs as passing", () => {
    expect(new StorageError("x", 503).transient).toBe(true);
    expect(new StorageError("x", 429).transient).toBe(true);
    expect(new StorageError("x", 403).transient).toBe(false);
    expect(new StorageError("x").transient).toBe(false);
  });
});

describe("driverFromEnv", () => {
  it("uses a local directory unless a bucket is set", () => {
    expect(driverFromEnv({}).kind).toBe("local");
    expect(driverFromEnv({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }).kind).toBe("s3");
  });

  it("names what an S3 setup is missing", () => {
    expect(() => driverFromEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => driverFromEnv({ STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
  });
});
